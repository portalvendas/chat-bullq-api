import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service';

const logger = new Logger('card-owner');

/**
 * Card do lead herda o vendedor da CONVERSA.
 *
 * Quando a conversa ganha um responsável (vendedor respondeu, atribuição
 * manual, roteamento), os cards ABERTOS e SEM vendedor do mesmo contato passam
 * a ter esse vendedor. Nunca troca o dono de um card que já tem vendedor.
 * Idempotente e best-effort (nunca lança).
 *
 * Fecha o buraco em que a conversa tinha dono e o card do funil ficava sem —
 * o lead sumia das métricas por vendedor.
 *
 *   inheritCardOwner(prisma, 'org1', 'contact1', 'userGabi') → 1 (cards atualizados)
 */
export async function inheritCardOwner(
  prisma: PrismaService,
  organizationId: string,
  contactId: string | null | undefined,
  userId: string | null | undefined,
): Promise<number> {
  if (!contactId || !userId) return 0;
  try {
    const res = await prisma.card.updateMany({
      where: { organizationId, contactId, assignedToId: null, status: 'OPEN' },
      data: { assignedToId: userId },
    });
    if (res.count > 0) {
      logger.log(`card_herdou_vendedor contato=${contactId} user=${userId} cards=${res.count}`);
    }
    return res.count;
  } catch (err: any) {
    logger.warn(`inheritCardOwner falhou (contato=${contactId}): ${err?.message ?? err}`);
    return 0;
  }
}
