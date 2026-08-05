import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

interface MergePair {
  channelId: string;
  lid: string;
  phone: string;
  survivorContactId: string; // contato do número (rico: nome/telefone/histórico)
  absorbedContactId: string; // contato do LID (echoes/broadcast)
}

export interface MergeSummary {
  channels: number;
  pairsFound: number;
  merged: number;
  cardsAbsorbed: number;
  errors: { pair: string; error: string }[];
  preview: { lid: string; phone: string }[];
}

/**
 * Une os contatos duplicados do WhatsApp criados pelo problema do LID
 * (número real x `<LID>@lid`). O `chatLid` de cada mensagem inbound liga o
 * número ao LID (guardado nos webhook_events). Sobrevive o contato do NÚMERO
 * (mais rico), re-chaveado para o LID (assim novas mensagens já caem nele).
 *
 * Roda em modo PRÉVIA por padrão; só executa com execute=true.
 */
@Injectable()
export class WhatsappMergeService {
  private readonly logger = new Logger(WhatsappMergeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async run(
    organizationId: string,
    execute = false,
  ): Promise<MergeSummary> {
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, type: 'WHATSAPP_ZAPI' as any },
      select: { id: true },
    });

    const summary: MergeSummary = {
      channels: channels.length,
      pairsFound: 0,
      merged: 0,
      cardsAbsorbed: 0,
      errors: [],
      preview: [],
    };

    for (const channel of channels) {
      // lid -> phone a partir dos eventos inbound (que trazem os dois).
      const rows = await this.prisma.$queryRaw<
        { lid: string; phone: string }[]
      >`
        select distinct
          regexp_replace(raw_payload->>'chatLid', '[^0-9]', '', 'g') as lid,
          regexp_replace(raw_payload->>'phone', '[^0-9]', '', 'g') as phone
        from webhook_events
        where channel_id = ${channel.id}
          and raw_payload->>'chatLid' is not null
          and raw_payload->>'phone' not like '%@lid%'
          and coalesce((raw_payload->>'isGroup')::boolean, false) = false
      `;

      for (const { lid, phone } of rows) {
        if (!lid || !phone || lid === phone) continue;

        const [lidCC, phoneCC] = await Promise.all([
          this.prisma.contactChannel.findUnique({
            where: {
              uq_contact_channel_external: { channelId: channel.id, externalId: lid },
            },
          }),
          this.prisma.contactChannel.findUnique({
            where: {
              uq_contact_channel_external: { channelId: channel.id, externalId: phone },
            },
          }),
        ]);
        if (!lidCC || !phoneCC || lidCC.contactId === phoneCC.contactId) continue;

        summary.pairsFound += 1;
        if (summary.preview.length < 100) summary.preview.push({ lid, phone });
        if (!execute) continue;

        try {
          const absorbedCards = await this.mergePair({
            channelId: channel.id,
            lid,
            phone,
            survivorContactId: phoneCC.contactId,
            absorbedContactId: lidCC.contactId,
          });
          summary.merged += 1;
          summary.cardsAbsorbed += absorbedCards;
        } catch (err: any) {
          summary.errors.push({ pair: `${lid}/${phone}`, error: err?.message });
          this.logger.error(
            `merge falhou (${lid}/${phone}): ${err?.message}`,
          );
        }
      }
    }

    return summary;
  }

  /** Une o par num transação. Retorna quantos cards foram absorvidos. */
  private async mergePair(pair: MergePair): Promise<number> {
    const { channelId, lid, phone, survivorContactId: A, absorbedContactId: B } =
      pair;

    return this.prisma.$transaction(async (tx) => {
      const convA = await tx.conversation.findFirst({
        where: { channelId, contactId: A },
        select: { id: true },
      });
      const convB = await tx.conversation.findFirst({
        where: { channelId, contactId: B },
        select: { id: true },
      });

      if (convA && convB) {
        // Move mensagens de convB → convA, evitando colisão de (conv, externalId):
        // apaga em convB as que já existem (mesmo externalId) em convA.
        const dupIds = await tx.$queryRaw<{ id: string }[]>`
          select mb.id from messages mb
          where mb.conversation_id = ${convB.id}
            and mb.external_id is not null
            and exists (
              select 1 from messages ma
              where ma.conversation_id = ${convA.id}
                and ma.external_id = mb.external_id
            )
        `;
        if (dupIds.length) {
          await tx.message.deleteMany({
            where: { id: { in: dupIds.map((d) => d.id) } },
          });
        }
        await tx.message.updateMany({
          where: { conversationId: convB.id },
          data: { conversationId: convA.id },
        });
        // Cards de convB → convA
        await tx.card.updateMany({
          where: { conversationId: convB.id },
          data: { conversationId: convA.id, contactId: A },
        });
        await tx.conversation.delete({ where: { id: convB.id } });
      } else if (convB && !convA) {
        await tx.conversation.update({
          where: { id: convB.id },
          data: { contactId: A },
        });
      }

      // Cards do contato B (inclusive sem conversa) → contato A
      await tx.card.updateMany({
        where: { contactId: B },
        data: { contactId: A },
      });

      // Tags do contato B → A. IMPORTANTE: nada de .catch() dentro da transação —
      // no Postgres, qualquer erro (ex.: tag duplicada) ABORTA a transação
      // inteira (25P02) e o resto do merge falha. createMany+skipDuplicates
      // evita a colisão sem gerar erro.
      const bTags = await tx.contactTag.findMany({
        where: { contactId: B },
        select: { tagId: true },
      });
      if (bTags.length) {
        await tx.contactTag.createMany({
          data: bTags.map((t) => ({ contactId: A, tagId: t.tagId })),
          skipDuplicates: true,
        });
      }
      await tx.contactTag.deleteMany({ where: { contactId: B } });

      // Dedup de cards do A: por pipeline, mantém o MAIS AVANÇADO.
      const cardsAbsorbed = await this.dedupeCards(tx, A);

      // Re-chaveia: apaga o CC do LID e passa o CC do número a usar o LID.
      await tx.contactChannel.delete({
        where: {
          uq_contact_channel_external: { channelId, externalId: lid },
        },
      });
      await tx.contactChannel.update({
        where: {
          uq_contact_channel_external: { channelId, externalId: phone },
        },
        data: { externalId: lid },
      });

      // Garante número/nome no sobrevivente.
      await tx.contact.update({
        where: { id: A },
        data: { phone },
      });

      // Remove o contato absorvido (sem mais dependências).
      await tx.contact.delete({ where: { id: B } });

      return cardsAbsorbed;
    });
  }

  /**
   * Para um contato, se houver >1 card ABERTO no MESMO pipeline, mantém o mais
   * avançado (maior stage.order; empate → mais recente) e apaga os outros.
   * Retorna quantos foram absorvidos (apagados).
   */
  private async dedupeCards(tx: any, contactId: string): Promise<number> {
    const cards = await tx.card.findMany({
      where: { contactId, status: 'OPEN' },
      include: { stage: { select: { order: true } } },
    });
    const byPipeline = new Map<string, any[]>();
    for (const c of cards) {
      const arr = byPipeline.get(c.pipelineId) ?? [];
      arr.push(c);
      byPipeline.set(c.pipelineId, arr);
    }
    let absorbed = 0;
    for (const arr of byPipeline.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => {
        const so = (b.stage?.order ?? 0) - (a.stage?.order ?? 0);
        if (so !== 0) return so;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      const losers = arr.slice(1);
      await tx.card.deleteMany({
        where: { id: { in: losers.map((c) => c.id) } },
      });
      absorbed += losers.length;
    }
    return absorbed;
  }
}
