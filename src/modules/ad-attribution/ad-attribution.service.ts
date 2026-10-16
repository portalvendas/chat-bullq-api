import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MetaAdsService } from '../dashboard/meta-ads.service';
import type { AdReferral } from '../channel-hub/ports/types';

/**
 * Atribuição de anúncio Click-to-WhatsApp (CTWA).
 *
 * Quando o lead chega clicando num anúncio "Enviar mensagem" (WhatsApp), a 1ª
 * mensagem traz o `referral` (ad id + ctwa_clid). Antes isso era descartado e
 * o lead caía como "Orgânico / sem campanha". Aqui gravamos no
 * `metadata.tracking` do CONTATO (lido pelo CAPI) e do CARD da conversa (lido
 * pelo dashboard comercial), e resolvemos ad → campanha/conjunto/anúncio pela
 * Marketing API para o nome casar com o gasto.
 *
 * Regras de merge (atômico, em SQL — sem read-modify-write):
 *   - utm_* são "defaults": só preenchem o que estiver VAZIO (first-touch —
 *     não sobrescreve a UTM de uma LP que o lead já tenha preenchido);
 *   - ctwa_* / ad_* sempre atualizam (último clique é o que vale pro CAPI,
 *     cuja janela é de 7 dias).
 *
 * Exemplo — entrada (referral do WhatsApp Oficial):
 *   { ctwaClid: "ARAk…", sourceId: "120210000000000", sourceType: "ad",
 *     headline: "Cooktop 5 bocas", sourceUrl: "https://fb.me/…" }
 * Saída — metadata.tracking do contato/card:
 *   { utm_source: "facebook_ctwa", utm_campaign: "[CTWA] Cooktops",
 *     utm_medium: "Aberto 25-55", utm_content: "Video 01", utm_id: "1202…",
 *     ctwa_clid: "ARAk…", ctwa_at: "2026-10-16T12:00:00.000Z",
 *     ad_id: "120210000000000", ad_source_type: "ad", ad_headline: "…" }
 */
@Injectable()
export class AdAttributionService {
  private readonly logger = new Logger(AdAttributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaAds: MetaAdsService,
  ) {}

  async recordCtwa(params: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    referral: AdReferral;
  }): Promise<void> {
    const { organizationId, contactId, conversationId, referral: ref } = params;
    if (!ref?.ctwaClid && !ref?.sourceId) return;

    const ctwa = clean({
      ctwa_clid: ref.ctwaClid,
      ctwa_at: new Date().toISOString(),
      ad_id: ref.sourceId,
      ad_source_type: ref.sourceType,
      ad_source_url: ref.sourceUrl,
      ad_headline: ref.headline?.slice(0, 200),
      ad_body: ref.body?.slice(0, 300),
    });

    // Nome da campanha/conjunto/anúncio (best-effort; sem integração Meta Ads
    // configurada, segue só com os ids).
    const ad = ref.sourceId
      ? await this.metaAds.resolveAd(organizationId, ref.sourceId).catch(() => null)
      : null;
    const defaults = clean({
      utm_source: 'facebook_ctwa',
      utm_campaign: ad?.campaignName ?? undefined,
      utm_medium: ad?.adsetName ?? undefined,
      utm_content: ad?.adName ?? undefined,
      utm_id: ad?.campaignId ?? undefined,
    });

    const d = JSON.stringify(defaults);
    const c = JSON.stringify(ctwa);

    try {
      // Contato (CAPI lê daqui).
      await this.prisma.$executeRaw`
        UPDATE contacts SET metadata = jsonb_set(
          CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
          '{tracking}',
          ${d}::jsonb
            || CASE WHEN jsonb_typeof(metadata->'tracking') = 'object' THEN metadata->'tracking' ELSE '{}'::jsonb END
            || ${c}::jsonb,
          true)
        WHERE id = ${contactId} AND organization_id = ${organizationId}`;

      // Card da conversa (dashboard lê daqui). Sem card nessa conversa (lead
      // recorrente), cai no card mais recente do contato.
      const n = await this.prisma.$executeRaw`
        UPDATE cards SET metadata = jsonb_set(
          CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
          '{tracking}',
          ${d}::jsonb
            || CASE WHEN jsonb_typeof(metadata->'tracking') = 'object' THEN metadata->'tracking' ELSE '{}'::jsonb END
            || ${c}::jsonb,
          true)
        WHERE organization_id = ${organizationId} AND conversation_id = ${conversationId}`;
      if (n === 0) {
        await this.prisma.$executeRaw`
          UPDATE cards SET metadata = jsonb_set(
            CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END,
            '{tracking}',
            ${d}::jsonb
              || CASE WHEN jsonb_typeof(metadata->'tracking') = 'object' THEN metadata->'tracking' ELSE '{}'::jsonb END
              || ${c}::jsonb,
            true)
          WHERE id = (
            SELECT id FROM cards
            WHERE organization_id = ${organizationId} AND contact_id = ${contactId}
            ORDER BY created_at DESC LIMIT 1)`;
      }

      this.logger.log(
        `CTWA atribuído contato=${contactId} ad=${ref.sourceId ?? '-'} campanha=${ad?.campaignName ?? '(não resolvida)'}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `CTWA attribution falhou contato=${contactId}: ${err?.message ?? err}`,
      );
    }
  }
}

/** Remove chaves vazias (undefined/null/''). */
function clean(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
