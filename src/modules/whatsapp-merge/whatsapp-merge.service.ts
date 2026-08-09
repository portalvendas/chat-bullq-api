import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { canonicalPhone } from '../../common/phone.util';

export interface PhoneMergeSummary {
  contactsScanned: number;
  groupsFound: number;
  merged: number;
  cardsAbsorbed: number;
  errors: { group: string; error: string }[];
  preview: { phone: string; contactIds: string[] }[];
}

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

  // ───────────────────────────────────────────────────────────────────────
  //  MERGE POR VARIANTE DE TELEFONE (9º dígito BR)
  //  Junta contatos que são a MESMA pessoa mas ficaram separados porque um
  //  canal (WhatsApp/Z-API) entregou o número sem o 9 e o formulário (LP/Lead
  //  Ads/import) capturou com o 9. Agrupa por telefone canônico e funde.
  // ───────────────────────────────────────────────────────────────────────

  async runPhoneDuplicates(
    organizationId: string,
    execute = false,
  ): Promise<PhoneMergeSummary> {
    const contacts = await this.prisma.contact.findMany({
      where: { organizationId, phone: { not: null }, deletedAt: null },
      select: { id: true, phone: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const summary: PhoneMergeSummary = {
      contactsScanned: contacts.length,
      groupsFound: 0,
      merged: 0,
      cardsAbsorbed: 0,
      errors: [],
      preview: [],
    };

    // Agrupa por telefone canônico (DDI 55 + DDD + 9 dígitos).
    const groups = new Map<string, { id: string; createdAt: Date }[]>();
    for (const c of contacts) {
      const key = canonicalPhone(c.phone);
      if (!key) continue;
      const arr = groups.get(key) ?? [];
      arr.push({ id: c.id, createdAt: c.createdAt });
      groups.set(key, arr);
    }

    for (const [phone, members] of groups.entries()) {
      if (members.length < 2) continue;
      summary.groupsFound += 1;
      if (summary.preview.length < 100)
        summary.preview.push({ phone, contactIds: members.map((m) => m.id) });
      if (!execute) continue;

      try {
        // Sobrevivente = quem TEM canal/conversa (âncora do WhatsApp, pra que
        // novas mensagens continuem caindo nele). Empate → o mais antigo.
        const survivorId = await this.pickSurvivor(members.map((m) => m.id));
        const absorbed = members
          .map((m) => m.id)
          .filter((id) => id !== survivorId);
        for (const b of absorbed) {
          summary.cardsAbsorbed += await this.mergeContacts(survivorId, b);
          summary.merged += 1;
        }
      } catch (err: any) {
        summary.errors.push({ group: phone, error: err?.message });
        this.logger.error(`phone-merge falhou (${phone}): ${err?.message}`);
      }
    }

    return summary;
  }

  /** Escolhe o contato âncora: o que tem contactChannel; empate → mais antigo. */
  private async pickSurvivor(ids: string[]): Promise<string> {
    const withChannel = await this.prisma.contactChannel.findMany({
      where: { contactId: { in: ids } },
      select: { contactId: true },
    });
    const channelSet = new Set(withChannel.map((c) => c.contactId));
    const anchored = ids.filter((id) => channelSet.has(id));
    // ids já vem em ordem de criação (mais antigo primeiro).
    return (anchored[0] ?? ids[0]) as string;
  }

  /**
   * Funde o contato B no A: move conversas, mensagens, canais, tags e cards,
   * depois deduplica cards por pipeline PRESERVANDO o vínculo com a conversa e
   * enriquecendo o card vencedor com o metadata do perdedor (score/tracking da
   * LP). Retorna quantos cards foram absorvidos.
   */
  private async mergeContacts(A: string, B: string): Promise<number> {
    if (A === B) return 0;
    return this.prisma.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: { contactId: B },
        data: { contactId: A },
      });
      await tx.card.updateMany({
        where: { contactId: B },
        data: { contactId: A },
      });
      // Canais do B → A (evita colisão de (channelId, externalId)).
      const bChannels = await tx.contactChannel.findMany({
        where: { contactId: B },
        select: { id: true, channelId: true, externalId: true },
      });
      for (const cc of bChannels) {
        const clash = await tx.contactChannel.findUnique({
          where: {
            uq_contact_channel_external: {
              channelId: cc.channelId,
              externalId: cc.externalId,
            },
          },
          select: { id: true },
        });
        if (clash) {
          await tx.contactChannel.delete({ where: { id: cc.id } });
        } else {
          await tx.contactChannel.update({
            where: { id: cc.id },
            data: { contactId: A },
          });
        }
      }
      // Tags do B → A sem colidir.
      const bTags = await tx.contactTag.findMany({
        where: { contactId: B },
        select: { tagId: true },
      });
      if (bTags.length) {
        await tx.contactTag.createMany({
          data: bTags.map((t) => ({ contactId: A, tagId: t.tagId })),
          skipDuplicates: true,
        });
        await tx.contactTag.deleteMany({ where: { contactId: B } });
      }

      // Completa dados faltantes no sobrevivente.
      const [ca, cb] = await Promise.all([
        tx.contact.findUnique({ where: { id: A } }),
        tx.contact.findUnique({ where: { id: B } }),
      ]);
      const metaA = (ca?.metadata as Record<string, any>) ?? {};
      const metaB = (cb?.metadata as Record<string, any>) ?? {};
      await tx.contact.update({
        where: { id: A },
        data: {
          name: ca?.name ?? cb?.name ?? undefined,
          email: ca?.email ?? cb?.email ?? undefined,
          phone: ca?.phone ?? cb?.phone ?? undefined,
          metadata: {
            ...metaB,
            ...metaA,
            tracking: { ...(metaB.tracking ?? {}), ...(metaA.tracking ?? {}) },
          },
        },
      });

      const absorbed = await this.dedupeCardsRich(tx, A);
      await tx.contact.delete({ where: { id: B } });
      return absorbed;
    });
  }

  /**
   * Dedup de cards do contato PRESERVANDO o vínculo com a conversa e o metadata
   * rico. Por pipeline com >1 card ABERTO: vencedor = o que tem conversationId
   * (âncora do WhatsApp); senão o mais avançado/recente. Antes de apagar os
   * perdedores, herda deles description/value/metadata que faltarem no vencedor.
   */
  private async dedupeCardsRich(tx: any, contactId: string): Promise<number> {
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
        // 1) tem conversa vence; 2) stage mais avançado; 3) mais recente.
        const ca = a.conversationId ? 1 : 0;
        const cb = b.conversationId ? 1 : 0;
        if (ca !== cb) return cb - ca;
        const so = (b.stage?.order ?? 0) - (a.stage?.order ?? 0);
        if (so !== 0) return so;
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
      const winner = arr[0];
      const losers = arr.slice(1);
      // Herda dados que faltam no vencedor (ex.: score/tracking da LP).
      const wMeta = (winner.metadata as Record<string, any>) ?? {};
      const patch: Record<string, any> = {};
      let mergedMeta = { ...wMeta };
      for (const l of losers) {
        const lMeta = (l.metadata as Record<string, any>) ?? {};
        mergedMeta = {
          ...lMeta,
          ...mergedMeta,
          tracking: {
            ...(lMeta.tracking ?? {}),
            ...(mergedMeta.tracking ?? {}),
          },
        };
        if (!winner.description && l.description)
          patch.description = l.description;
        if (
          (winner.value == null || Number(winner.value) === 0) &&
          l.value != null &&
          Number(l.value) !== 0
        )
          patch.value = l.value;
      }
      patch.metadata = mergedMeta;
      await tx.card.update({ where: { id: winner.id }, data: patch });
      await tx.card.deleteMany({
        where: { id: { in: losers.map((c: any) => c.id) } },
      });
      absorbed += losers.length;
    }
    return absorbed;
  }
}
