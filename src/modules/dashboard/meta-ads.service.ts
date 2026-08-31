import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHmac } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import {
  decryptString,
  encryptString,
  isEncrypted,
  isEncryptionEnabled,
} from '../../common/crypto/secret-cipher';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface Row {
  ad_account_id: string;
  access_token_enc: string;
  status: string;
  last_error: string | null;
  last_sync_at: Date | null;
}

export interface MetaAdsStatus {
  configured: boolean;
  /** CSV cru como gravado (retrocompat). Prefira adAccountIds. */
  adAccountId: string | null;
  /** Lista normalizada de contas (act_<id>) que a org lê. */
  adAccountIds: string[];
  status: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  encryptedAtRest: boolean;
}

/**
 * Integração Meta Ads POR EMPRESA (leitura de gasto para CAC/ROAS).
 * - Guarda ad_account_id + token (cifrado) em meta_ads_integrations (SQL cru,
 *   evita depender do client Prisma regenerado).
 * - Lê gasto por campanha via Marketing API (own account = standard access,
 *   sem App Review). Best-effort: nunca quebra o dashboard.
 */
@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);
  constructor(private readonly prisma: PrismaService) {}

  private normAct(id: string): string {
    return `act_${String(id ?? '').trim().replace(/^act_/, '')}`;
  }
  /**
   * Divide uma lista de contas (CSV, espaço, ; ou nova linha) em act_<id>
   * únicos e válidos. Uma org pode rodar criativos em várias contas de anúncio
   * (ex: CA, H5) — todas somam pro gasto do dashboard, com o MESMO token.
   */
  private parseAccts(raw: string): string[] {
    const out: string[] = [];
    for (const part of String(raw ?? '').split(/[\s,;]+/)) {
      const act = this.normAct(part.trim());
      if (/^act_\d+$/.test(act) && !out.includes(act)) out.push(act);
    }
    return out;
  }
  private safeDecrypt(v: string): string {
    try {
      return isEncrypted(v) ? decryptString(v) : v;
    } catch {
      return v;
    }
  }
  /**
   * appsecret_proof — exigido quando o app tem "Require App Secret proof for
   * API calls" ligado (trava de segurança). HMAC-SHA256(app_secret, token).
   * Só é incluído quando META_APP_SECRET está setado no ambiente; sem ele as
   * chamadas seguem sem proof (apps que não exigem). Assim não precisamos
   * desligar a trava do app (que é compartilhado com o WhatsApp de produção).
   */
  private proof(token: string): string | undefined {
    const secret = process.env.META_APP_SECRET;
    if (!secret) return undefined;
    return createHmac('sha256', secret).update(token).digest('hex');
  }

  private async row(organizationId: string): Promise<Row | null> {
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT ad_account_id, access_token_enc, status, last_error, last_sync_at
      FROM meta_ads_integrations WHERE organization_id = ${organizationId} LIMIT 1`;
    return rows[0] ?? null;
  }

  async getStatus(organizationId: string): Promise<MetaAdsStatus> {
    const r = await this.row(organizationId);
    return {
      configured: !!r,
      adAccountId: r?.ad_account_id ?? null,
      adAccountIds: r ? this.parseAccts(r.ad_account_id) : [],
      status: r?.status ?? null,
      lastError: r?.last_error ?? null,
      lastSyncAt: r?.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
      encryptedAtRest: isEncryptionEnabled(),
    };
  }

  async setConfig(
    organizationId: string,
    input: { adAccountId: string; accessToken: string },
  ): Promise<MetaAdsStatus> {
    const accts = this.parseAccts(input.adAccountId);
    const token = String(input.accessToken ?? '').trim();
    if (!token) throw new BadRequestException('Token obrigatório.');
    if (accts.length === 0) {
      throw new BadRequestException(
        'Informe ao menos um ID de conta de anúncios (só o número; separe várias por vírgula).',
      );
    }
    const proof = this.proof(token);
    // Valida token + acesso a CADA conta com uma chamada mínima. Se qualquer
    // uma falhar, aborta com a mensagem da conta problemática (não grava nada).
    for (const act of accts) {
      try {
        await axios.get(`${GRAPH}/${act}`, {
          params: {
            fields: 'name,currency',
            access_token: token,
            ...(proof ? { appsecret_proof: proof } : {}),
          },
          timeout: 15000,
        });
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || 'erro';
        throw new BadRequestException(`Não consegui acessar ${act}: ${msg}`);
      }
    }
    const joined = accts.join(',');
    const enc = encryptString(token);
    await this.prisma.$executeRaw`
      INSERT INTO meta_ads_integrations (organization_id, ad_account_id, access_token_enc, status, updated_at)
      VALUES (${organizationId}, ${joined}, ${enc}, 'active', now())
      ON CONFLICT (organization_id) DO UPDATE SET
        ad_account_id = EXCLUDED.ad_account_id,
        access_token_enc = EXCLUDED.access_token_enc,
        status = 'active',
        last_error = NULL,
        updated_at = now()`;
    this.logger.log(
      `Meta Ads configurada p/ org ${organizationId} (${accts.length} conta(s): ${joined})`,
    );
    return this.getStatus(organizationId);
  }

  async clearConfig(organizationId: string): Promise<MetaAdsStatus> {
    await this.prisma.$executeRaw`DELETE FROM meta_ads_integrations WHERE organization_id = ${organizationId}`;
    return this.getStatus(organizationId);
  }

  /**
   * Gasto no período: total + por nome de campanha. null = não configurado ou
   * falha (o dashboard segue sem gasto). Best-effort.
   */
  async getSpend(
    organizationId: string,
    range: { from: Date; to: Date },
  ): Promise<{ total: number; byCampaign: Record<string, number> } | null> {
    const r = await this.row(organizationId);
    if (!r || r.status !== 'active') return null;
    const accts = this.parseAccts(r.ad_account_id);
    if (accts.length === 0) return null;
    const token = this.safeDecrypt(r.access_token_enc);
    const proof = this.proof(token);
    const since = range.from.toISOString().slice(0, 10);
    const until = range.to.toISOString().slice(0, 10);

    let total = 0;
    const byCampaign: Record<string, number> = {};
    const errors: string[] = [];
    let anyOk = false;

    // Agrega o gasto de TODAS as contas da org (mesmo token). Falha numa conta
    // não derruba as outras — best-effort, o dashboard nunca quebra por isso.
    for (const act of accts) {
      try {
        let url: string | null = `${GRAPH}/${act}/insights`;
        let params: Record<string, unknown> | undefined = {
          level: 'campaign',
          fields: 'campaign_name,spend',
          time_range: JSON.stringify({ since, until }),
          access_token: token,
          limit: 500,
          ...(proof ? { appsecret_proof: proof } : {}),
        };
        let guard = 0;
        while (url && guard < 25) {
          guard += 1;
          const resp: any = await axios.get(url, { params, timeout: 20000 });
          // paging.next já traz access_token + filtros; só re-anexa o proof.
          params = proof ? { appsecret_proof: proof } : undefined;
          for (const d of resp.data?.data ?? []) {
            const spend = parseFloat(d.spend ?? '0') || 0;
            total += spend;
            const name = d.campaign_name || '(sem nome)';
            byCampaign[name] = (byCampaign[name] ?? 0) + spend;
          }
          url = resp.data?.paging?.next ?? null;
        }
        anyOk = true;
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message || 'erro';
        errors.push(`${act}: ${msg}`);
        this.logger.warn(
          `Meta insights falhou (org ${organizationId}, ${act}): ${msg}`,
        );
      }
    }

    // Nenhuma conta respondeu = falha real: marca erro e devolve null.
    if (!anyOk) {
      await this.prisma
        .$executeRaw`UPDATE meta_ads_integrations SET last_error = ${errors.join(' | ').slice(0, 500)}, status = 'error' WHERE organization_id = ${organizationId}`
        .catch(() => undefined);
      return null;
    }
    // Sucesso total ou parcial: grava sync; erro de conta vira aviso (não bloqueia).
    await this.prisma
      .$executeRaw`UPDATE meta_ads_integrations SET last_sync_at = now(), last_error = ${errors.length ? errors.join(' | ').slice(0, 500) : null}, status = 'active' WHERE organization_id = ${organizationId}`
      .catch(() => undefined);
    return { total: Math.round(total * 100) / 100, byCampaign };
  }
}
