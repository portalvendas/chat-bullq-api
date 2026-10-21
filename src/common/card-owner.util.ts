import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

const logger = new Logger('card-owner');

/**
 * REGRA: conversa e card do MESMO lead têm o MESMO vendedor.
 *
 * Conversa → card: quando a conversa ganha/troca de responsável (vendedor
 * respondeu, transferência manual, roteamento), os cards ABERTOS do contato
 * que pertencem a esse atendimento passam a ter o mesmo vendedor:
 *  - o card vinculado a esta conversa;
 *  - cards do contato sem conversa vinculada (ex.: card da LP criado antes);
 *  - cards do contato ainda sem vendedor.
 * Cards vinculados a OUTRA conversa (ex.: card do Marketplace com a conversa
 * do Mercado Livre) não são tocados. Ganhos/perdidos mantêm o vendedor
 * histórico. Idempotente e best-effort (nunca lança).
 *
 *   syncCardsWithConversation(prisma, org, 'conv1', 'contact1', 'userKelen') → 1
 */
export async function syncCardsWithConversation(
  prisma: PrismaService,
  organizationId: string,
  conversationId: string | null | undefined,
  contactId: string | null | undefined,
  userId: string | null | undefined,
): Promise<number> {
  if (!contactId || !userId) return 0;
  try {
    const sameLead: Prisma.CardWhereInput[] = [{ conversationId: null }, { assignedToId: null }];
    if (conversationId) sameLead.push({ conversationId });
    const res = await prisma.card.updateMany({
      where: {
        organizationId,
        contactId,
        status: 'OPEN',
        AND: [
          { OR: sameLead },
          { OR: [{ assignedToId: null }, { assignedToId: { not: userId } }] },
        ],
      },
      data: { assignedToId: userId },
    });
    if (res.count > 0) {
      logger.log(
        `card_sincronizado_com_conversa conv=${conversationId ?? '-'} contato=${contactId} user=${userId} cards=${res.count}`,
      );
    }
    return res.count;
  } catch (err: any) {
    logger.warn(`syncCardsWithConversation falhou (contato=${contactId}): ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * Card → conversa: quando o vendedor do card muda (kanban), a conversa do lead
 * segue junto — a vinculada ao card ou, sem vínculo, as conversas ABERTAS do
 * contato. Registra a troca no histórico da conversa.
 */
export async function syncConversationsWithCard(
  prisma: PrismaService,
  organizationId: string,
  card: { conversationId: string | null; contactId: string | null },
  userId: string | null | undefined,
  actorId?: string | null,
): Promise<number> {
  if (!userId || (!card.conversationId && !card.contactId)) return 0;
  try {
    const convs = await prisma.conversation.findMany({
      where: {
        organizationId,
        ...(card.conversationId
          ? { id: card.conversationId }
          : { contactId: card.contactId!, status: { not: 'CLOSED' }, isGroup: false }),
        OR: [{ assignedToId: null }, { assignedToId: { not: userId } }],
      },
      select: { id: true, assignedToId: true },
    });
    for (const cv of convs) {
      await prisma.conversation.update({ where: { id: cv.id }, data: { assignedToId: userId } });
      await prisma.conversationAuditLog
        .create({
          data: {
            conversationId: cv.id,
            actorId: actorId ?? null,
            action: 'ASSIGNED',
            fromValue: cv.assignedToId,
            toValue: userId,
            metadata: { source: 'card_owner_sync' },
          },
        })
        .catch(() => undefined);
    }
    if (convs.length) {
      logger.log(`conversa_sincronizada_com_card convs=${convs.length} user=${userId}`);
    }
    return convs.length;
  } catch (err: any) {
    logger.warn(`syncConversationsWithCard falhou: ${err?.message ?? err}`);
    return 0;
  }
}
