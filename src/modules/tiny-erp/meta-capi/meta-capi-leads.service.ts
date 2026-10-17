import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { MetaCapiHttpClient, CapiEvent } from './meta-capi.http-client';
import { MetaCapiService } from './meta-capi.service';
import {
  hashEmail,
  hashPhone,
  hashName,
  hashId,
  splitName,
  fbcFromFbclid,
} from './meta-capi.hash';
import { webContextFromTracking } from './meta-capi.web';

/** Janela do clique CTWA aceita pela Meta para eventos de business messaging. */
const CTWA_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** Máximo de tentativas por lead antes de desistir (evita martelar config ruim). */
const MAX_ATTEMPTS = 3;

interface Candidate {
  contactId: string;
  cardId: string;
  value: number | null;
  leadgenId: string | null;
  channelId: string | null;
  channelType: string | null;
  reason: 'won' | 'pedido' | 'orcamento' | 'stage' | 'score';
}

type RawCfg = NonNullable<Awaited<ReturnType<MetaCapiService['loadRawConfig']>>>;

/**
 * Evento de LEAD QUALIFICADO para a Meta (CAPI) — fecha o loop de qualidade:
 * a campanha passa a aprender quem virou lead BOM, não só quem preencheu.
 *
 * Critério:
 *   card GANHO  OU  gerou PEDIDO/ORÇAMENTO no Tiny  OU  está numa das ETAPAS
 *   escolhidas na config  OU  leadScore >= corte da config (padrão 60).
 *   (Não usa "avançou qualquer etapa": no funil real, follow-ups AUTOMÁTICOS e
 *   "Perdido" ficam depois da entrada e eram ~70% dos "qualificados".)
 * Escopo: cards criados nos últimos 30 dias, fora de marketplace (ML/Shopee
 * não são lead de anúncio). 1 evento por contato (idempotente), até 3
 * tentativas em caso de falha.
 *
 * Envio:
 *  - Lead do Click-to-WhatsApp (ctwa_clid ≤ 7 dias, canal Oficial com WABA):
 *    action_source=business_messaging + ctwa_clid (match exato com o clique).
 *    Se a Meta recusar (ex.: dataset não vinculado à WABA), cai no padrão.
 *  - Padrão: action_source=system_generated (CRM) com telefone/e-mail/nome
 *    hasheados, fbc/fbp/IP/UA da LP e lead_id do Lead Ads quando houver.
 *
 * Exemplo de evento (padrão):
 *   { event_name: "QualifiedLead", event_time: 1760620000,
 *     event_id: "KORTIA-QL-<contactId>", action_source: "system_generated",
 *     user_data: { ph: ["<sha256>"], em: [...], external_id: [...], fbc: "fb.1…",
 *                  lead_id: "1234567890123456" },
 *     custom_data: { event_source: "crm", lead_event_source: "Kortia CRM",
 *                    qualification: "orcamento", value: 3490, currency: "BRL" } }
 */
@Injectable()
export class MetaCapiLeadsService {
  private readonly logger = new Logger(MetaCapiLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: MetaCapiHttpClient,
    private readonly capi: MetaCapiService,
  ) {}

