import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import axios from 'axios';
import { PrismaService } from '../../database/prisma.service';
import { PipelinesService } from '../pipelines/pipelines.service';

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

      const fields = this.parseFieldData(data?.field_data ?? []);
      const name = fields.name ?? null;
      const phone = this.normalizePhone(fields.phone);
      const email = fields.email ?? null;

      const contact = await this.findOrCreateContact(page.organizationId, {
        name,
        phone,
        email,
      });

      await this.pipelines.createEntryCardForContact(
        page.organizationId,
        contact.id,
        name || phone || email || 'Lead do Facebook',
        {
          source: 'facebook_leadads',
          leadgenId: change.leadgenId,
          formId: data?.form_id ?? change.formId,
          adId: data?.ad_id ?? change.adId,
          campaignName: data?.campaign_name,
          fields: fields.raw,
        },
      );
      this.logger.log(
        `Lead Ads: lead ${change.leadgenId} → contato ${contact.id} (org ${page.organizationId})`,
      );
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.message ?? err?.message ?? 'erro';
      this.logger.warn(`Lead Ads: falha ao processar ${change.leadgenId}: ${msg}`);
    }
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
      contact = await this.prisma.contact.findFirst({
        where: { organizationId, phone: data.phone },
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
    return this.prisma.leadAdsPage.upsert({
      where: { pageId },
      create: {
        organizationId,
        pageId,
        pageName: dto.pageName ?? null,
        accessToken: dto.accessToken.trim(),
        active: true,
      },
      update: {
        organizationId,
        pageName: dto.pageName ?? null,
        accessToken: dto.accessToken.trim(),
        active: true,
      },
      select: { id: true, pageId: true, pageName: true, active: true },
    });
  }

  async removePage(organizationId: string, id: string) {
    await this.prisma.leadAdsPage.deleteMany({
      where: { id, organizationId },
    });
  }
}
