import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../database/prisma.service';
import { WA_TEMPLATE_SEED } from './whatsapp-templates.seed';

export interface ListTemplatesQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: string;
  waba?: string;
}

export interface TemplateInput {
  name: string;
  bodyText: string;
  waba?: string | null;
  status?: string;
  category?: string;
  language?: string;
  components?: unknown;
}

/**
 * Templates de mensagem do WhatsApp (HSM). Fonte de verdade: Graph API da Meta
 * (`GET /{waba}/message_templates`), sincronizada por canal WHATSAPP_OFFICIAL.
 * Também aceita seed dos aprovados e CRUD manual.
 */
@Injectable()
export class WhatsappTemplatesService {
  private readonly logger = new Logger(WhatsappTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Lista paginada (offset). Ordena por WABA e nome, como no Kommo. */
  async list(organizationId: string, q: ListTemplatesQuery) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const where: Prisma.WhatsappTemplateWhereInput = {
      organizationId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.waba ? { waba: q.waba } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { bodyText: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.whatsappTemplate.findMany({
        where,
        orderBy: [{ waba: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.whatsappTemplate.count({ where }),
    ]);
    return { items, total, page, pageSize, pages: Math.ceil(total / pageSize) };
  }

  /** Resumo por status/WABA para os cabeçalhos/badges da tela. */
  async summary(organizationId: string) {
    const byStatus = await this.prisma.whatsappTemplate.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { _all: true },
    });
    const total = byStatus.reduce((s, r) => s + r._count._all, 0);
    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    };
  }

  create(organizationId: string, dto: TemplateInput) {
    return this.prisma.whatsappTemplate.create({
      data: {
        organizationId,
        name: dto.name,
        bodyText: dto.bodyText,
        waba: dto.waba ?? null,
        status: dto.status ?? 'APPROVED',
        category: dto.category ?? 'MARKETING',
        language: dto.language ?? 'pt_BR',
        components:
          (dto.components as Prisma.InputJsonValue) ??
          ([{ type: 'BODY', text: dto.bodyText }] as Prisma.InputJsonValue),
        source: 'MANUAL',
      },
    });
  }

  async update(id: string, organizationId: string, dto: Partial<TemplateInput>) {
    const t = await this.prisma.whatsappTemplate.findUnique({ where: { id } });
    if (!t || t.organizationId !== organizationId) {
      throw new NotFoundException('Template não encontrado');
    }
    return this.prisma.whatsappTemplate.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.bodyText !== undefined ? { bodyText: dto.bodyText } : {}),
        ...(dto.waba !== undefined ? { waba: dto.waba } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    const t = await this.prisma.whatsappTemplate.findUnique({ where: { id } });
    if (!t || t.organizationId !== organizationId) {
      throw new NotFoundException('Template não encontrado');
    }
    await this.prisma.whatsappTemplate.delete({ where: { id } });
  }

  /**
   * Popula a tela com os templates aprovados (seed). Idempotente: usa upsert
   * pela chave (org, waba, name, language) e desambigua nomes repetidos no
   * mesmo WABA (rascunhos do Kommo).
   */
  async seedApproved(organizationId: string): Promise<{ seeded: number }> {
    const seen = new Set<string>();
    let seeded = 0;
    for (const t of WA_TEMPLATE_SEED) {
      let name = t.name;
      let n = 2;
      while (seen.has(`${t.waba}|${name}`)) name = `${t.name} (${n++})`;
      seen.add(`${t.waba}|${name}`);
      await this.prisma.whatsappTemplate.upsert({
        where: {
          uq_wa_template: {
            organizationId,
            waba: t.waba,
            name,
            language: 'pt_BR',
          },
        },
        create: {
          organizationId,
          name,
          waba: t.waba,
          bodyText: t.bodyText,
          status: 'APPROVED',
          category: 'MARKETING',
          language: 'pt_BR',
          source: 'SEED',
          components: [{ type: 'BODY', text: t.bodyText }],
        },
        update: {},
      });
      seeded++;
    }
    this.logger.log(`Seed de ${seeded} templates aprovados (org ${organizationId})`);
    return { seeded };
  }

  /**
   * Sincroniza com a Meta: para cada canal WHATSAPP_OFFICIAL da org, busca os
   * templates na Graph API e faz upsert. Best-effort por canal — falha de um
   * não derruba os demais.
   */
  async syncFromMeta(organizationId: string): Promise<{
    synced: number;
    channels: number;
    errors: Array<{ channelId: string; error: string }>;
  }> {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, type: 'WHATSAPP_OFFICIAL' },
    });
    let synced = 0;
    const errors: Array<{ channelId: string; error: string }> = [];

    for (const ch of channels) {
      const cfg = (ch.config ?? {}) as Record<string, any>;
      const waba = cfg.businessAccountId;
      const token = cfg.accessToken;
      const ver = cfg.apiVersion || 'v21.0';
      if (!waba || !token) {
        errors.push({ channelId: ch.id, error: 'canal sem businessAccountId/accessToken' });
        continue;
      }
      try {
        let nextUrl: string | null = `https://graph.facebook.com/${ver}/${waba}/message_templates?limit=100&fields=name,status,category,language,components,id`;
        while (nextUrl) {
          const resp = await axios.get(nextUrl, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 30000,
          });
          const payload = resp.data as {
            data?: any[];
            paging?: { next?: string };
          };
          for (const t of payload.data ?? []) {
            const body =
              (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '';
            await this.prisma.whatsappTemplate.upsert({
              where: {
                uq_wa_template: {
                  organizationId,
                  waba,
                  name: t.name,
                  language: t.language,
                },
              },
              create: {
                organizationId,
                channelId: ch.id,
                externalId: String(t.id ?? ''),
                name: t.name,
                status: t.status ?? 'APPROVED',
                category: t.category ?? 'MARKETING',
                language: t.language ?? 'pt_BR',
                waba,
                bodyText: body,
                components: (t.components ?? []) as Prisma.InputJsonValue,
                source: 'META_SYNC',
              },
              update: {
                channelId: ch.id,
                externalId: String(t.id ?? ''),
                status: t.status ?? 'APPROVED',
                category: t.category ?? 'MARKETING',
                bodyText: body,
                components: (t.components ?? []) as Prisma.InputJsonValue,
                source: 'META_SYNC',
              },
            });
            synced++;
          }
          nextUrl = payload.paging?.next ?? null;
        }
      } catch (err: any) {
        const msg =
          err?.response?.data?.error?.message ?? err?.message ?? 'erro desconhecido';
        this.logger.warn(`Sync Meta falhou (canal ${ch.id}): ${msg}`);
        errors.push({ channelId: ch.id, error: msg });
      }
    }
    return { synced, channels: channels.length, errors };
  }
}