  /** Varre e emite os leads qualificados pendentes. No-op se desligado. */
  async emitQualifiedLeads(organizationId: string, limit = 100): Promise<void> {
    const cfg = await this.capi.loadRawConfig(organizationId);
    if (!cfg?.enabled || !cfg.qualifiedLeadEnabled || !cfg.pixelId || !cfg.accessToken) {
      return;
    }
    const eventName = (cfg.qualifiedLeadEventName || 'QualifiedLead').trim();
    // Etapas escolhidas na tela. Vazio = nenhuma etapa conta (só ganho,
    // orçamento/pedido e lead score). Array vazio em ANY() → sempre falso.
    const stageIds: string[] = cfg.qualifiedLeadStageIds ?? [];
    // Corte do lead score da LP (101 = critério de score desligado).
    const minScore: number = cfg.qualifiedLeadMinScore ?? 60;

    const rows = await this.prisma.$queryRaw<Candidate[]>`
      WITH docs AS (
        SELECT d.contact_id,
               bool_or(d.kind = 'PEDIDO')    AS has_ped,
               bool_or(d.kind = 'ORCAMENTO') AS has_orc
        FROM tiny_documents d
        WHERE d.organization_id = ${organizationId} AND d.contact_id IS NOT NULL
        GROUP BY d.contact_id
      )
      SELECT DISTINCT ON (c.contact_id)
        c.contact_id                 AS "contactId",
        c.id                         AS "cardId",
        c.value::float8              AS value,
        c.metadata->>'leadgenId'     AS "leadgenId",
        conv.channel_id              AS "channelId",
        ch.type::text                AS "channelType",
        CASE
          WHEN c.status::text = 'WON'       THEN 'won'
          WHEN COALESCE(dx.has_ped, false)  THEN 'pedido'
          WHEN COALESCE(dx.has_orc, false)  THEN 'orcamento'
          WHEN c.stage_id = ANY(${stageIds}::text[]) THEN 'stage'
          ELSE 'score'
        END                          AS reason
      FROM cards c
      JOIN contacts ct ON ct.id = c.contact_id AND ct.deleted_at IS NULL
      LEFT JOIN conversations conv ON conv.id = c.conversation_id
      LEFT JOIN channels ch ON ch.id = conv.channel_id
      LEFT JOIN docs dx ON dx.contact_id = c.contact_id
      WHERE c.organization_id = ${organizationId}
        AND c.created_at >= now() - interval '30 days'
        AND (ch.type IS NULL OR ch.type::text NOT IN ('MERCADO_LIVRE', 'SHOPEE'))
        AND (
          c.status::text = 'WON'
          OR c.stage_id = ANY(${stageIds}::text[])
          OR COALESCE(dx.has_ped, false)
          OR COALESCE(dx.has_orc, false)
          OR (CASE WHEN (c.metadata->>'leadScore') ~ '^[0-9]+$'
                   THEN (c.metadata->>'leadScore')::numeric ELSE 0 END) >= ${minScore}
        )
        AND NOT EXISTS (
          SELECT 1 FROM meta_capi_lead_events le
          WHERE le.contact_id = c.contact_id
            AND le.event_name = ${eventName}
            AND (le.status = 'sent' OR le.attempts >= ${MAX_ATTEMPTS})
        )
      ORDER BY c.contact_id, c.created_at DESC
      LIMIT ${limit}`;

    let sent = 0;
    for (const r of rows) {
      if (await this.emitOne(organizationId, cfg, eventName, r)) sent++;
    }
    if (rows.length) {
      this.logger.log(
        `CAPI ${eventName}: ${sent}/${rows.length} enviados (org ${organizationId})`,
      );
    }
  }

