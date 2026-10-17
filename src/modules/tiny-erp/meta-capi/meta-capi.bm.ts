import { PrismaService } from '../../../database/prisma.service';

/** Janela do clique CTWA aceita pela Meta para eventos de business messaging. */
export const CTWA_WINDOW_MS = 7 * 24 * 3600 * 1000;

export interface BusinessMessagingContext {
  wabaId: string;
  ctwaClid: string;
}

/**
 * Contexto para enviar um evento CAPI como `business_messaging` (lead que
 * chegou clicando em anúncio de WhatsApp — Click-to-WhatsApp).
 *
 * Exige: `ctwa_clid` no tracking do contato, clique há no máximo 7 dias
 * (`ctwa_at`) e uma conversa do contato num canal WhatsApp OFICIAL com a WABA
 * conhecida (`config.businessAccountId`). Sem qualquer um → null (o chamador
 * usa o formato padrão).
 *
 * Entrada (tracking): { ctwa_clid: "ARAk…", ctwa_at: "2026-10-16T12:00:00Z" }
 * Saída: { wabaId: "1234567890", ctwaClid: "ARAk…" }
 */
export async function businessMessagingContext(
  prisma: PrismaService,
  contactId: string,
  tr: Record<string, any> | null | undefined,
): Promise<BusinessMessagingContext | null> {
  const clid = typeof tr?.ctwa_clid === 'string' ? tr.ctwa_clid.trim() : '';
  if (!clid) return null;
  const at = tr?.ctwa_at ? Date.parse(tr.ctwa_at) : NaN;
  if (!Number.isFinite(at) || Date.now() - at > CTWA_WINDOW_MS) return null;

  const conv = await prisma.conversation.findFirst({
    where: { contactId, channel: { type: 'WHATSAPP_OFFICIAL' } },
    orderBy: { lastMessageAt: 'desc' },
    select: { channelId: true },
  });
  if (!conv) return null;

  // Busca o canal no topo (a extensão do Prisma decifra o config).
  const channel = await prisma.channel.findUnique({
    where: { id: conv.channelId },
    select: { config: true },
  });
  const wabaId = String(((channel?.config as any) ?? {}).businessAccountId ?? '').trim();
  if (!wabaId) return null;
  return { wabaId, ctwaClid: clid };
}
