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

      const data = await this.fetchLeadFromGraph(change.leadgenId, page.accessToken);

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
      ad_name?: string;
      adset_id?: string;
      adset_name?: string;
      campaign_id?: string;
      campaign_name?: string;
      platform?: string;
      is_organic?: boolean;
    },
    ids: { leadgenId: string; formId?: string; adId?: string },
  ): Promise<{ created: boolean }> {
    const fields = this.parseFieldData(lead?.field_data ?? []);
    const name = fields.name ?? null;
    const phone = this.normalizePhone(fields.phone);
    const email = fields.email ?? null;
    const qual = this.qualifyFromForm(fields.raw);
    const tracking = this.leadAdsTracking(lead, ids);

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
        ...(Object.keys(tracking).length ? { tracking } : {}),
        ...(qual
          ? {
              leadScore: qual.score,
              leadTemperature: qual.temperature,
              qualificacao: { origem: 'facebook_form', prazo: qual.prazo, item: qual.item },
            }
          : {}),
      },
      // Roteamento por origem: tipo FACEBOOK_LEADADS + exceção por página.
      { leadSource: 'facebook_leadads', leadAdsPageId: page.pageId },
    );
    if (!card) {
      // Contato já tinha card aberto: a regra do funil é 1 card aberto por
      // contato, então NÃO criamos outro (senão duplica). Em vez de perder o
      // lead, registramos o contexto do formulário na descrição do card
      // existente (idempotente por leadgenId) e corrigimos o título se ainda
      // estiver "cru" (um e-mail de card antigo).
      await this.enrichOpenCardFromForm(page.organizationId, contact.id, {
        leadgenId: ids.leadgenId,
        fields: fields.raw,
      });
      await this.attachTrackingToOpenCard(page.organizationId, contact.id, tracking);
      if (name) {
        await this.fixOpenCardTitle(page.organizationId, contact.id, name);
      }
    }
    if (qual) {
      await this.applyFormQualification(page.organizationId, contact.id, qual, !card);
    }
    return { created: !!card };
  }

  // ── Qualificação pelas respostas do formulário (Quente/Morno/Frio) ──────
  // Regra decidida em 25/11/2026: a temperatura vem do PRAZO declarado.
  //   Esta semana = 85 (Quente) · Este mês = 60 (Morno) · Só pesquisando = 25 (Frio).
  //   Cortes: >=70 Quente · >=40 Morno · <40 Frio. "Este mês" = 60 conta como
  //   QualifiedLead na Meta (corte >= 60). O item ("o que quer organizar") fica
  //   só registrado no card — 92% dos leads escolhem gaveta/talheres, então não
  //   diferencia. Grava leadScore/leadTemperature (mesmos campos da LP).

  private static readonly FORM_SCORE_PRAZO = { semana: 85, mes: 60, pesquisando: 25 };

  private normalizeAnswer(v: unknown): string {
    return String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[_/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private temperatureFromScore(score: number): 'Quente' | 'Morno' | 'Frio' {
    if (score >= 70) return 'Quente';
    if (score >= 40) return 'Morno';
    return 'Frio';
  }

  /** Score/temperatura a partir das respostas. null = sem resposta de prazo. */
  qualifyFromForm(raw?: Record<string, any> | null): {
    score: number;
    temperature: 'Quente' | 'Morno' | 'Frio';
    prazo: string;
    item: string | null;
  } | null {
    if (!raw || typeof raw !== 'object') return null;
    let prazo: string | null = null;
    let item: string | null = null;
    for (const [rk, rv] of Object.entries(raw)) {
      const k = this.normalizeAnswer(rk);
      const v = this.normalizeAnswer(rv);
      if (!v) continue;
      if (!prazo && (k.includes('quando') || k.includes('pretende') || k.includes('prazo'))) prazo = v;
      else if (!item && (k.includes('organizar') || k.includes('o que') || k.includes('item'))) item = v;
    }
    if (!prazo) return null;
    const P = LeadAdsService.FORM_SCORE_PRAZO;
    let score: number | null = null;
    if (prazo.includes('semana')) score = P.semana;
    else if (prazo.includes('mes')) score = P.mes;
    else if (prazo.includes('pesquis')) score = P.pesquisando;
    if (score == null) return null;
    return { score, temperature: this.temperatureFromScore(score), prazo, item };
  }

  /**
   * Aplica a qualificação: no card aberto existente (quando o lead já tinha
   * card), mantém o MAIOR score (a maior intenção declarada); e troca a
   * etiqueta de temperatura do contato (remove as outras Lead Quente/Morno/Frio).
   */
  private async applyFormQualification(
    organizationId: string,
    contactId: string,
    qual: { score: number; temperature: string; prazo: string; item: string | null },
    existingCard: boolean,
  ): Promise<void> {
    try {
      let finalScore = qual.score;
      if (existingCard) {
        const open = await this.prisma.card.findFirst({
          where: { organizationId, contactId, status: 'OPEN' },
          select: { id: true, metadata: true },
          orderBy: { createdAt: 'desc' },
        });
        if (open) {
          const meta = (open.metadata ?? {}) as Record<string, any>;
          const prev = Number(meta.leadScore);
          if (Number.isFinite(prev) && prev > finalScore) finalScore = prev;
          await this.prisma.card.update({
            where: { id: open.id },
            data: {
              metadata: {
                ...meta,
                leadScore: finalScore,
                leadTemperature: this.temperatureFromScore(finalScore),
                qualificacao: { origem: 'facebook_form', prazo: qual.prazo, item: qual.item },
              },
            },
          });
        }
      }
      await this.setTemperatureTag(organizationId, contactId, this.temperatureFromScore(finalScore));
    } catch (err: any) {
      this.logger.warn(
        `Lead Ads: falha ao aplicar qualificação (contato ${contactId}): ${err?.message ?? err}`,
      );
    }
  }

  /** Etiqueta "Lead <temp>" no contato, removendo as outras temperaturas. */
  private async setTemperatureTag(organizationId: string, contactId: string, temperature: string) {
    const name = `Lead ${temperature}`;
    const others = ['Lead Quente', 'Lead Morno', 'Lead Frio'].filter((n) => n !== name);
    await this.prisma.contactTag.deleteMany({
      where: { contactId, tag: { organizationId, name: { in: others } } },
    });
    const tag = await this.prisma.tag.upsert({
      where: { organizationId_name: { organizationId, name } },
      update: {},
      create: { organizationId, name },
    });
    await this.prisma.contactTag.upsert({
      where: { contactId_tagId: { contactId, tagId: tag.id } },
      update: {},
      create: { contactId, tagId: tag.id },
    });
  }

  // ── Rastreamento do Lead Ads ─────────────────────────────────────────
  // Formulário instantâneo não passa por site: não há UTM/gclid/fbclid/IP.
  // O "rastreamento" equivalente são os dados do anúncio que a Meta devolve.

  private static readonly LEAD_FIELDS_BASIC = 'field_data,form_id,ad_id,campaign_name,created_time';
  private static readonly LEAD_FIELDS_RICH =
    'field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,is_organic,created_time';
  private static readonly LIST_FIELDS_BASIC = 'id,created_time,field_data,ad_id,campaign_name';
  private static readonly LIST_FIELDS_RICH =
    'id,created_time,field_data,form_id,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,platform,is_organic';

  /** Lê o lead na Graph com os dados do anúncio; se o token não liberar, usa os básicos. */
  private async fetchLeadFromGraph(leadgenId: string, accessToken: string): Promise<any> {
    const get = (fields: string) =>
      axios.get(`https://graph.facebook.com/${this.apiVersion}/${leadgenId}`, {
        params: { access_token: accessToken, fields },
        timeout: 20000,
      });
    try {
      return (await get(LeadAdsService.LEAD_FIELDS_RICH)).data;
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message ?? err?.message ?? 'erro';
      this.logger.warn(`Lead Ads: campos do anúncio indisponíveis (${msg}) — usando campos básicos`);
      return (await get(LeadAdsService.LEAD_FIELDS_BASIC)).data;
    }
  }

  /**
   * Dados do anúncio no formato de rastreamento (painel "Lead" e card).
   * @example → { platform: 'instagram', campaign_name: 'LeadAds Gaveta', adset_name: 'Mulheres 30+',
   *              ad_name: 'Video 01', ad_id: '120…', form_id: '987…', leadgen_id: '555…', is_organic: 'não' }
   */
  private leadAdsTracking(
    lead: any,
    ids: { leadgenId: string; formId?: string; adId?: string },
  ): Record<string, string> {
    const plat = String(lead?.platform ?? '').toLowerCase();
    const t: Record<string, unknown> = {
      platform: plat === 'ig' ? 'instagram' : plat === 'fb' ? 'facebook' : plat || undefined,
      campaign_name: lead?.campaign_name,
      adset_name: lead?.adset_name,
      ad_name: lead?.ad_name,
      campaign_id: lead?.campaign_id,
      adset_id: lead?.adset_id,
      ad_id: lead?.ad_id ?? ids.adId,
      form_id: lead?.form_id ?? ids.formId,
      leadgen_id: ids.leadgenId,
      is_organic:
        typeof lead?.is_organic === 'boolean' ? (lead.is_organic ? 'sim' : 'não') : undefined,
    };
    return Object.fromEntries(
      Object.entries(t)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => [k, String(v)]),
    );
  }

  /** Lead que já tinha card aberto: grava o rastreamento do anúncio se o card não tiver nenhum. */
  private async attachTrackingToOpenCard(
    organizationId: string,
    contactId: string,
    tracking: Record<string, string>,
  ): Promise<void> {
    if (!Object.keys(tracking).length) return;
    try {
      const open = await this.prisma.card.findFirst({
        where: { organizationId, contactId, status: 'OPEN' },
        select: { id: true, metadata: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!open) return;
      const meta = (open.metadata ?? {}) as Record<string, any>;
      // Não sobrescreve rastreamento que o card já tem (ex.: veio da LP).
      if (meta.tracking && Object.keys(meta.tracking).length) return;
      await this.prisma.card.update({
        where: { id: open.id },
        data: { metadata: { ...meta, tracking } },
      });
    } catch (err: any) {
      this.logger.warn(
        `Lead Ads: falha ao gravar rastreamento no card aberto (contato ${contactId}): ${err?.message ?? err}`,
      );
    }
  }

  /** Troca o título de um card aberto quando ele é só um e-mail e já temos o nome. */
  private async fixOpenCardTitle(
    organizationId: string,
    contactId: string,
    name: string,
  ): Promise<void> {
    try {
      const open = await this.prisma.card.findFirst({
        where: { organizationId, contactId, status: 'OPEN' },
        select: { id: true, title: true },
      });
      if (!open) return;
      const title = (open.title ?? '').trim();
      const nextName = name.trim();
      if (nextName && nextName !== title && this.isBadName(title, null)) {
        await this.prisma.card.update({
          where: { id: open.id },
          data: { title: nextName },
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `Lead Ads: falha ao ajustar título do card (contato ${contactId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Resumo legível do formulário pro vendedor, com marcador idempotente
   * `[fb-lead:<leadgenId>]` pra não anexar duas vezes o mesmo lead.
   */
  private formLeadSummary(
    leadgenId: string,
    fields: Record<string, string>,
  ): string {
    const g = (k: string) =>
      fields?.[k] ? String(fields[k]).replace(/_/g, ' ').trim() : '';
    const parts: string[] = [];
    const full = g('nome_completo');
    if (full) parts.push(`Nome: ${full}`);
    const quer =
      g('o_que_você_quer_organizar?') || g('o_que_voce_quer_organizar?');
    if (quer) parts.push(`Quer organizar: ${quer}`);
    const quando = g('quando_pretende_fazer_o_pedido?');
    if (quando) parts.push(`Quando: ${quando}`);
    const loc = [g('cidade'), g('estado')].filter(Boolean).join('/');
    if (loc) parts.push(`Cidade: ${loc}`);
    const header = `📋 Lead Facebook (formulário) [fb-lead:${leadgenId}]`;
    return parts.length
      ? `${header}\n${parts.map((x) => `• ${x}`).join('\n')}`
      : header;
  }

  /**
   * Quando o lead casa com um contato que JÁ tem card aberto, não criamos outro
   * card (1 card aberto por contato). Pra não perder o contexto do formulário,
   * anexamos um resumo na descrição do card aberto. Idempotente: não duplica se
   * o mesmo leadgenId já foi anexado. Best-effort (não quebra o fluxo).
   */
  private async enrichOpenCardFromForm(
    organizationId: string,
    contactId: string,
    data: { leadgenId: string; fields: Record<string, string> },
  ): Promise<void> {
    try {
      const card = await this.prisma.card.findFirst({
        where: { organizationId, contactId, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, description: true },
      });
      if (!card) return;
      const marker = `[fb-lead:${data.leadgenId}]`;
      if ((card.description ?? '').includes(marker)) return;
      const summary = this.formLeadSummary(data.leadgenId, data.fields);
      const base = (card.description ?? '').trim();
      const description = base ? `${base}\n\n${summary}` : summary;
      await this.prisma.card.update({
        where: { id: card.id },
        data: { description },
      });
    } catch (err: any) {
      this.logger.warn(
        `Lead Ads: falha ao enriquecer card do contato ${contactId}: ${err?.message ?? err}`,
      );
    }
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
    // Campos do anúncio (campanha/conjunto/anúncio). Se o token não liberar,
    // cai para os campos básicos e segue a importação.
    let listFields = LeadAdsService.LIST_FIELDS_RICH;

    for (let p = 0; p < MAX_PAGES; p++) {
      let batch: any;
      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/${this.apiVersion}/${formId}/leads`,
          {
            params: {
              access_token: page.accessToken,
              fields: listFields,
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
        if (listFields === LeadAdsService.LIST_FIELDS_RICH) {
          this.logger.warn(
            `Lead Ads import: campos do anúncio indisponíveis (${msg}) — usando campos básicos`,
          );
          listFields = LeadAdsService.LIST_FIELDS_BASIC;
          p--;
          continue;
        }
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

  /**
   * Nome "ruim" = não é um nome de verdade: vazio, e-mail, telefone (ou igual ao
   * telefone do contato) ou placeholder conhecido. Só nesses casos o nome do
   * formulário sobrescreve (decisão: "só preenche se estiver ruim").
   */
  private isBadName(name?: string | null, phone?: string | null): boolean {
    const n = String(name ?? '').trim();
    if (!n) return true;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n)) return true; // e-mail
    const digits = n.replace(/\D/g, '');
    if (digits.length >= 8 && /^[\d\s()+-]+$/.test(n)) return true; // telefone
    if (phone) {
      const pd = String(phone).replace(/\D/g, '');
      if (pd && digits && (digits === pd || (pd.length >= 8 && digits.endsWith(pd.slice(-8))))) return true;
    }
    const PLACEHOLDERS = ['lead do facebook', 'novo lead', 'desconhecido', 'sem nome', 'lead'];
    if (PLACEHOLDERS.includes(n.toLowerCase())) return true;
    return false;
  }

  /** Extrai o nome dos campos crus do formulário (mesmas palavras-chave do parse). */
  private nameFromRawFields(raw?: Record<string, any> | null): string | null {
    if (!raw || typeof raw !== 'object') return null;
    const has = (k: string, ...ns: string[]) => ns.some((x) => k.includes(x));
    let full: string | null = null, first: string | null = null, last: string | null = null;
    for (const [rk, rv] of Object.entries(raw)) {
      const k = String(rk).toLowerCase().trim();
      const v = String(rv ?? '').trim();
      if (!v) continue;
      if (!full && (has(k, 'full_name', 'full name', 'nome_completo', 'nome completo') || k === 'name' || k === 'nome')) full = v;
      else if (!first && has(k, 'first_name', 'first name', 'primeiro_nome')) first = v;
      else if (!last && has(k, 'last_name', 'last name', 'sobrenome', 'ultimo_nome')) last = v;
    }
    if (full) return full;
    const combo = [first, last].filter(Boolean).join(' ').trim();
    return combo || null;
  }

  /**
   * Backfill único: corrige o nome (contato e/ou card) dos leads de formulário
   * já existentes quando o nome atual está "ruim", relendo o nome do formulário
   * guardado em card.metadata.fields. Idempotente.
   */
  async backfillLeadNames(
    organizationId: string,
  ): Promise<{ scanned: number; contactsFixed: number; cardsFixed: number }> {
    const cards = await this.prisma.card.findMany({
      where: { organizationId, metadata: { path: ['source'], equals: 'facebook_leadads' } },
      select: {
        id: true, title: true,
        metadata: true,
        contact: { select: { id: true, name: true, phone: true } },
      },
    });
    let contactsFixed = 0;
    let cardsFixed = 0;
    for (const c of cards) {
      const meta = (c.metadata ?? {}) as any;
      const formName = this.nameFromRawFields(meta?.fields);
      if (!formName) continue;
      if (c.contact && this.isBadName(c.contact.name, c.contact.phone)) {
        const ok = await this.prisma.contact
          .update({ where: { id: c.contact.id }, data: { name: formName } })
          .then(() => true).catch(() => false);
        if (ok) contactsFixed++;
      }
      if (this.isBadName(c.title, c.contact?.phone ?? null)) {
        const ok = await this.prisma.card
          .update({ where: { id: c.id }, data: { title: formName } })
          .then(() => true).catch(() => false);
        if (ok) cardsFixed++;
      }
    }
    this.logger.log(
      `backfillLeadNames(org=${organizationId}): scanned=${cards.length} contatos=${contactsFixed} cards=${cardsFixed}`,
    );
    return { scanned: cards.length, contactsFixed, cardsFixed };
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

    // Os nomes dos campos variam por idioma/formulário (PT, EN ou rótulo
    // customizado). Casamos por PALAVRA-CHAVE no nome do campo — não por
    // igualdade exata — senão um form em pt-BR (`telefone`, `nome_completo`)
    // não casa com `phone`/`full_name` e o card entra só com e-mail.
    const has = (k: string, ...needles: string[]) =>
      needles.some((n) => k.includes(n));
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    for (const f of fieldData) {
      const key = String(f?.name ?? '').toLowerCase().trim();
      const value = Array.isArray(f?.values)
        ? String(f.values[0] ?? '').trim()
        : '';
      if (!key) continue;
      raw[key] = value;
      if (!value) continue;

      if (!email && has(key, 'email', 'e-mail', 'e_mail')) {
        email = value;
      } else if (
        !phone &&
        has(key, 'phone', 'telefone', 'celular', 'whatsapp', 'fone', 'tel')
      ) {
        phone = value;
      } else if (
        !name &&
        (has(key, 'full_name', 'full name', 'nome_completo', 'nome completo') ||
          key === 'name' ||
          key === 'nome')
      ) {
        name = value;
      } else if (
        !firstName &&
        has(key, 'first_name', 'first name', 'primeiro_nome')
      ) {
        firstName = value;
      } else if (
        !lastName &&
        has(key, 'last_name', 'last name', 'sobrenome', 'ultimo_nome')
      ) {
        lastName = value;
      }
    }

    // Rede de segurança: se e-mail ou telefone não casaram por nome (rótulo
    // atípico), inferimos pelo FORMATO do valor.
    if (!email || !phone) {
      for (const v of Object.values(raw)) {
        if (!v) continue;
        if (!email && EMAIL_RE.test(v)) {
          email = v;
          continue;
        }
        if (!phone) {
          const digits = v.replace(/\D/g, '');
          // BR: fixo/celular com DDD tem 10-11 dígitos; com DDI, até 13.
          if (
            digits.length >= 10 &&
            digits.length <= 15 &&
            /^[+\d][\d\s()+.-]*$/.test(v)
          ) {
            phone = v;
          }
        }
      }
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
      if (data.name && this.isBadName(contact.name, contact.phone ?? data.phone)) patch.name = data.name;
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
