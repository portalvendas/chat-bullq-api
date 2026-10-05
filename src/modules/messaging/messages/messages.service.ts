import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  MessageStatus,
} from '@prisma/client';
import { MessagesRepository } from './messages.repository';
import { SendMessageDto } from './dto/send-message.dto';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';
import { WatchdogService } from '../../routing/watchdog/watchdog.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { CadencesService } from '../../cadences/cadences.service';

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly repository: MessagesRepository,
    private readonly prisma: PrismaService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly channelAccess: ChannelAccessService,
    private readonly watchdog: WatchdogService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
    private readonly cadences: CadencesService,
  ) {}

  /**
   * Reclassifica o tipo de mídia pelo arquivo REAL: mimeType e, no fallback,
   * a extensão da URL/fileName. Só mexe entre tipos de mídia
   * (IMAGE/VIDEO/AUDIO/DOCUMENT); TEXT e demais ficam intactos, e quando não
   * dá pra determinar (pdf, docx...) mantém o tipo recebido.
   */
  private resolveMediaType(
    rawType: string,
    content: Record<string, any> | undefined,
  ): MessageContentType {
    const MEDIA = ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'];
    if (!MEDIA.includes(rawType)) return rawType as MessageContentType;

    const c = content ?? {};
    const mime = String(c.mimeType ?? '').toLowerCase();
    const src = String(c.fileName || c.mediaUrl || '').toLowerCase();
    const ext = src.split('?')[0].match(/\.([a-z0-9]+)$/)?.[1] ?? '';

    const isImg =
      mime.startsWith('image/') ||
      ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'].includes(ext);
    const isVid =
      mime.startsWith('video/') ||
      ['mp4', 'mov', '3gp', 'webm', 'mkv', 'avi', 'm4v'].includes(ext);
    const isAud =
      mime.startsWith('audio/') ||
      ['mp3', 'ogg', 'oga', 'm4a', 'wav', 'aac', 'amr', 'opus'].includes(ext);

    let resolved: MessageContentType | null = null;
    if (isImg) resolved = MessageContentType.IMAGE;
    else if (isVid) resolved = MessageContentType.VIDEO;
    else if (isAud) resolved = MessageContentType.AUDIO;

    if (resolved && resolved !== rawType) {
      this.logger.log(
        `Tipo de mídia corrigido na criação: ${rawType} -> ${resolved} (mime=${mime || 'n/a'} ext=${ext || 'n/a'})`,
      );
      return resolved;
    }
    return rawType as MessageContentType;
  }

  async send(
    dto: SendMessageDto,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: dto.conversationId },
      include: {
        channel: true,
        contact: { include: { channels: true } },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const contactChannel = conversation.contact.channels.find(
      (cc) => cc.channelId === conversation.channelId,
    );
    if (!contactChannel) {
      throw new NotFoundException('Contact channel not found');
    }

    // Resolve replyTo: dois caminhos possíveis dependendo de onde a chamada
    // veio. UI manda `replyToMessageId` (id interno) e a gente busca o
    // externalId + preview no banco. Server-to-server pode mandar `replyTo`
    // pronto. Garantimos que adapter/UI tenham os campos que precisam
    // (externalMessageId pra adapter, preview/senderName pra Instagram
    // fallback, e ambos pra metadata da nossa message renderizar quote).
    let replyTo:
      | {
          externalMessageId: string;
          previewText?: string;
          senderName?: string;
          /** Internal id, not sent to provider — só pra metadata. */
          messageId?: string;
        }
      | undefined;
    if (dto.replyToMessageId) {
      const original = await this.prisma.message.findFirst({
        where: { id: dto.replyToMessageId, conversationId: conversation.id },
        select: {
          id: true,
          externalId: true,
          content: true,
          type: true,
          senderName: true,
          direction: true,
          sender: { select: { name: true } },
        },
      });
      if (!original) {
        throw new NotFoundException('Reply target message not found');
      }
      if (!original.externalId) {
        // Sem externalId não dá pra mandar reply nativo (provider não
        // conhece nossa msg interna). Joga erro claro em vez de mandar
        // mensagem sem reply silenciosamente.
        throw new ForbiddenException(
          'Mensagem citada ainda não foi sincronizada com o provider — tente novamente em alguns segundos.',
        );
      }
      const c = (original.content ?? {}) as Record<string, any>;
      const previewText: string | undefined =
        (typeof c.text === 'string' && c.text) ||
        (typeof c.caption === 'string' && c.caption) ||
        `[${original.type.toLowerCase()}]`;
      replyTo = {
        externalMessageId: original.externalId,
        previewText,
        senderName:
          original.direction === 'INBOUND'
            ? (original.senderName ?? conversation.contact.name ?? undefined)
            : (original.sender?.name ?? original.senderName ?? undefined),
        messageId: original.id,
      };
    } else if (dto.replyTo?.externalMessageId) {
      replyTo = { externalMessageId: dto.replyTo.externalMessageId };
    }

    // Normaliza o tipo de mídia pelo arquivo real (mime/extensão) já na
    // criação — assim o registro salvo (e a bolha no CRM) fica correto e o
    // mesmo tipo vai pro provider. Ex.: imagem cadastrada como DOCUMENT vira
    // IMAGE e o WhatsApp/Z-API entrega como imagem.
    const outboundType = this.resolveMediaType(dto.type, dto.content);

    const message = await this.repository.create({
      conversationId: conversation.id,
      direction: MessageDirection.OUTBOUND,
      type: outboundType,
      content: dto.content,
      status: MessageStatus.QUEUED,
      senderId,
      // metadata.replyTo é consumido pela UI pra renderizar a quote box
      // em cima da bolha — sem isso o quote só apareceria no app do
      // cliente (WhatsApp/IG), nunca no nosso inbox.
      metadata: replyTo
        ? {
            replyTo: {
              messageId: replyTo.messageId,
              externalMessageId: replyTo.externalMessageId,
              previewText: replyTo.previewText,
              senderName: replyTo.senderName,
            },
          }
        : undefined,
    });

    // Auto-pause the AI on this conversation when a human replies. Behavior
    // is org-configurable (aiAutoDisableOnHuman, default true). The human
    // is now driving — don't let the agent compete with them mid-thread.
    //
    // Skip auto-pause if the conversation already has an explicit force-off,
    // OR if a human explicitly forced AI ON for this conversation (aiEnabled=true).
    // Force-on means "I want the AI here even if I send messages" — usually a
    // human + AI cooperating in COPILOT-style mode.
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { aiAutoDisableOnHuman: true },
    });
    const shouldDisableAi =
      conversation.aiEnabled !== false &&
      conversation.aiEnabled !== true &&
      (org?.aiAutoDisableOnHuman ?? true);

    // Auto-assign: whoever replies owns the conversation. If the current
    // assignee is someone else (or null), flip to the sender. Same-sender
    // replies are a no-op. Yes, this can "steal" from a teammate — but the
    // alternative (a conversation stuck on an inactive assignee while
    // someone else is actively replying) is worse for accountability.
    const shouldAutoAssign = conversation.assignedToId !== senderId;

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(shouldAutoAssign ? { assignedToId: senderId } : {}),
        ...(shouldDisableAi
          ? {
              aiEnabled: false,
              aiDisabledBy: senderId,
              aiDisabledAt: new Date(),
              activeAgentId: null,
            }
          : {}),
      },
    });

    // Humano respondeu — cancela qualquer timer de watchdog pendente e
    // zera o contador de tentativas. Se a IA estava paralisada e quem
    // resolveu foi a pessoa, conversa não deve aparecer como "presa".
    this.watchdog.cancelCheck(conversation.id).catch(() => undefined);

    // Humano assumiu: interrompe salesbots em andamento nesta conversa pra o
    // robô não mandar o próximo passo por cima do atendimento. Best-effort.
    this.cadences
      .stopActiveForConversation(conversation.id)
      .catch(() => undefined);

    // Replying = reading. The sender obviously saw the inbound stream
    // before typing — bump their lastReadAt so the unread badge resets
    // even if they never clicked the conversation first.
    await this.prisma.conversationRead.upsert({
      where: {
        userId_conversationId: {
          userId: senderId,
          conversationId: conversation.id,
        },
      },
      create: {
        userId: senderId,
        conversationId: conversation.id,
        lastReadMessageId: message.id,
        lastReadAt: new Date(),
      },
      update: {
        lastReadMessageId: message.id,
        lastReadAt: new Date(),
      },
    });
    this.realtimeGateway.emitToUser(senderId, 'conversation:read', {
      conversationId: conversation.id,
      userId: senderId,
      lastReadAt: new Date(),
    });

    if (shouldAutoAssign) {
      this.realtimeGateway.emitToConversation(
        conversation.id,
        'conversation:assigned',
        {
          conversationId: conversation.id,
          assigneeId: senderId,
          reason: 'auto-assign-on-reply',
        },
      );
      this.realtimeGateway.emitToChannel(
        conversation.channelId,
        'conversation:assigned',
        {
          conversationId: conversation.id,
          assigneeId: senderId,
          reason: 'auto-assign-on-reply',
        },
      );
    }

    if (shouldDisableAi) {
      this.realtimeGateway.emitToConversation(
        conversation.id,
        'conversation:ai-toggle',
        {
          conversationId: conversation.id,
          aiEnabled: false,
          actorId: senderId,
          reason: 'human-replied',
        },
      );
    }

    // Optimistic realtime: everyone in the channel/conversation sees the
    // outbound QUEUED row instantly, independent of the outbound worker
    // roundtrip. Channel-scoped so AGENTs without access to the channel
    // don't receive this event.
    this.realtimeGateway.emitToChannel(conversation.channelId, 'message:new', {
      message,
      conversationId: conversation.id,
      contactId: conversation.contactId,
    });
    this.realtimeGateway.emitToConversation(conversation.id, 'message:new', {
      message,
    });

    let outboundContent = dto.content;
    if (conversation.isGroup && dto.type === 'TEXT' && outboundContent.text) {
      const sender = await this.prisma.user.findUnique({
        where: { id: senderId },
        select: { name: true },
      });
      if (sender?.name) {
        outboundContent = {
          ...outboundContent,
          text: `*${sender.name}*\n${outboundContent.text}`,
        };
      }
    }

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: conversation.channelId,
        contactExternalId: contactChannel.externalId,
        message: {
          type: outboundType,
          content: outboundContent,
          // Manda só o que o provider precisa: externalMessageId é
          // obrigatório (Zappfy/Cloud API), preview+sender são pro
          // fallback do Instagram. messageId interno fica fora do
          // payload pro adapter — só queria persistir na metadata.
          replyTo: replyTo
            ? {
                externalMessageId: replyTo.externalMessageId,
                previewText: replyTo.previewText,
                senderName: replyTo.senderName,
              }
            : undefined,
        },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return message;
  }

  /**
   * Re-enfileira UMA mensagem OUTBOUND que ficou FAILED para nova tentativa
   * de envio ao provider. Usado tanto pelo reenvio unitário (botão na bolha)
   * quanto pelo reenvio em lote (banner de bloqueio de pagamento).
   *
   * Reconstrói o payload do job a partir da linha persistida (type/content e
   * replyTo da metadata) — o OutboundMessageProcessor lê tudo do job, não do
   * banco, então precisamos remontar exatamente como em send().
   *
   * Idempotência: a seleção é sempre feita por status=FAILED. Ao resetar para
   * QUEUED antes de enfileirar, um clique/lote repetido não acha mais a mesma
   * linha como FAILED e portanto não duplica o envio. O BullMQ ainda aplica
   * 3 tentativas com backoff exponencial para falhas transitórias.
   */
  private async requeueOutbound(message: {
    id: string;
    type: MessageContentType;
    content: unknown;
    metadata: unknown;
    conversationId: string;
    channelId: string;
    contactExternalId: string;
  }): Promise<void> {
    // Reseta o estado ANTES de enfileirar: fecha a janela de corrida em que o
    // worker poderia pegar o job e sobrescrever um status que ainda era FAILED.
    await this.prisma.message.update({
      where: { id: message.id },
      data: { status: MessageStatus.QUEUED, failedReason: null },
    });

    // Otimista: UI volta a bolha pra "enviando…" (relógio) na hora, sem
    // esperar o roundtrip do worker.
    this.realtimeGateway.emitToConversation(
      message.conversationId,
      'message:status',
      {
        messageId: message.id,
        status: MessageStatus.QUEUED,
        conversationId: message.conversationId,
      },
    );

    const replyTo = (message.metadata as Record<string, any> | null)?.replyTo;

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: message.channelId,
        contactExternalId: message.contactExternalId,
        message: {
          type: message.type,
          content: message.content,
          replyTo: replyTo?.externalMessageId
            ? {
                externalMessageId: replyTo.externalMessageId,
                previewText: replyTo.previewText,
                senderName: replyTo.senderName,
              }
            : undefined,
        },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  /**
   * Reenvia uma única mensagem que falhou (botão na bolha FAILED).
   *
   * Regras:
   *  - só OUTBOUND (mensagem do cliente não é nossa pra reenviar)
   *  - só status FAILED; QUEUED é no-op idempotente (já está na fila), e
   *    SENT/DELIVERED/READ já saíram — recusamos pra não mandar duplicado
   *  - mensagem revogada não é reenviada
   *
   * Observação sobre janela de 24h: se a falha original foi "Re-engagement
   * message" (cliente sem resposta há >24h), um reenvio de texto livre vai
   * falhar de novo — nesses casos só template HSM resolve. O reenvio não tenta
   * contornar isso; apenas recoloca na fila.
   */
  async resend(
    messageId: string,
    senderId: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{ messageId: string; status: MessageStatus; requeued: boolean }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: {
          select: {
            id: true,
            organizationId: true,
            channelId: true,
            contact: { select: { channels: true } },
          },
        },
      },
    });

    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(
      access,
      message.conversation.channelId,
    );

    if (message.direction !== MessageDirection.OUTBOUND) {
      throw new BadRequestException(
        'Só dá pra reenviar mensagens enviadas pelo time ou pela IA.',
      );
    }
    if (message.revokedAt) {
      throw new BadRequestException(
        'Mensagem deletada não pode ser reenviada.',
      );
    }
    if (message.status === MessageStatus.QUEUED) {
      // Já está na fila (clique duplo / reenvio em andamento) — no-op.
      return { messageId, status: MessageStatus.QUEUED, requeued: false };
    }
    if (message.status !== MessageStatus.FAILED) {
      throw new BadRequestException(
        'Essa mensagem não está com falha — não precisa reenviar.',
      );
    }

    const contactChannel = message.conversation.contact.channels.find(
      (cc) => cc.channelId === message.conversation.channelId,
    );
    if (!contactChannel) {
      throw new NotFoundException('Contact channel not found');
    }

    await this.requeueOutbound({
      id: message.id,
      type: message.type,
      content: message.content,
      metadata: message.metadata,
      conversationId: message.conversation.id,
      channelId: message.conversation.channelId,
      contactExternalId: contactChannel.externalId,
    });

    this.logger.log(
      `Message resend enqueued: id=${message.id} channel=${message.conversation.channelId} actor=${senderId}`,
    );

    return { messageId, status: MessageStatus.QUEUED, requeued: true };
  }

  /**
   * Reenvia EM LOTE as mensagens OUTBOUND que falharam na organização dentro
   * de uma janela recente. Pensado pro cenário de bloqueio de pagamento da
   * Meta (erro 131042): ajustado o pagamento, recoloca de uma vez tudo que a
   * Meta recusou, sem o operador caçar conversa por conversa.
   *
   * - scope='payment' (padrão): só falhas de elegibilidade/pagamento (131042),
   *   mesmo match do /dashboard/wa-health.
   * - scope='all': qualquer falha na janela.
   *
   * Respeita o channel access do solicitante e pagina internamente o
   * enfileiramento. Idempotente pela seleção status=FAILED (ver requeueOutbound).
   */
  async resendFailed(
    organizationId: string,
    senderId: string,
    access: ChannelAccess = 'ALL',
    opts: { scope?: 'payment' | 'all'; windowHours?: number } = {},
  ): Promise<{ requeued: number; scanned: number; windowHours: number }> {
    const scope = opts.scope ?? 'payment';
    const windowHours =
      opts.windowHours && opts.windowHours > 0 && opts.windowHours <= 72
        ? opts.windowHours
        : 24;
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

    // Filtro de motivo alinhado ao getWaPaymentHealth (131042 / elegibilidade /
    // pagamento, PT e EN). Em scope='all' não filtra motivo.
    const paymentReasonFilter = {
      OR: [
        { failedReason: { contains: 'eligibility', mode: 'insensitive' as const } },
        { failedReason: { contains: 'payment', mode: 'insensitive' as const } },
        { failedReason: { contains: 'pagamento', mode: 'insensitive' as const } },
        { failedReason: { contains: '131042', mode: 'insensitive' as const } },
      ],
    };

    // Channel access: 'ALL' não filtra; Set vira cláusula IN. Set vazio =
    // nenhum canal acessível → nada a fazer.
    const channelFilter =
      access === 'ALL'
        ? {}
        : { channelId: { in: [...access] } };
    if (access !== 'ALL' && (access as Set<string>).size === 0) {
      return { requeued: 0, scanned: 0, windowHours };
    }

    const where = {
      direction: MessageDirection.OUTBOUND,
      status: MessageStatus.FAILED,
      revokedAt: null,
      createdAt: { gte: since },
      conversation: {
        is: {
          organizationId,
          ...channelFilter,
        },
      },
      ...(scope === 'payment' ? paymentReasonFilter : {}),
    };

    const candidates = await this.prisma.message.findMany({
      where,
      select: {
        id: true,
        type: true,
        content: true,
        metadata: true,
        conversationId: true,
        conversation: {
          select: {
            channelId: true,
            contact: { select: { channels: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    let requeued = 0;
    for (const m of candidates) {
      const contactChannel = m.conversation.contact.channels.find(
        (cc) => cc.channelId === m.conversation.channelId,
      );
      if (!contactChannel) {
        // Sem canal do contato não dá pra remontar o destino — pula, mas loga
        // pra não sumir silenciosamente.
        this.logger.warn(
          `Resend em lote: msg=${m.id} sem contactChannel pro canal ${m.conversation.channelId} — ignorada.`,
        );
        continue;
      }
      try {
        await this.requeueOutbound({
          id: m.id,
          type: m.type,
          content: m.content,
          metadata: m.metadata,
          conversationId: m.conversationId,
          channelId: m.conversation.channelId,
          contactExternalId: contactChannel.externalId,
        });
        requeued++;
      } catch (err: unknown) {
        this.logger.error(
          `Resend em lote falhou ao enfileirar msg=${m.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.logger.log(
      `Resend em lote: org=${organizationId} scope=${scope} janela=${windowHours}h ` +
        `escaneadas=${candidates.length} reenfileiradas=${requeued} actor=${senderId}`,
    );

    return { requeued, scanned: candidates.length, windowHours };
  }

  /**
   * Marca uma mensagem como revogada (deletada pra todos). Tenta primeiro
   * propagar pro provider — se o canal suportar (Zappfy), o cliente final
   * vê "Esta mensagem foi apagada". Se o provider não suportar (Meta WA
   * Cloud, Instagram), continuamos marcando local pra a UI esconder, mas
   * o cliente final continua vendo a mensagem original no app dele.
   *
   * Regras:
   *  - só mensagens OUTBOUND podem ser revogadas (não dá pra apagar msg
   *    do cliente — não temos permissão na API dele)
   *  - precisa de externalId (msg ainda QUEUED sem externalId não foi
   *    enviada — basta deletar do banco em outro fluxo)
   *  - re-revoke é idempotente (retorna o mesmo estado)
   */
  async revokeForEveryone(
    messageId: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{
    messageId: string;
    revokedAt: Date;
    revokedBy: string;
    succeededRemote: boolean;
    remoteError: string | null;
  }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        conversation: { select: { id: true, organizationId: true, channelId: true } },
      },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, message.conversation.channelId);

    if (message.direction !== MessageDirection.OUTBOUND) {
      throw new BadRequestException(
        'Só dá pra deletar pra todos mensagens enviadas pelo time/IA. ' +
          'Mensagens do cliente não podem ser deletadas (não temos permissão no app dele).',
      );
    }

    if (message.revokedAt) {
      // Idempotente: já foi revogada antes — devolve o estado atual.
      return {
        messageId: message.id,
        revokedAt: message.revokedAt,
        revokedBy: message.revokedBy ?? actorId,
        succeededRemote: message.revokeSucceededRemote ?? false,
        remoteError: null,
      };
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: message.conversation.channelId },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    let succeededRemote = false;
    let remoteError: string | null = null;

    // Marketplace (Mercado Livre) é pergunta→resposta: não existe "deletar
    // pra todos" — não dá pra retratar uma resposta publicada no ML. Aqui o
    // excluir é SEMPRE local (esconde no nosso inbox), sem tentar o provider
    // e sem exigir externalId (mensagem FAILED/QUEUED também pode ser
    // removida localmente).
    const isMarketplace = channel.type === ChannelType.MERCADO_LIVRE;

    if (!isMarketplace) {
      if (!message.externalId) {
        throw new BadRequestException(
          'Mensagem ainda não foi entregue ao provider — não tem como deletar pra todos. ' +
            'Tente de novo em alguns segundos ou apague localmente.',
        );
      }

      const adapter = this.adapterRegistry.getOutbound(channel.type);
      if (typeof adapter.deleteMessage === 'function') {
        try {
          await adapter.deleteMessage(channel, message.externalId);
          succeededRemote = true;
        } catch (err: unknown) {
          remoteError = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Provider delete failed (channel=${channel.type} msg=${message.id}): ${remoteError}`,
          );
        }
      } else {
        remoteError = `Adapter ${channel.type} não implementa deleteMessage.`;
      }
    }

    const revokedAt = new Date();
    await this.prisma.message.update({
      where: { id: message.id },
      data: {
        revokedAt,
        revokedBy: actorId,
        revokeSucceededRemote: succeededRemote,
      },
    });

    // Realtime: notifica todos os ouvintes da conversa pra re-renderizar
    // a bolha como "mensagem deletada" sem refresh.
    const payload = {
      messageId: message.id,
      conversationId: message.conversation.id,
      revokedAt: revokedAt.toISOString(),
      revokedBy: actorId,
      succeededRemote,
    };
    this.realtimeGateway.emitToConversation(
      message.conversation.id,
      'message:revoked',
      payload,
    );
    this.realtimeGateway.emitToChannel(
      message.conversation.channelId,
      'message:revoked',
      payload,
    );

    this.logger.log(
      `Message revoked: id=${message.id} channel=${channel.type} succeededRemote=${succeededRemote} actor=${actorId}`,
    );

    return {
      messageId: message.id,
      revokedAt,
      revokedBy: actorId,
      succeededRemote,
      remoteError,
    };
  }

  async findByConversation(
    conversationId: string,
    organizationId: string,
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const skip = (page - 1) * limit;
    const { messages, total } = await this.repository.findByConversation(
      conversationId,
      skip,
      limit,
    );

    return {
      messages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