  private async emitOne(
    organizationId: string,
    cfg: RawCfg,
    eventName: string,
    r: Candidate,
  ): Promise<boolean> {
    try {
      const contact = await this.prisma.contact.findUnique({
        where: { id: r.contactId },
        select: { id: true, name: true, phone: true, email: true, createdAt: true, metadata: true },
      });
      if (!contact) return false;
      const tr = (((contact.metadata as any) ?? {}).tracking ?? {}) as Record<string, any>;

      const nowSec = Math.floor(Date.now() / 1000);
      const eventId = `KORTIA-QL-${contact.id}`;
      const cur = (cfg.currency || 'BRL').toUpperCase();
      const custom_data: Record<string, any> = {
        event_source: 'crm',
        lead_event_source: 'Kortia CRM',
        qualification: r.reason,
      };
      if (typeof r.value === 'number' && Number.isFinite(r.value) && r.value > 0) {
        custom_data.value = Math.round(r.value * 100) / 100;
        custom_data.currency = cur;
      }

      // 1) Click-to-WhatsApp → business_messaging (quando possível).
      let result: Awaited<ReturnType<MetaCapiHttpClient['sendEvents']>> | null = null;
      let actionSource = 'system_generated';
      const bm = await this.buildBusinessMessagingEvent(eventName, eventId, nowSec, tr, r, custom_data);
      if (bm) {
        result = await this.send(cfg, bm);
        actionSource = 'business_messaging';
        if (!result.ok) {
          this.logger.warn(
            `CAPI ${eventName} business_messaging recusado contato=${contact.id} (${result.error}); usando system_generated`,
          );
          result = null;
        }
      }

      // 2) Lead com dados de navegador da LP → "website" (entra em conversão
      //    personalizada e na otimização das campanhas de site). Sem esses
      //    dados → padrão CRM (system_generated).
      if (!result) {
        const web = webContextFromTracking(tr, cfg.websiteUrl);
        actionSource = web ? 'website' : 'system_generated';
        const { first, last } = splitName(contact.name);
        const leadTs = contact.createdAt ? contact.createdAt.getTime() : Date.now();
        const user_data: Record<string, any> = {
          em: arr(hashEmail(contact.email)),
          ph: arr(hashPhone(contact.phone)),
          fn: arr(hashName(first)),
          ln: arr(hashName(last)),
          external_id: arr(hashId(contact.id)),
          fbc: tr.fbc || fbcFromFbclid(tr.fbclid, leadTs) || undefined,
          fbp: tr.fbp || undefined,
          client_ip_address: tr.ip || tr.client_ip_address || tr.client_ip || undefined,
          client_user_agent: web?.userAgent || tr.client_user_agent || tr.user_agent || undefined,
          // Lead Ads (formulário instantâneo): lead_id é a chave de match mais forte.
          lead_id: r.leadgenId && /^\d{10,20}$/.test(r.leadgenId) ? r.leadgenId : undefined,
        };
        for (const k of Object.keys(user_data)) if (user_data[k] == null) delete user_data[k];
        if (!user_data.ph && !user_data.em && !user_data.lead_id && !user_data.fbc) {
          // Sem nenhuma chave de match útil: não envia (só geraria ruído).
          return false;
        }
        result = await this.send(cfg, {
          event_name: eventName,
          event_time: nowSec,
          event_id: eventId,
          action_source: actionSource,
          ...(web ? { event_source_url: web.eventSourceUrl } : {}),
          user_data,
          custom_data,
        });
      }

      await this.prisma.metaCapiLeadEvent.upsert({
        where: { uq_capi_lead_contact_event: { contactId: contact.id, eventName } },
        create: {
          organizationId,
          contactId: contact.id,
          eventName,
          status: result.ok ? 'sent' : 'failed',
          actionSource,
          reason: r.reason,
          httpStatus: result.httpStatus,
          fbTraceId: result.fbTraceId ?? null,
          error: result.ok ? null : (result.error ?? null),
          eventId,
        },
        update: {
          status: result.ok ? 'sent' : 'failed',
          actionSource,
          reason: r.reason,
          attempts: { increment: 1 },
          httpStatus: result.httpStatus,
          fbTraceId: result.fbTraceId ?? null,
          error: result.ok ? null : (result.error ?? null),
          sentAt: new Date(),
        },
      });
      return result.ok;
    } catch (err: any) {
      this.logger.warn(`CAPI ${eventName} falhou contato=${r.contactId}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Evento de business messaging (CTWA). Só quando: há ctwa_clid recente
   * (≤ 7 dias) e a conversa é do WhatsApp Oficial com WABA conhecida.
   */
  private async buildBusinessMessagingEvent(
    eventName: string,
    eventId: string,
    nowSec: number,
    tr: Record<string, any>,
    r: Candidate,
    custom_data: Record<string, any>,
  ): Promise<CapiEvent | null> {
    const clid = typeof tr.ctwa_clid === 'string' ? tr.ctwa_clid.trim() : '';
    if (!clid || r.channelType !== 'WHATSAPP_OFFICIAL' || !r.channelId) return null;
    const at = tr.ctwa_at ? Date.parse(tr.ctwa_at) : NaN;
    if (!Number.isFinite(at) || Date.now() - at > CTWA_WINDOW_MS) return null;

    // Channel via Prisma (a extensão decifra o config com os dados do provider).
    const channel = await this.prisma.channel.findUnique({
      where: { id: r.channelId },
      select: { config: true },
    });
    const waba = String(((channel?.config as any) ?? {}).businessAccountId ?? '').trim();
    if (!waba) return null;

    return {
      event_name: eventName,
      event_time: nowSec,
      event_id: eventId,
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: { whatsapp_business_account_id: waba, ctwa_clid: clid },
      custom_data,
    };
  }

  private send(cfg: RawCfg, event: CapiEvent) {
    return this.http.sendEvents({
      pixelId: cfg.pixelId!,
      accessToken: cfg.accessToken!,
      apiVersion: cfg.apiVersion,
      events: [event],
      testEventCode: cfg.testEventCode,
    });
  }
}

function arr(v?: string): string[] | undefined {
  return v ? [v] : undefined;
}
