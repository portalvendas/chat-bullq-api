import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { PrismaService } from '../../database/prisma.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { phoneVariants } from '../../common/phone.util';

interface LeadgenChange {
  leadgenId: string;
  pageId: string;
  formId?: string;
  adId?: string;
  createdTime?: number;
}

/**
 * Integração NATIVA de Facebook Leads Ads.
 *
 * Fluxo: a Meta chama nosso webhook (`field: leadgen`) quando alguém submete
 * um formulário instantâneo → validamos a assinatura (X-Hub-Signature-256 com
 * o App Secret) → buscamos os dados do lead na Graph API com o token da página
 * → criamos/atualizamos o contato e um card na etapa de entrada do funil.
 *
 * A página é mapeada para a organização via tabela `lead_ads_pages`.
 */
@Injectable()
export class LeadAdsService {
  private readonly logger = new Logger(LeadAdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly pipelines: PipelinesService,
  ) {}

  private get apiVersion() {
    return this.config.get<string>('META_GRAPH_VERSION') || 'v21.0';
  }
  private get verifyToken() {
    return (
      this.config.get<string>('META_WA_VERIFY_TOKEN') ||
      this.config.get<string>('META_LEADADS_VERIFY_TOKEN') ||
      'chatbullq'
    );
  }

  /** Verificação do webhook (GET hub.challenge). */
  verify(mode?: string, token?: string, challenge?: string): string | null {
    if (mode === 'subscribe' && token === this.verifyToken) {
      return challenge ?? '';
    }
    return null;
  }

