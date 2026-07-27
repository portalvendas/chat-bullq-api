import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
  async seedApproved(
    organizationId: string,
  ): Promise<{ seeded: number; skipped: number }> {
    const seen = new Set<string>();
    let seeded = 0;
    let skipped = 0;
    for (const t of WA_TEMPLATE_SEED) {
      let name = t.name;
      let n = 2;
      while (seen.has(`${t.waba}|${name}`)) name = `${t.name} (${n++})`;
      seen.add(`${t.waba}|${name}`);

      // findFirst + create (idempotente) — evita qualquer particularidade do
      // upsert por chave composta com coluna anulável.
      const exists = await this.prisma.whatsappTemplate.findFirst({
        where: { organizationId, waba: t.waba, name, language: 'pt_BR' },
        select: { id: true },
      });
      if (exists) {
        skipped++;
        continue;
      }
      await this.prisma.whatsappTemplate.create({
        data: {
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
      });
      seeded++;
    }
    this.logger.log(
      `Seed de templates: ${seeded} criados, ${skipped} já existiam (org ${organizationId})`,
    );
    return { seeded, skipped };
  }

  /** Normaliza o nome para o padrão da Meta: minúsculas, snake_case, [a-z0-9_]. */
  private toMetaName(name: string): string {
    return (
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove acentos
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 480) || 'template'
    );
  }

  /** Acha um canal WHATSAPP_OFFICIAL da org compatível com o WABA do template. */
  private async pickChannel(organizationId: string, waba?: string | null) {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, type: 'WHATSAPP_OFFICIAL' },
    });
    if (channels.length === 0) return null;
    if (waba) {
      const match = channels.find(
        (c) => (c.config as any)?.businessAccountId === waba,
      );
      if (match) return match;
    }
    return channels[0];
  }

  /**
   * Submete um template à Meta para aprovação (`POST /{waba}/message_templates`).
   * Requer um canal WhatsApp oficial conectado (token + WABA). Marca o template
   * como PENDING e guarda o metaName/externalId. O resultado da revisão volta
   * depois pelo `syncFromMeta`.
   *
   * Payload de exemplo enviado à Meta:
   *   { name: "bm02_fup_automatico_1", language: "pt_BR", category: "MARKETING",
   *     components: [{ type: "BODY", text: "Oie! Consegue conversar agora?" }] }
   */
  async submitToMeta(
    id: string,
    organizationId: string,
  ): Promise<{ status: string; metaName: string; externalId?: string }> {
    const tpl = await this.prisma.whatsappTemplate.findUnique({ where: { id } });
    if (!tpl || tpl.organizationId !== organizationId) {
      throw new NotFoundException('Template não encontrado');
    }
    const channel = await this.pickChannel(organizationId, tpl.waba);
    if (!channel) {
      throw new BadRequestException(
        'Nenhum canal WhatsApp oficial conectado para submeter à Meta.',
      );
    }
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const waba = cfg.businessAccountId;
    const token = cfg.accessToken;
    const ver = cfg.apiVersion || 'v21.0';
    if (!waba || !token) {
      throw new BadRequestException(
        'Canal sem businessAccountId/accessToken configurado.',
      );
    }

    const metaName = tpl.metaName || this.toMetaName(tpl.name);
    const existingComponents = Array.isArray(tpl.components)
      ? (tpl.components as any[])
      : [];
    const hasBody = existingComponents.some((c) => c?.type === 'BODY');
    const components = hasBody
      ? existingComponents
      : [{ type: 'BODY', text: tpl.bodyText }];

    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/${ver}/${waba}/message_templates`,
        {
          name: metaName,
          language: tpl.language,
          category: tpl.category,
          components,
        },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 },
      );
      const status = (data?.status as string) || 'PENDING';
      await this.prisma.whatsappTemplate.update({
        where: { id },
        data: {
          metaName,
          externalId: data?.id ? String(data.id) : tpl.externalId,
          channelId: channel.id,
          waba,
          status,
          rejectionReason: null,
        },
      });
      this.logger.log(
        `Template "${tpl.name}" submetido à Meta como "${metaName}" (status ${status})`,
      );
      return { status, metaName, externalId: data?.id ? String(data.id) : undefined };
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.error_user_msg ??
        err?.response?.data?.error?.message ??
        err?.message ??
        'erro ao submeter';
      this.logger.warn(`Submit à Meta falhou (template ${id}): ${msg}`);
      throw new BadRequestException(`Meta recusou a submissão: ${msg}`);
    }
  }

  /**
   * Saúde dos números WhatsApp: quality rating e limite de mensagens, lidos ao
   * vivo da Graph API (`GET /{phoneNumberId}?fields=quality_rating,...`).
   */
  async channelHealth(organizationId: string) {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, type: 'WHATSAPP_OFFICIAL' },
    });
    const result: Array<Record<string, any>> = [];
    for (const ch of channels) {
      const cfg = (ch.config ?? {}) as Record<string, any>;
      const phone = cfg.phoneNumberId;
      const token = cfg.accessToken;
      const ver = cfg.apiVersion || 'v21.0';
      if (!phone || !token) {
        result.push({ channelId: ch.id, name: ch.name, error: 'sem phoneNumberId/token' });
        continue;
      }
      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/${ver}/${phone}`,
          {
            params: {
              fields:
                'display_phone_number,verified_name,quality_rating,messaging_limit_tier,name_status',
            },
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20000,
          },
        );
        result.push({
          channelId: ch.id,
          name: ch.name,
          phone: data.display_phone_number,
          verifiedName: data.verified_name,
          qualityRating: data.quality_rating,
          messagingLimit: data.messaging_limit_tier,
          nameStatus: data.name_status,
        });
      } catch (err: any) {
        const msg =
          err?.response?.data?.error?.message ?? err?.message ?? 'erro';
        result.push({ channelId: ch.id, name: ch.name, error: msg });
      }
    }
    return { channels: result };
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
        let nextUrl: string | null = `https://graph.facebook.com/${ver}/${waba}/message_templates?limit=100&fields=name,status,category,language,components,id,rejected_reason`;
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
            const language = t.language ?? 'pt_BR';
            const externalId = String(t.id ?? '');
            // Casa por externalId (submetidos por nós), senão pelo nome normalizado
            // que a Meta usa (metaName), senão pelo nome exato.
            const existing = await this.prisma.whatsappTemplate.findFirst({
              where: {
                organizationId,
                OR: [
                  ...(externalId ? [{ externalId }] : []),
                  { waba, metaName: t.name, language },
                  { waba, name: t.name, language },
                ],
              },
              select: { id: true },
            });
            const dataCommon = {
              channelId: ch.id,
              externalId,
              metaName: t.name,
              status: t.status ?? 'APPROVED',
              category: t.category ?? 'MARKETING',
              bodyText: body,
              rejectionReason: t.rejected_reason ?? null,
              components: (t.components ?? []) as Prisma.InputJsonValue,
              source: 'META_SYNC',
            };
            if (existing) {
              await this.prisma.whatsappTemplate.update({
                where: { id: existing.id },
                data: dataCommon,
              });
            } else {
              await this.prisma.whatsappTemplate.create({
                data: {
                  organizationId,
                  name: t.name,
                  language,
                  waba,
                  ...dataCommon,
                },
              });
            }
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
