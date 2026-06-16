import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface CatalogEntry {
  slug: string;
  name: string;
  category: string | null;
  shortLine: string;
}

interface CacheEntry {
  data: CatalogEntry[];
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the compact sales catalog from Trivapp and caches it in memory.
 * The compact list is injected into every agent's system prompt as a
 * cacheable block — TTL of 5min keeps token cost predictable while
 * letting offer edits reach the agent within minutes.
 *
 * One cache entry per organizationId. When Chat BullQ becomes truly
 * multi-tenant (each org has its own MEMBERS_TENANT_*), this will need
 * a per-org mapping; today it falls back to the single Bravy tenant.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger(CatalogSyncService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService) {}

  async getCompactCatalog(organizationId: string): Promise<CatalogEntry[]> {
    const cached = this.cache.get(organizationId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const baseUrl =
      this.config.get<string>('MEMBERS_TRIVAPP_URL') ??
      'https://api.trivapp.com.br';
    const apiKey = this.config.get<string>('MEMBERS_ADMIN_KEY');
    const tenantId = this.config.get<string>('MEMBERS_TENANT_BRAVY');

    if (!apiKey || !tenantId) {
      // No creds configured → behave as empty catalog (agent prompt
      // simply omits the product section).
      return [];
    }

    try {
      const resp = await axios.get<CatalogEntry[]>(
        `${baseUrl}/api/v1/catalog`,
        {
          headers: {
            'x-admin-api-key': apiKey,
            'x-tenant-id': tenantId,
            'Content-Type': 'application/json',
          },
          timeout: 8_000,
        },
      );
      const data = Array.isArray(resp.data) ? resp.data : [];
      this.cache.set(organizationId, {
        data,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return data;
    } catch (err: any) {
      this.logger.warn(
        `Catalog sync failed for org ${organizationId}: ${err?.message ?? err}`,
      );
      // Serve stale cache if we have one — better than empty during
      // transient Trivapp downtime.
      if (cached) return cached.data;
      return [];
    }
  }

  /** Force-invalidate the cache (e.g. after editing an Offer). */
  invalidate(organizationId: string) {
    this.cache.delete(organizationId);
  }
}
