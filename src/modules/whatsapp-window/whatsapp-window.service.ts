import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export const WA_WINDOW_QUEUE = 'whatsapp-window';
export const WA_WINDOW_SCAN_JOB = 'wa-window-scan';

/** Nome/cor da tag aplicada em conversas fora da janela de 24h. */
export const WA_WINDOW_TAG_NAME = '+24h';
const WA_WINDOW_TAG_COLOR = '#ef4444';

/**
 * Marca com a tag "+24h" as conversas de WhatsApp Oficial que saíram da janela
 * de atendimento de 24h (última mensagem do CLIENTE há +24h) — nelas só dá pra
 * mandar TEMPLATE aprovado, não texto livre. Remove a tag quando o cliente
 * responde (janela reabre). Rodado por cron + em tempo real no inbound.
 */
@Injectable()
export class WhatsappWindowService {
  private readonly logger = new Logger(WhatsappWindowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Remove a tag +24h da conversa (janela reaberta). Best-effort. */
  async clearWindowTag(conversationId: string): Promise<void> {
    try {
      await this.prisma.conversationTag.deleteMany({
        where: { conversationId, tag: { name: WA_WINDOW_TAG_NAME } },
      });
    } catch (err: any) {
      this.logger.warn(`clearWindowTag falhou (${conversationId}): ${err?.message}`);
    }
  }

  /** Varredura: aplica/remove a tag conforme a janela de 24h. */
  async scan(): Promise<{ tagged: number; untagged: number }> {
    // Conversas WHATSAPP_OFFICIAL abertas, última inbound há +24h e SEM a tag.
    const toTag = await this.prisma.$queryRawUnsafe<
      { id: string; organization_id: string }[]
    >(
      `SELECT c.id, c.organization_id
         FROM conversations c
         JOIN channels ch ON ch.id = c.channel_id AND ch.type = 'WHATSAPP_OFFICIAL'
        WHERE c.deleted_at IS NULL AND c.status <> 'CLOSED'
          AND (SELECT max(m.created_at) FROM messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')
              < now() - interval '24 hours'
          AND NOT EXISTS (
                SELECT 1 FROM conversation_tags ctg
                  JOIN tags t ON t.id = ctg.tag_id
                 WHERE ctg.conversation_id = c.id AND t.name = $1)
        LIMIT 3000`,
      WA_WINDOW_TAG_NAME,
    );

    let tagged = 0;
    if (toTag.length) {
      const byOrg = new Map<string, string[]>();
      for (const r of toTag) {
        const arr = byOrg.get(r.organization_id) ?? [];
        arr.push(r.id);
        byOrg.set(r.organization_id, arr);
      }
      for (const [orgId, convIds] of byOrg) {
        const tag = await this.prisma.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name: WA_WINDOW_TAG_NAME } },
          create: { organizationId: orgId, name: WA_WINDOW_TAG_NAME, color: WA_WINDOW_TAG_COLOR },
          update: {},
        });
        const res = await this.prisma.conversationTag.createMany({
          data: convIds.map((id) => ({ conversationId: id, tagId: tag.id })),
          skipDuplicates: true,
        });
        tagged += res.count;
      }
    }

    // Conversas COM a tag cuja última inbound voltou pra dentro das 24h → remove.
    const toUntag = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT c.id
         FROM conversations c
         JOIN conversation_tags ctg ON ctg.conversation_id = c.id
         JOIN tags t ON t.id = ctg.tag_id AND t.name = $1
        WHERE (SELECT max(m.created_at) FROM messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')
              >= now() - interval '24 hours'
        LIMIT 3000`,
      WA_WINDOW_TAG_NAME,
    );
    let untagged = 0;
    if (toUntag.length) {
      const r = await this.prisma.conversationTag.deleteMany({
        where: {
          conversationId: { in: toUntag.map((x) => x.id) },
          tag: { name: WA_WINDOW_TAG_NAME },
        },
      });
      untagged = r.count;
    }

    if (tagged || untagged) {
      this.logger.log(`wa_window_scan tagged=${tagged} untagged=${untagged}`);
    }
    return { tagged, untagged };
  }
}