  /** Valida X-Hub-Signature-256 sobre o corpo cru com o App Secret. */
  validateSignature(rawBody: Buffer | undefined, signature?: string): boolean {
    const appSecret = this.config.get<string>('META_APP_SECRET');
    if (!appSecret || !signature || !rawBody) return false;
    const expected =
      'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  /** Extrai os eventos leadgen do payload do webhook. */
  extractLeadgenChanges(body: any): LeadgenChange[] {
    const out: LeadgenChange[] = [];
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field !== 'leadgen') continue;
        const v = change.value ?? {};
        if (v.leadgen_id && v.page_id) {
          out.push({
            leadgenId: String(v.leadgen_id),
            pageId: String(v.page_id),
            formId: v.form_id ? String(v.form_id) : undefined,
            adId: v.ad_id ? String(v.ad_id) : undefined,
            createdTime: v.created_time,
          });
        }
      }
    }
    return out;
  }

  /** Processa um lead: busca na Graph API e cria contato + card. Best-effort. */
  async processLead(change: LeadgenChange): Promise<void> {
    try {
      const page = await this.prisma.leadAdsPage.findUnique({
        where: { pageId: change.pageId },
      });
      if (!page || !page.active) {
        this.logger.warn(
          `Lead Ads: página ${change.pageId} não conectada — lead ignorado`,
        );
        return;
      }

      const { data } = await axios.get(
        `https://graph.facebook.com/${this.apiVersion}/${change.leadgenId}`,
        {
          params: {
            access_token: page.accessToken,
            fields: 'field_data,form_id,ad_id,campaign_name,created_time',
          },
          timeout: 20000,
        },
      );

      const { created } = await this.createLead(page, data, {
        leadgenId: change.leadgenId,
        formId: change.formId,
        adId: change.adId,
      });
      this.logger.log(
        `Lead Ads: lead ${change.leadgenId} → ${created ? 'card criado' : 'card existente'} (org ${page.organizationId})`,
      );
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.message ?? err?.message ?? 'erro';
      this.logger.warn(`Lead Ads: falha ao processar ${change.leadgenId}: ${msg}`);
    }
  }

  /**
   * Cria contato + card de entrada a partir dos dados de UM lead já buscados
   * na Graph API (field_data). Compartilhado pelo webhook (processLead) e pela
   * importação (importFormLeads) — assim a lógica de criação/roteamento é uma
   * só. Idempotente: createEntryCardForContact NÃO duplica card quando o
   * contato já tem um card aberto (retorna null).
   *
   * @returns { created } — true se um card novo foi criado; false se o contato
   *   já tinha card aberto (considerado "pulado" na importação).
   */
  private async createLead(
    page: { organizationId: string; pageId: string },
    lead: {
      field_data?: any[];
      form_id?: string;
      ad_id?: string;
      campaign_name?: string;
    },
    ids: { leadgenId: string; formId?: string; adId?: string },
  ): Promise<{ created: boolean }> {
    const fields = this.parseFieldData(lead?.field_data ?? []);
    const name = fields.name ?? null;
    const phone = this.normalizePhone(fields.phone);
    const email = fields.email ?? null;

    const contact = await this.findOrCreateContact(page.organizationId, {
      name,
      phone,
      email,
    });

    const card = await this.pipelines.createEntryCardForContact(
      page.organizationId,
      contact.id,
      name || phone || email || 'Lead do Facebook',
      {
        source: 'facebook_leadads',
        leadgenId: ids.leadgenId,
        formId: lead?.form_id ?? ids.formId,
        adId: lead?.ad_id ?? ids.adId,
        campaignName: lead?.campaign_name,
        fields: fields.raw,
      },
      // Roteamento por origem: tipo FACEBOOK_LEADADS + exceção por página.
      { leadSource: 'facebook_leadads', leadAdsPageId: page.pageId },
    );
    return { created: !!card };
  }

  /**
   * Importa (backfill) os leads JÁ existentes de um formulário instantâneo.
   *
   * O webhook só captura leads NOVOS (submetidos após a assinatura). Para
   * trazer os que já existem no formulário, lemos `GET /{form_id}/leads`
   * (paginado por cursor) com o PAGE token salvo e processamos cada lead pelo
   * mesmo caminho do webhook.
   *
   * Segurança/robustez: token vem do banco (nunca hardcoded); best-effort por
   * lead (um lead com erro não aborta os demais); idempotente (não duplica
   * card de contato que já tem card aberto); teto de páginas pra evitar loop.
   *
   * @example entrada: { formId: "1203...", pageId?: "10687..." }
   * @example saída:   { formId, pageId, total: 42, created: 40, skipped: 2, errors: 0 }
   */
  async importFormLeads(
    organizationId: string,
    dto: { formId: string; pageId?: string },
  ): Promise<{
    formId: string;
    pageId: string;
    total: number;
    created: number;
    skipped: number;
    errors: number;
  }> {
    const formId = String(dto?.formId ?? '').trim();
    if (!/^\d+$/.test(formId)) {
      throw new BadRequestException('Form ID inválido (use apenas dígitos).');
    }

    const page = await this.resolveOrgPage(organizationId, dto?.pageId);

    let total = 0;
    let created = 0;
    let skipped = 0;
    let errors = 0;
    let after: string | undefined;
    const MAX_PAGES = 50; // teto de segurança (~5000 leads a 100/página)

    for (let p = 0; p < MAX_PAGES; p++) {
      let batch: any;
      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/${this.apiVersion}/${formId}/leads`,
          {
            params: {
              access_token: page.accessToken,
              fields: 'id,created_time,field_data,ad_id,campaign_name',
              limit: 100,
              ...(after ? { after } : {}),
            },
            timeout: 30000,
          },
        );
        batch = data;
      } catch (err: any) {
        const msg =
          err?.response?.data?.error?.message ?? err?.message ?? 'erro';
        this.logger.warn(
          `Lead Ads import: falha ao listar leads do form ${formId}: ${msg}`,
        );
        // Se nem a 1ª página veio, devolve erro claro pra UI; senão, para e
        // retorna o que já importou.
        if (total === 0) {
          throw new BadRequestException(
            `Não foi possível ler os leads do formulário: ${msg}`,
          );
        }
        break;
      }

      const leads: any[] = Array.isArray(batch?.data) ? batch.data : [];
      for (const lead of leads) {
        total++;
        const leadgenId = String(lead?.id ?? '');
        if (!leadgenId) {
          errors++;
          continue;
        }
        try {
          const { created: didCreate } = await this.createLead(page, lead, {
            leadgenId,
            formId,
            adId: lead?.ad_id,
          });
          if (didCreate) created++;
          else skipped++;
        } catch (err: any) {
          errors++;
          const msg =
            err?.response?.data?.error?.message ?? err?.message ?? 'erro';
          this.logger.warn(
            `Lead Ads import: falha no lead ${leadgenId}: ${msg}`,
          );
        }
      }

      after = batch?.paging?.cursors?.after;
      if (!after || leads.length === 0) break;
    }

    this.logger.log(
      `Lead Ads import: form ${formId} (org ${organizationId}) → total=${total} criados=${created} existentes=${skipped} erros=${errors}`,
    );
    return { formId, pageId: page.pageId, total, created, skipped, errors };
  }

  /**
   * Resolve a página de Lead Ads da org para a importação. Se `pageId` vier,
   * valida que pertence à org e está ativa. Se não vier e houver exatamente
   * uma página ativa, usa ela; com mais de uma, exige o pageId.
   */
  private async resolveOrgPage(organizationId: string, pageId?: string) {
    if (pageId) {
      const page = await this.prisma.leadAdsPage.findFirst({
        where: { organizationId, pageId: String(pageId).trim() },
      });
      if (!page) {
        throw new BadRequestException(
          'Página não conectada para esta organização.',
        );
      }
      if (!page.active) throw new BadRequestException('Página inativa.');
      return page;
    }
    const pages = await this.prisma.leadAdsPage.findMany({
      where: { organizationId, active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (pages.length === 0) {
      throw new BadRequestException('Nenhuma página de Lead Ads conectada.');
    }
    if (pages.length > 1) {
      throw new BadRequestException(
        'Mais de uma página conectada — informe o pageId do formulário.',
      );
    }
    return pages[0];
  }

  private parseFieldData(fieldData: any[]): {
    name?: string;
    phone?: string;
    email?: string;
    raw: Record<string, string>;
  } {
    const raw: Record<string, string> = {};
    let name: string | undefined;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let phone: string | undefined;
    let email: string | undefined;
    for (const f of fieldData) {
      const key = String(f?.name ?? '').toLowerCase();
      const value = Array.isArray(f?.values) ? String(f.values[0] ?? '') : '';
      if (!key) continue;
      raw[key] = value;
      if (key === 'full_name' || key === 'name') name = value;
      else if (key === 'first_name') firstName = value;
      else if (key === 'last_name') lastName = value;
      else if (key.includes('phone')) phone = value;
      else if (key === 'email' || key.includes('email')) email = value;
    }
    if (!name && (firstName || lastName)) {
      name = [firstName, lastName].filter(Boolean).join(' ');
    }
    return { name, phone, email, raw };
  }

  private normalizePhone(phone?: string): string | null {
    if (!phone) return null;
    const digits = phone.replace(/[^\d+]/g, '');
    return digits || null;
  }

  private async findOrCreateContact(
    organizationId: string,
    data: { name: string | null; phone: string | null; email: string | null },
  ) {
    let contact = null as any;
    if (data.phone) {
      // Match por VARIANTES (9º dígito BR + DDI): unifica com o WhatsApp.
      contact = await this.prisma.contact.findFirst({
        where: { organizationId, phone: { in: phoneVariants(data.phone) } },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!contact && data.email) {
      contact = await this.prisma.contact.findFirst({
        where: { organizationId, email: data.email },
      });
    }
    if (contact) {
      const patch: Record<string, any> = {};
      if (!contact.name && data.name) patch.name = data.name;
      if (!contact.email && data.email) patch.email = data.email;
      if (!contact.phone && data.phone) patch.phone = data.phone;
      if (Object.keys(patch).length) {
        contact = await this.prisma.contact.update({
          where: { id: contact.id },
          data: patch,
        });
      }
      return contact;
    }
    return this.prisma.contact.create({
      data: {
        organizationId,
        name: data.name,
        phone: data.phone,
        email: data.email,
        metadata: { source: 'facebook_leadads' },
      },
    });
  }

  // ─── Config de páginas ─────────────────────────
  listPages(organizationId: string) {
    return this.prisma.leadAdsPage.findMany({
      where: { organizationId },
      select: {
        id: true,
        pageId: true,
        pageName: true,
        active: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async savePage(
    organizationId: string,
    dto: { pageId: string; pageName?: string; accessToken: string },
  ) {
    const pageId = String(dto.pageId).trim();
    const provided = dto.accessToken.trim();
    // O `subscribed_apps` e a busca do lead exigem um PAGE access token. O que
    // o usuário cola costuma ser um token de usuário/System User — então
    // trocamos por um token da página (`GET /{page}?fields=access_token`).
    // Se a troca falhar (já é um page token, ou sem permissão), usamos o que
    // veio.
    const token = await this.resolvePageToken(pageId, provided);
    const saved = await this.prisma.leadAdsPage.upsert({
      where: { pageId },
      create: {
        organizationId,
        pageId,
        pageName: dto.pageName ?? null,
        accessToken: token,
        active: true,
      },
      update: {
        organizationId,
        pageName: dto.pageName ?? null,
        accessToken: token,
        active: true,
      },
      select: { id: true, pageId: true, pageName: true, active: true },
    });

    // Ao conectar a página, já assinamos o app no campo `leadgen` dessa
    // página (equivale ao POST /{page}/subscribed_apps do Graph API). Assim
    // o usuário não precisa rodar isso à mão no Explorer. Best-effort: se
    // falhar (ex.: token sem pages_manage_metadata), a conexão continua
    // salva e devolvemos o motivo pra UI.
    const subscription = await this.subscribeLeadgen(pageId, token);
    return { ...saved, subscription };
  }

  /**
   * Troca um token de usuário/System User pelo token DA PÁGINA. Se já for um
   * page token (ou a troca falhar), devolve o token original.
   */
  private async resolvePageToken(
    pageId: string,
    token: string,
  ): Promise<string> {
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${this.apiVersion}/${pageId}`,
        { params: { fields: 'access_token', access_token: token }, timeout: 20000 },
      );
      const pageToken = data?.access_token;
      if (typeof pageToken === 'string' && pageToken.length > 0) {
        this.logger.log(`Lead Ads: page token derivado para a página ${pageId}`);
        return pageToken;
      }
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.message ?? err?.message ?? 'erro';
      this.logger.warn(
        `Lead Ads: não foi possível derivar page token da página ${pageId} (${msg}); usando token original`,
      );
    }
    return token;
  }

  /** POST /{page}/subscribed_apps?subscribed_fields=leadgen (best-effort). */
  private async subscribeLeadgen(
    pageId: string,
    accessToken: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/${this.apiVersion}/${pageId}/subscribed_apps`,
        null,
        {
          params: { subscribed_fields: 'leadgen', access_token: accessToken },
          timeout: 20000,
        },
      );
      const ok = data?.success === true;
      if (ok) {
        this.logger.log(`Lead Ads: página ${pageId} assinada em leadgen`);
      }
      return { ok, error: ok ? undefined : 'resposta sem success=true' };
    } catch (err: any) {
      const error =
        err?.response?.data?.error?.message ?? err?.message ?? 'erro';
      this.logger.warn(
        `Lead Ads: falha ao assinar leadgen da página ${pageId}: ${error}`,
      );
      return { ok: false, error };
    }
  }

  async removePage(organizationId: string, id: string) {
    await this.prisma.leadAdsPage.deleteMany({
      where: { id, organizationId },
    });
  }
}
