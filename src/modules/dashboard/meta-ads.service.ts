import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
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
  adAccountId: string | null;
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
  private safeDecrypt(v: string): string {
    try {
      return isEncrypted(v) ? decryptString(v) : v;
    } catch {
      return v;
    }
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
    const act = this.normAct(input.adAccountId);
    const token = String(input.accessToken ?? '').trim();
    if (!token) throw new BadRequestException('Token obrigatório.');
    if (!/^act_\d+$/.test(act)) {
      throw new BadRequestException('ID da conta de anúncios inválido (use só o número).');
    }
    // Valida token + acesso à conta com uma chamada mínima.
    try {
      await axios.get(`${GRAPH}/${act}`, {
        params: { fields: 'name,currency', access_token: token },
        timeout: 15000,
      });
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || 'erro';
      throw new BadRequestException(`Não consegui acessar ${act}: ${msg}`);
    }
    const enc = encryptString(token);
    await this.prisma.$executeRaw`
      INSERT INTO meta_ads_integrations (organization_id, ad_account_id, access_token_enc, status, updated_at)
      VALUES (${organizationId}, ${act}, ${enc}, 'active', now())
      ON CONFLICT (organization_id) DO UPDATE SET
        ad_account_id = EXCLUDED.ad_account_id,
        access_token_enc = EXCLUDED.access_token_enc,
        status = 'active',
        last_error = NULL,
        updated_at = now()`;
    this.logger.log(`Meta Ads configurada p/ org ${organizationId} (${act})`);
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
    const token = this.safeDecrypt(r.access_token_enc);
    const since = range.from.toISOString().slice(0, 10);
    const until = range.to.toISOString().slice(0, 10);
    try {
      let url: string | null = `${GRAPH}/${r.ad_account_id}/insights`;
      let params: Record<string, unknown> | undefined = {
        level: 'campaign',
        fields: 'campaign_name,spend',
        time_range: JSON.stringify({ since, until }),
        access_token: token,
        limit: 500,
      };
      let total = 0;
      const byCampaign: Record<string, number> = {};
      let guard = 0;
      while (url && guard < 25) {
        guard += 1;
        const resp: any = await axios.get(url, { params, timeout: 20000 });
        params = undefined; // paging.next já traz tudo
        for (const d of resp.data?.data ?? []) {
          const spend = parseFloat(d.spend ?? '0') || 0;
          total += spend;
          const name = d.campaign_name || '(sem nome)';
          byCampaign[name] = (byCampaign[name] ?? 0) + spend;
        }
        url = resp.data?.paging?.next ?? null;
      }
      await this.prisma
        .$executeRaw`UPDATE meta_ads_integrations SET last_sync_at = now(), last_error = NULL WHERE organization_id = ${organizationId}`
        .catch(() => undefined);
      return { total: Math.round(total * 100) / 100, byCampaign };
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || 'erro';
      this.logger.warn(`Meta insights falhou (org ${organizationId}): ${msg}`);
      await this.prisma
        .$executeRaw`UPDATE meta_ads_integrations SET last_error = ${String(msg).slice(0, 500)}, status = 'error' WHERE organization_id = ${organizationId}`
        .catch(() => undefined);
      return null;
    }
  }
}
