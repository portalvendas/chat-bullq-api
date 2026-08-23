import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import axios from 'axios';
import { PrismaService } from '../../../database/prisma.service';
import { UploadsService } from '../messages/uploads.service';
import { IdempotencyService } from './idempotency.service';
import { ContactResolverService } from './contact-resolver.service';
import { ConversationResolverService } from './conversation-resolver.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NormalizedInboundMessage, StatusUpdate } from '../../channel-hub/ports/types';
import { InstagramContactEnricherService } from '../../channel-hub/adapters/instagram/instagram-contact-enricher.service';
import { InstagramCommentsService } from '../../instagram-comments/instagram-comments.service';
import { NormalizedComment } from '../../channel-hub/ports/types';
import { ZappfyContactEnricherService } from '../../channel-hub/adapters/zappfy/zappfy-contact-enricher.service';
import { WebhookEventsService } from '../../channel-hub/webhook-events.service';
import { AgentRouterService } from '../../ai-agents/router/agent-router.service';
import { AiAgentRunnerService } from '../../ai-agents/runner/agent-runner.service';
import { TranscriptionService } from '../messages/transcription.service';
import { OutboxService } from '../../automations/outbox/outbox.service';
import { WatchdogService } from '../../routing/watchdog/watchdog.service';
import { LlmContext } from '../../ai-agents/llm/llm-context';
import { CadencesService } from '../../cadences/cadences.service';
import { PipelinesService } from '../../pipelines/pipelines.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  AutomationTrigger,
  ChannelType,
  MessageDirection,
  MessageContentType as PrismaContentType,
  MessageStatus,
  ConversationStatus,
  Prisma,
} from '@prisma/client';

interface InboundJobData {
  channelId: string;
  organizationId: string;
  webhookEventId?: string;
  message: NormalizedInboundMessage;
}

interface StatusJobData {
  channelId: string;
  organizationId?: string;
  webhookEventId?: string;
  status: StatusUpdate;
}

/**
 * Debounce window before firing the agent run. Two reasons we wait:
 * 1) Customers usually send 2-3 messages in a row — without this, every
 *    short message triggers a separate run, racing each other.
 * 2) External flows (ManyChat, n8n, Zapier) often own the first reply on
 *    a new conversation. If our agent answers in <1s the customer sees
 *    two replies fighting for attention. The longer wait gives them room.
 *
 * Each new inbound message on the same conversation resets the timer —
 * we only run the agent once per "burst". 10s covers slower typists who
 * pause mid-thought (3s and 8s both let those bursts slip through and
 * generate two answers fighting each other). Combined with the 1-reply-
 * per-run guard in agent-runner, this is defense in depth: debounce
 * collapses the burst, the runner guarantees a single outbound bubble.
 */
const AGENT_DEBOUNCE_MS = 10_000;

/**
 * Message types that should NEVER trigger an agent run. REACTION (the
 * thumbs-up etc) and SYSTEM events have no actionable content — making
 * the LLM "respond" to a 👍 produces narrator-mode garbage like
 * "[A mensagem do cliente é apenas um emoji de confirmação...]".
 */
const NON_TRIGGERING_MESSAGE_TYPES: PrismaContentType[] = [
  PrismaContentType.REACTION,
  PrismaContentType.SYSTEM,
];

@Processor('inbound-messages', { concurrency: 10 })
export class InboundMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundMessageProcessor.name);

  /** In-memory debounce timers keyed by conversationId. Lost on restart by
   *  design — a restart means we'd rather reply once late than not at all. */
  private readonly pendingRuns = new Map<string, NodeJS.Timeout>();

  /** Conversations with an agent run currently in flight. While set, new
   *  inbound messages just flag {@link followupNeeded} instead of starting
   *  a parallel run — when the in-flight run finishes, we re-check and
   *  schedule one more debounced run if the customer kept typing. */
  private readonly running = new Set<string>();
  private readonly followupNeeded = new Set<string>();

  /** Janela de debounce (ms) por conversa, resolvida a partir do canal
   *  (channel.aiDebounceSeconds). Cacheada aqui pra o re-arm de followup
   *  usar o mesmo valor sem re-consultar o banco. */
  private readonly debounceMsByConv = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly instagramEnricher: InstagramContactEnricherService,
    private readonly instagramComments: InstagramCommentsService,
    private readonly zappfyEnricher: ZappfyContactEnricherService,
    private readonly webhookEvents: WebhookEventsService,
    private readonly agentRouter: AgentRouterService,
    private readonly agentRunner: AiAgentRunnerService,
    private readonly transcription: TranscriptionService,
    private readonly outbox: OutboxService,
    private readonly watchdog: WatchdogService,
    private readonly cadences: CadencesService,
    private readonly pipelines: PipelinesService,
    private readonly notifications: NotificationsService,
    private readonly uploads: UploadsService,
    @InjectQueue('chatbot-processor') private readonly chatbotQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<InboundJobData | StatusJobData>): Promise<any> {
    // BYOK: fixa a organização no contexto para todas as chamadas de LLM
    // aninhadas nesta mensagem (classifier, runner, reranker, memória)
    // resolverem a chave da Anthropic DESTA empresa.
    const orgId = (job.data as { organizationId?: string })?.organizationId;
    return orgId
      ? LlmContext.run(orgId, () => this.processImpl(job))
      : this.processImpl(job);
  }

  private async processImpl(
    job: Job<InboundJobData | StatusJobData>,
  ): Promise<any> {
    if (job.name === 'process-status') {
      return this.processStatus(job.data as StatusJobData);
    }

    if (job.name === 'process-ig-comment') {
      const d = job.data as unknown as {
        channelId: string;
        organizationId: string;
        comment: NormalizedComment;
      };
      return this.instagramComments.ingest(
        d.organizationId,
        d.channelId,
        d.comment,
      );
    }

    const { channelId, organizationId, message, webhookEventId } =
      job.data as InboundJobData;

    try {
      // Atomic duplicate check: only the first worker proceeds.
      const claimed = await this.idempotency.claimProcessing(
        message.externalMessageId,
        channelId,
      );
      if (!claimed) {
        this.logger.debug(
          `Duplicate message skipped (claim): ${message.externalMessageId}`,
        );
        if (webhookEventId) await this.webhookEvents.markProcessed(webhookEventId);
        return { skipped: true, reason: 'duplicate_claim' };
      }

      const { contactId, isNew: isNewContact } =
        await this.contactResolver.resolve(organizationId, channelId, message);

      if (message.channelType === ChannelType.INSTAGRAM) {
        const [channel, contact] = await Promise.all([
          this.prisma.channel.findUnique({ where: { id: channelId } }),
          isNewContact
            ? Promise.resolve(null)
            : this.prisma.contact.findUnique({
                where: { id: contactId },
                select: { name: true, avatarUrl: true },
              }),
        ]);
        const needsEnrichment =
          isNewContact || !contact?.name || !contact?.avatarUrl;
        if (channel && needsEnrichment) {
          this.instagramEnricher
            .enrich(channel, message.externalContactId)
            .catch((err) =>
              this.logger.warn(`IG enrichment failed: ${err.message}`),
            );
        }
      }

      // WhatsApp via Zappfy: pull profile picture + name from /chat/find on
      // first contact. Lazy — only if avatarUrl is still null. Fire-and-
      // forget so the inbound pipeline never blocks on the enrichment.
      if (message.channelType === ChannelType.WHATSAPP_ZAPPFY) {
        const [channel, contact] = await Promise.all([
          this.prisma.channel.findUnique({ where: { id: channelId } }),
          isNewContact
            ? Promise.resolve(null)
            : this.prisma.contact.findUnique({
                where: { id: contactId },
                select: { avatarUrl: true },
              }),
        ]);
        if (channel && (isNewContact || !contact?.avatarUrl)) {
          this.zappfyEnricher
            .enrich(channel, message.externalContactId)
            .catch((err) =>
              this.logger.warn(`Zappfy enrichment failed: ${err.message}`),
            );
        }
      }

      const {
        conversationId,
        status,
        isNew: isNewConversation,
      } = await this.conversationResolver.resolve(
        organizationId,
        channelId,
        contactId,
        message.isGroup,
      );

      // Paridade Kommo "origem → cria lead" + orquestrador de leads:
      // 1) conversa nova cria um card na etapa de entrada (roteado por origem);
      // 2) com o funil do card em mãos, o orquestrador sorteia um vendedor pelos
      //    pesos — respeitando o ESCOPO POR FUNIL (só sorteia nos funis
      //    configurados; vazio = todos). Best-effort, não bloqueia o pipeline.
      if (isNewConversation && !message.isEcho && !message.isGroup) {
        // Cria o card de entrada (roteado por origem). A DISTRIBUIÇÃO de
        // vendedor (sorteio ponderado + stickiness) roda DENTRO do
        // ensureEntryCard: atribui na conversa (já criada pelo WhatsApp) e no
        // card, com o MESMO dono. Cobre também lead recorrente (dedup).
        try {
          await this.pipelines.ensureEntryCard(
            organizationId,
            conversationId,
            contactId,
            message.contactName ?? message.contactPhone ?? 'Novo lead',
            // Roteamento por origem: usa o canal da conversa (tipo + exceção).
            { channelId },
          );
        } catch (err: any) {
          this.logger.warn(
            `ensureEntryCard falhou (conv ${conversationId}): ${err?.message ?? err}`,
          );
        }
      }

      // Auto-tag por FONTE: aplica em TODO inbound humano (não só na criação do
      // card), de forma read-first/idempotente. Garante a tag também em leads
      // recorrentes e "cura" casos onde o card foi criado sem a tag.
      if (!message.isEcho && !message.isGroup && contactId) {
        this.pipelines
          .applySourceTag(organizationId, contactId, { channelId })
          .catch((err) =>
            this.logger.warn(
              `applySourceTag falhou (contact ${contactId}): ${err?.message ?? err}`,
            ),
          );
      }

      const isEcho = !!message.isEcho;
      const direction = isEcho
        ? MessageDirection.OUTBOUND
        : MessageDirection.INBOUND;

      // Z-API entrega mídia via URL TEMPORÁRIA (Backblaze). Baixamos e
      // re-hospedamos no nosso storage ANTES de persistir, pra o link não
      // expirar e a foto/vídeo/áudio/doc aparecer no inbox de forma durável.
      // Fora da TX (é I/O de rede). Falha aqui não derruba a mensagem: cai no
      // fallback da URL original (melhor uma imagem temporária que nenhuma).
      // Também roda no ECHO (fromMe): mídia enviada por OUTRO aparelho chega
      // como echo com URL temporária e precisa ser re-hospedada igual. Echoes
      // de envios feitos pelo próprio app já são duráveis e o mirror os ignora.
      await this.mirrorZapiMediaIfNeeded(channelId, conversationId, message);

      // Wrap the message persist + outbox emit + lastMessageAt in a single
      // TX so the automation engine can never observe a message that
      // doesn't exist in the DB. `isNew` lets us emit only on the FIRST
      // creation — webhook re-deliveries that hit the (conv,external)
      // unique find existing rows and skip the emit.
      const { message: savedMessage, isNew } = await this.prisma.$transaction(
        async (tx) => {
          const result = await this.upsertMessage(
            tx,
            conversationId,
            message,
            direction,
            isEcho,
          );
          await tx.conversation.update({
            where: { id: conversationId },
            data: { lastMessageAt: new Date() },
          });
          if (
            result.isNew &&
            direction === MessageDirection.INBOUND
          ) {
            const content = (message.content ?? {}) as Record<string, any>;
            const body =
              typeof content.text === 'string'
                ? content.text
                : typeof content.caption === 'string'
                  ? content.caption
                  : null;
            const hasAttachment =
              message.type === 'IMAGE' ||
              message.type === 'AUDIO' ||
              message.type === 'VIDEO' ||
              message.type === 'DOCUMENT' ||
              message.type === 'STICKER';
            await this.outbox.enqueue(
              tx,
              AutomationTrigger.MESSAGE_RECEIVED,
              {
                organizationId,
                contactId,
                conversationId,
                channelId,
                messageId: result.message.id,
                body,
                type: String(message.type),
                hasAttachment,
                isFromCustomer: true,
              },
            );
          }
          return result;
        },
      );

      this.realtimeGateway.emitToChannel(channelId, 'message:new', {
        message: savedMessage,
        conversationId,
        contactId,
      });
      this.realtimeGateway.emitToConversation(conversationId, 'message:new', {
        message: savedMessage,
      });

      // Notificação de mensagem nova não lida (DM Instagram / WhatsApp / etc.)
      // — só para mensagens REAIS do cliente (inbound, não-echo). Best-effort:
      // nunca deixa a notificação derrubar o processamento da mensagem.
      if (!isEcho && direction === MessageDirection.INBOUND) {
        this.notifyNewInboundMessage({
          organizationId,
          conversationId,
          channelId,
          contactId,
          message,
        }).catch((err) =>
          this.logger.warn(`notifyNewInboundMessage falhou: ${err?.message}`),
        );
        // Janela de 24h reabriu → remove a tag "+24h" na hora (best-effort).
        void this.prisma.conversationTag
          .deleteMany({
            where: { conversationId, tag: { name: '+24h' } },
          })
          .catch(() => undefined);
      }

      if (
        !isEcho &&
        (status === ConversationStatus.BOT ||
          status === ConversationStatus.PENDING)
      ) {
        const hasActiveBot = await this.checkActiveBotForChannel(channelId);
        if (hasActiveBot) {
          if (status === ConversationStatus.PENDING) {
            await this.prisma.conversation.update({
              where: { id: conversationId },
              data: { status: ConversationStatus.BOT },
            });
          }
          await this.chatbotQueue.add(
            'process-bot',
            {
              conversationId,
              channelId,
              contactExternalId: message.externalContactId,
              organizationId,
              messageText: (message.content as any)?.text || '',
            },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
          this.logger.log(`Routed to chatbot: conv=${conversationId}`);
        }
      }

      this.logger.log(
        `Inbound processed: msg=${savedMessage.id} conv=${conversationId} contact=${contactId} type=${message.type} echo=${isEcho}`,
      );
      if (webhookEventId) await this.webhookEvents.markProcessed(webhookEventId);

      // Watchdog: cliente mandou mensagem nova → agenda timer pra detectar
      // se ninguém respondeu na janela. Echo (msg da gente que voltou via
      // webhook) não conta — essas vão pelo path OUTBOUND e cancelam.
      if (!isEcho && direction === MessageDirection.INBOUND) {
        this.watchdog.scheduleCheck(conversationId).catch((err) =>
          this.logger.warn(
            `Watchdog scheduleCheck failed for conv ${conversationId}: ${err?.message ?? err}`,
          ),
        );
        // Salesbot: cliente respondeu → bifurca (galho "reply") ou para a régua.
        this.cadences.onCustomerReply(conversationId).catch((err) =>
          this.logger.warn(
            `Cadence onCustomerReply failed for conv ${conversationId}: ${err?.message ?? err}`,
          ),
        );
      } else if (isEcho) {
        // Echo de msg nossa que finalmente voltou — cancela timer existente
        // (pode ter sido enviada por outro path que não passou pelo cancel).
        this.watchdog.cancelCheck(conversationId).catch(() => undefined);
      }

      // Fire-and-forget AI dispatch. Failures here MUST NOT take down the
      // inbound pipeline — they're logged and the conversation continues
      // working (the human always wins).
      //
      // For audio messages we transcribe first so the agent reads the text
      // instead of seeing "[audio]" and apologizing it can't listen. Cost
      // is ~$0.006/min — predictable and pays for itself the moment the
      // bot answers a single audio without bouncing the customer to text.
      if (!isEcho) {
        const dispatch = async () => {
          if (savedMessage.type === PrismaContentType.AUDIO) {
            try {
              await this.transcription.transcribe(savedMessage.id, organizationId);
            } catch (err: any) {
              this.logger.warn(
                `Auto-transcribe failed for ${savedMessage.id}: ${err?.message ?? err} — agent will see [audio] only`,
              );
            }
          }
          await this.tryAiAgent(conversationId, savedMessage.id);
        };
        dispatch().catch((err) =>
          this.logger.error(
            `AI dispatch failed for conv ${conversationId}: ${err?.message ?? err}`,
          ),
        );
      }

      return {
        messageId: savedMessage.id,
        conversationId,
        contactId,
        conversationStatus: status,
      };
    } catch (err: any) {
      this.logger.error(
        `Inbound failed (channel=${channelId} ext=${message.externalMessageId}): ${err.message}`,
        err.stack,
      );
      if (webhookEventId) {
        await this.webhookEvents.markFailed(webhookEventId, err.message);
      }
      // Release the claim so retries can try again — next attempt re-acquires.
      // IMPORTANTE: apaga a chave (releaseProcessing), NÃO regrava
      // (markProcessed) — senão o claimProcessing do retry veria a chave e
      // pularia a mensagem como duplicada, perdendo-a de vez.
      await this.idempotency
        .releaseProcessing(message.externalMessageId, channelId)
        .catch(() => undefined);
      throw err;
    }
  }

  /**
   * Persists an inbound message OR merges into an existing row created by the
   * outbound path (which wrote the row with externalId BEFORE we saw the echo).
   *
   * We rely on the `(conversationId, externalId)` unique constraint.
   */
  private async upsertMessage(
    tx: Prisma.TransactionClient,
    conversationId: string,
    message: NormalizedInboundMessage,
    direction: MessageDirection,
    isEcho: boolean,
  ): Promise<{ message: import('@prisma/client').Message; isNew: boolean }> {
    const existing = message.externalMessageId
      ? await tx.message.findUnique({
          where: {
            uq_msg_conv_external: {
              conversationId,
              externalId: message.externalMessageId,
            },
          },
        })
      : null;

    if (existing) {
      // Already persisted (either by outbound processor or a previous webhook).
      // Merge non-destructively: upgrade status, fill sentAt/deliveredAt.
      const patch: Record<string, any> = {};
      if (!existing.sentAt && isEcho) patch.sentAt = new Date();
      if (!existing.deliveredAt && !isEcho) patch.deliveredAt = new Date();
      if (isEcho && existing.status === MessageStatus.QUEUED) {
        patch.status = MessageStatus.SENT;
      }
      if (!isEcho && existing.status === MessageStatus.QUEUED) {
        patch.status = MessageStatus.DELIVERED;
      }
      if (Object.keys(patch).length === 0) {
        return { message: existing, isNew: false };
      }
      const updated = await tx.message.update({
        where: { id: existing.id },
        data: patch,
      });
      return { message: updated, isNew: false };
    }

    // Resolve o quote ANTES do create: se a msg cita outra (reply nativo),
    // enriquece com preview+remetente pra UI renderizar a quote box também
    // no inbound (o outbound já faz isso via messages.service).
    const replyToMeta = await this.buildReplyToMetadata(
      tx,
      conversationId,
      message.replyTo,
    );

    try {
      const created = await tx.message.create({
        data: {
          conversationId,
          direction,
          type: message.type as unknown as PrismaContentType,
          content: message.content as any,
          externalId: message.externalMessageId || null,
          status: isEcho ? MessageStatus.SENT : MessageStatus.DELIVERED,
          senderName: message.senderName || null,
          sentAt: isEcho ? new Date() : null,
          deliveredAt: isEcho ? null : new Date(),
          metadata: {
            rawPayload: safeJson(message.rawPayload),
            isEcho,
            replyTo: replyToMeta,
          },
        },
      });
      return { message: created, isNew: true };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Lost a race — re-read and return as non-new (the racer wrote it).
        const racer = await tx.message.findUnique({
          where: {
            uq_msg_conv_external: {
              conversationId,
              externalId: message.externalMessageId,
            },
          },
        });
        if (racer) return { message: racer, isNew: false };
      }
      throw err;
    }
  }

  /**
   * Enriquece o `replyTo` de uma mensagem INBOUND com o preview da mensagem
   * citada, na MESMA shape que o outbound (messages.service) produz, pra a UI
   * renderizar a quote box em cima da bolha — não só no app do cliente.
   *
   * O webhook só nos entrega o id externo da msg citada:
   *   - WhatsApp Cloud API (oficial): `context.id`
   *   - Z-API:                        `referenceMessageId`
   *   - Zappfy/Uazapi:                `contextInfo.stanzaId`
   * Resolvemos esse id → nossa message interna (por conversa + externalId) e
   * extraímos `previewText` + `senderName` + `messageId` (pro click-to-scroll).
   *
   * Degradação segura: se a msg citada não estiver no histórico (ex.: reply a
   * uma mensagem antiga não sincronizada), ou se for um reply a story/ad do
   * Instagram (sem `externalMessageId`), devolvemos o contexto cru — a quote
   * box some, mas nada quebra. Nunca lança: qualquer erro vira warn + fallback.
   *
   * @example entrada  replyTo = { externalMessageId: 'wamid.XXX' }
   * @example saída     { externalMessageId: 'wamid.XXX', messageId: 'cuid',
   *                      previewText: 'Qual combina mais…', senderName: 'Você' }
   */
  private async buildReplyToMetadata(
    tx: Prisma.TransactionClient,
    conversationId: string,
    replyTo?: NormalizedInboundMessage['replyTo'],
  ): Promise<any> {
    if (!replyTo) return null;
    const base = safeJson(replyTo); // preserva story/ad/externalMessageId
    if (!replyTo.externalMessageId) return base; // story/mention/ad puro

    try {
      const original = await tx.message.findUnique({
        where: {
          uq_msg_conv_external: {
            conversationId,
            externalId: replyTo.externalMessageId,
          },
        },
        select: {
          id: true,
          content: true,
          type: true,
          senderName: true,
          direction: true,
          sender: { select: { name: true } },
        },
      });
      // Citou uma msg que não temos no histórico carregado — mantém o cru.
      if (!original) return base;

      const c = (original.content ?? {}) as Record<string, any>;
      const previewText =
        (typeof c.text === 'string' && c.text) ||
        (typeof c.caption === 'string' && c.caption) ||
        replyMediaLabel(original.type);
      // Nossa msg (OUTBOUND) → "Você" (fallback); msg do cliente (INBOUND) →
      // nome de quem mandou. Espelha a lógica do outbound em messages.service.
      const senderName =
        original.direction === MessageDirection.INBOUND
          ? (original.senderName ?? undefined)
          : (original.sender?.name ?? original.senderName ?? 'Você');

      return {
        ...base,
        messageId: original.id,
        externalMessageId: replyTo.externalMessageId,
        previewText,
        senderName,
      };
    } catch (err: any) {
      this.logger.warn(
        `buildReplyToMetadata falhou (conv ${conversationId}, ext ${replyTo.externalMessageId}): ${err?.message ?? err}`,
      );
      return base;
    }
  }

  /** Tipos que carregam mídia e podem ser re-hospedados. */
  private static readonly MEDIA_TYPES = new Set<string>([
    'IMAGE',
    'VIDEO',
    'AUDIO',
    'DOCUMENT',
    'STICKER',
  ]);

  /**
   * Baixa a mídia de uma URL temporária do Z-API e re-hospeda no nosso storage
   * persistente, trocando `content.mediaUrl` pela URL durável. Só age quando:
   *  - o canal é Z-API (WHATSAPP_ZAPI);
   *  - o tipo é mídia (imagem/vídeo/áudio/documento/figurinha);
   *  - `content.mediaUrl` é uma URL http externa (não já re-hospedada por nós).
   *
   * Idempotente na prática: se já for uma URL `/api/v1/uploads/`, não refaz.
   * NUNCA lança — qualquer erro (download/timeout/limite) vira warn e mantém a
   * URL original, pra mensagem ainda aparecer (ainda que o link possa expirar).
   *
   * @example antes  content.mediaUrl = 'https://f004.backblazeb2.com/.../x.jpg'
   * @example depois content.mediaUrl = 'https://<app>/api/v1/uploads/inbound/<canal>/<data>/<hash>.jpg'
   */
  private async mirrorZapiMediaIfNeeded(
    channelId: string,
    conversationId: string,
    message: NormalizedInboundMessage,
  ): Promise<void> {
    if (message.channelType !== ChannelType.WHATSAPP_ZAPI) return;
    if (!InboundMessageProcessor.MEDIA_TYPES.has(String(message.type))) return;

    const content = (message.content ?? {}) as Record<string, any>;
    const url = content.mediaUrl;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    // Já é nosso (re-host anterior / retry) — não baixa de novo.
    if (url.includes('/api/v1/uploads/')) return;

    // ECHO (fromMe): se NÓS enviamos pelo próprio app, o outbound processor já
    // persistiu a mensagem com a URL durável; o echo do Z-API traz só uma cópia
    // temporária que o upsert descarta. Nesse caso não re-hospeda (evita baixar
    // e gravar um arquivo órfão). Só age em echo de envio por OUTRO aparelho,
    // que vira mensagem NOVA carregando a URL temporária.
    if (message.isEcho && message.externalMessageId) {
      const existing = await this.prisma.message.findUnique({
        where: {
          uq_msg_conv_external: {
            conversationId,
            externalId: message.externalMessageId,
          },
        },
        select: { content: true },
      });
      const existingUrl = (existing?.content as Record<string, any> | null)
        ?.mediaUrl;
      if (
        typeof existingUrl === 'string' &&
        existingUrl.includes('/api/v1/uploads/')
      ) {
        return;
      }
    }

    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: UploadsService.MAX_INBOUND_BYTES,
        maxBodyLength: UploadsService.MAX_INBOUND_BYTES,
      });
      const buffer = Buffer.from(resp.data);
      const mimeType =
        (typeof content.mimeType === 'string' && content.mimeType) ||
        (resp.headers?.['content-type'] as string) ||
        'application/octet-stream';

      const saved = await this.uploads.saveInboundMedia({
        buffer,
        mimeType,
        channelId,
        originalFilename:
          typeof content.fileName === 'string' ? content.fileName : null,
      });

      content.mediaUrl = saved.url;
      content.mimeType = saved.mimeType;
      content.fileSize = saved.size;
      message.content = content as any;
      this.logger.log(
        `Z-API media re-hospedada: msg=${message.externalMessageId} type=${message.type} -> ${saved.url}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Z-API media mirror falhou (msg=${message.externalMessageId}, url=${url}): ${err?.message ?? err} — mantém URL temporária`,
      );
    }
  }

  private async checkActiveBotForChannel(channelId: string): Promise<boolean> {
    const link = await this.prisma.chatbotFlowChannel.findFirst({
      where: {
        channelId,
        flow: { isActive: true, deletedAt: null },
      },
    });
    return !!link;
  }

  /** Rótulo amigável do canal para o título da notificação. */
  private channelLabel(type?: ChannelType | string | null): string {
    switch (type) {
      case ChannelType.INSTAGRAM:
        return 'Instagram';
      case ChannelType.WHATSAPP_OFFICIAL:
      case ChannelType.WHATSAPP_ZAPI:
        return 'WhatsApp';
      case ChannelType.MERCADO_LIVRE:
        return 'Mercado Livre';
      case ChannelType.SHOPEE:
        return 'Shopee';
      default:
        return 'Mensagem';
    }
  }

  /** Prévia curta do conteúdo da mensagem para o corpo da notificação. */
  private messagePreview(message: NormalizedInboundMessage): string {
    const content = (message.content ?? {}) as Record<string, any>;
    const text =
      typeof content.text === 'string'
        ? content.text
        : typeof content.caption === 'string'
          ? content.caption
          : null;
    if (text && text.trim()) {
      const t = text.trim();
      return t.length > 120 ? `${t.slice(0, 117)}…` : t;
    }
    switch (message.type) {
      case 'IMAGE':
        return '📷 Imagem';
      case 'AUDIO':
        return '🎤 Áudio';
      case 'VIDEO':
        return '🎬 Vídeo';
      case 'DOCUMENT':
        return '📎 Documento';
      case 'STICKER':
        return '💬 Figurinha';
      default:
        return 'Nova mensagem';
    }
  }

  /**
   * Notifica responsável + gestores sobre mensagem nova do cliente.
   * Throttle por conversa via `metadata.lastNotifiedAt` (90s) pra não
   * disparar uma notificação por mensagem numa rajada. Não notifica quem
   * está com a conversa aberta na hora (presence) — evita o alerta redundante
   * pra quem já está lendo.
   */
  private async notifyNewInboundMessage(params: {
    organizationId: string;
    conversationId: string;
    channelId: string;
    contactId: string;
    message: NormalizedInboundMessage;
  }): Promise<void> {
    const THROTTLE_MS = 90_000;
    const conv = await this.prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: {
        assignedToId: true,
        metadata: true,
        channel: { select: { type: true } },
        contact: { select: { name: true, phone: true } },
      },
    });
    if (!conv) return;

    const meta = (conv.metadata as Record<string, any>) ?? {};
    const last = meta.lastNotifiedAt ? new Date(meta.lastNotifiedAt).getTime() : 0;
    if (Date.now() - last < THROTTLE_MS) return; // rajada — já avisou há pouco

    const label = this.channelLabel(conv.channel?.type);
    const who = conv.contact?.name || conv.contact?.phone || 'Cliente';
    const preview = this.messagePreview(params.message);

    await this.notifications.notifyManagersAndUser({
      organizationId: params.organizationId,
      responsibleUserId: conv.assignedToId,
      type: 'NEW_MESSAGE',
      title: `Nova mensagem no ${label}`,
      body: `${who}: ${preview}`,
      data: {
        kind: 'new_message',
        conversationId: params.conversationId,
        channelId: params.channelId,
        contactId: params.contactId,
        channelType: conv.channel?.type ?? null,
      },
    });

    await this.prisma.conversation.update({
      where: { id: params.conversationId },
      data: {
        metadata: { ...meta, lastNotifiedAt: new Date().toISOString() },
      },
    });
  }

  /**
   * Run the AI agent against this conversation if it should handle it.
   * Loaded conversation needs to be re-fetched here because the rule-based
   * chatbot above may have updated `status` / fields meanwhile.
   */
  private async tryAiAgent(
    conversationId: string,
    triggerMessageId: string,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) return;

    const decision = await this.agentRouter.shouldHandle(conversation);
    if (!decision.handle) {
      this.logger.debug(
        `AI skipped for conv ${conversationId}: ${decision.reason}`,
      );
      return;
    }

    const triggerMessage = await this.prisma.message.findUnique({
      where: { id: triggerMessageId },
    });
    if (!triggerMessage) return;

    // REACTION/SYSTEM nunca dispara IA — não tem conteúdo pra responder.
    if (NON_TRIGGERING_MESSAGE_TYPES.includes(triggerMessage.type)) {
      this.logger.debug(
        `AI skipped: message type=${triggerMessage.type} not actionable`,
      );
      return;
    }

    // Resolve a janela de debounce do canal (default do sistema se NULL).
    const channel = await this.prisma.channel.findUnique({
      where: { id: conversation.channelId },
      select: { aiDebounceSeconds: true },
    });
    const debounceMs =
      channel?.aiDebounceSeconds && channel.aiDebounceSeconds > 0
        ? channel.aiDebounceSeconds * 1000
        : AGENT_DEBOUNCE_MS;
    this.debounceMsByConv.set(conversationId, debounceMs);

    this.scheduleAgentRun(conversationId, triggerMessageId);
  }

  /**
   * Debounced trigger: replaces any in-flight timer for this conversation
   * with a new one. The latest message always wins — older bursts get
   * dropped because by the time the timer fires, we re-fetch the latest
   * trigger anyway. Simple, no extra queue, no Redis state.
   *
   * If an agent run is already in flight for this conversation, we don't
   * stack another one — we just flag that a follow-up is needed. The
   * in-flight run sees the flag when it finishes and re-schedules.
   */
  private scheduleAgentRun(conversationId: string, triggerMessageId: string) {
    if (this.running.has(conversationId)) {
      this.followupNeeded.add(conversationId);
      this.logger.debug(
        `Agent already running for conv ${conversationId}; deferring trigger ${triggerMessageId}`,
      );
      return;
    }

    const existing = this.pendingRuns.get(conversationId);
    if (existing) {
      clearTimeout(existing);
      this.logger.debug(
        `Reset agent debounce for conv ${conversationId} (new trigger ${triggerMessageId})`,
      );
    }

    const debounceMs = this.debounceMsByConv.get(conversationId) ?? AGENT_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      this.pendingRuns.delete(conversationId);
      this.fireAgentRun(conversationId);
    }, debounceMs);

    this.pendingRuns.set(conversationId, timer);
  }

  /**
   * Actually run the agent. Wrapped to:
   *  - mark the conversation as running so no parallel run starts
   *  - re-check after completion: if a new inbound landed during the run,
   *    schedule another debounced run on the latest message
   */
  private async fireAgentRun(conversationId: string): Promise<void> {
    if (this.running.has(conversationId)) return;
    this.running.add(conversationId);
    this.followupNeeded.delete(conversationId);

    try {
      // Re-fetch state — between scheduling and firing, the conversation
      // may have been claimed by a human, paused, or resolved.
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
      });
      if (!conv) return;

      const decision = await this.agentRouter.shouldHandle(conv);
      if (!decision.handle) {
        this.logger.debug(
          `AI skipped after debounce for conv ${conversationId}: ${decision.reason}`,
        );
        return;
      }

      // Always run against the LATEST actionable inbound — exclude
      // reactions/system events that arrived during the debounce window.
      // Otherwise the agent answers the 👍 instead of the real message.
      const latestInbound = await this.prisma.message.findFirst({
        where: {
          conversationId,
          direction: 'INBOUND',
          type: { notIn: NON_TRIGGERING_MESSAGE_TYPES },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!latestInbound) {
        this.logger.debug(
          `AI skipped after debounce for conv ${conversationId}: no actionable inbound`,
        );
        return;
      }

      await this.agentRunner.run({
        conversation: conv,
        triggerMessage: latestInbound,
      });

      // IA respondeu (ou pelo menos o run terminou sem throw) — limpa o
      // timer reativo pra essa conversa e zera contador de tentativas.
      this.watchdog
        .cancelCheck(conversationId)
        .catch((err) =>
          this.logger.warn(
            `Watchdog cancelCheck failed for conv ${conversationId}: ${err?.message ?? err}`,
          ),
        );
    } catch (err: any) {
      this.logger.error(
        `Debounced agent run failed for conv ${conversationId}: ${err?.message ?? err}`,
      );
    } finally {
      this.running.delete(conversationId);
      // Customer kept typing during the run — re-arm the debounce so the
      // next reply addresses everything they sent, in one go.
      if (this.followupNeeded.delete(conversationId)) {
        this.logger.debug(
          `Re-arming debounce for conv ${conversationId} (followup needed)`,
        );
        this.scheduleAgentRun(conversationId, 'followup');
      } else {
        // Sem followup pendente — libera o cache de debounce dessa conversa.
        this.debounceMsByConv.delete(conversationId);
      }
    }
  }

  private async processStatus(data: StatusJobData): Promise<any> {
    const { status, channelId, webhookEventId } = data;
    if (!status?.externalMessageId) return;

    const statusMap: Record<string, MessageStatus> = {
      sent: MessageStatus.SENT,
      delivered: MessageStatus.DELIVERED,
      read: MessageStatus.READ,
      failed: MessageStatus.FAILED,
    };
    const dbStatus = statusMap[status.status];
    if (!dbStatus) return;

    // Special case: Instagram read events arrive with a watermark, not a mid.
    if (status.externalMessageId.startsWith('ig-read-watermark:')) {
      return this.processInstagramReadWatermark(channelId, status, webhookEventId);
    }

    const message = await this.prisma.message.findFirst({
      where: { externalId: status.externalMessageId },
    });
    if (!message) return;

    const updateData: Record<string, any> = {
      status: this.maxStatus(message.status, dbStatus),
    };
    if (dbStatus === MessageStatus.SENT && !message.sentAt) {
      updateData.sentAt = status.timestamp;
    }
    if (dbStatus === MessageStatus.DELIVERED && !message.deliveredAt) {
      updateData.deliveredAt = status.timestamp;
    }
    if (dbStatus === MessageStatus.READ && !message.readAt) {
      updateData.readAt = status.timestamp;
    }
    if (dbStatus === MessageStatus.FAILED) {
      updateData.failedReason = status.errorMessage;
    }

    const updated = await this.prisma.message.update({
      where: { id: message.id },
      data: updateData,
    });

    const payload = {
      messageId: message.id,
      status: updated.status,
      conversationId: message.conversationId,
    };
    this.realtimeGateway.emitToConversation(
      message.conversationId,
      'message:status',
      payload,
    );

    if (webhookEventId) await this.webhookEvents.markProcessed(webhookEventId);

    return { updated: message.id, status: updated.status };
  }

  /**
   * Mark every outbound message in channel's conversations as READ when their
   * `sentAt <= watermark`. Keeps the timeline consistent with what Meta shows.
   */
  private async processInstagramReadWatermark(
    channelId: string,
    status: StatusUpdate,
    webhookEventId?: string,
  ): Promise<any> {
    const watermark = status.timestamp;
    const candidates = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.OUTBOUND,
        status: { in: [MessageStatus.SENT, MessageStatus.DELIVERED] },
        sentAt: { lte: watermark },
        conversation: { channelId },
      },
      select: { id: true, conversationId: true },
      take: 500,
    });
    if (candidates.length === 0) return;

    await this.prisma.message.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: MessageStatus.READ, readAt: watermark },
    });

    const byConv = new Map<string, string[]>();
    for (const c of candidates) {
      if (!byConv.has(c.conversationId)) byConv.set(c.conversationId, []);
      byConv.get(c.conversationId)!.push(c.id);
    }
    for (const [conversationId, messageIds] of byConv) {
      this.realtimeGateway.emitToConversation(conversationId, 'message:status', {
        messageIds,
        status: MessageStatus.READ,
        conversationId,
      });
    }

    if (webhookEventId) await this.webhookEvents.markProcessed(webhookEventId);
    return { updated: candidates.length, status: MessageStatus.READ };
  }

  private maxStatus(current: MessageStatus, next: MessageStatus): MessageStatus {
    // Never regress status: QUEUED → SENT → DELIVERED → READ. FAILED wins unless already READ.
    const order: Record<MessageStatus, number> = {
      [MessageStatus.QUEUED]: 0,
      [MessageStatus.SENT]: 1,
      [MessageStatus.DELIVERED]: 2,
      [MessageStatus.READ]: 3,
      [MessageStatus.FAILED]: 4,
    };
    if (current === MessageStatus.READ && next !== MessageStatus.READ) return current;
    return order[next] >= order[current] ? next : current;
  }
}

function safeJson(value: unknown): any {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/** Rótulo curto pra usar como preview de uma msg citada sem texto (mídia). */
function replyMediaLabel(type: PrismaContentType | string): string {
  switch (type) {
    case 'IMAGE':
      return '📷 Imagem';
    case 'AUDIO':
      return '🎤 Áudio';
    case 'VIDEO':
      return '🎬 Vídeo';
    case 'DOCUMENT':
      return '📎 Documento';
    case 'STICKER':
      return '💬 Figurinha';
    default:
      return `[${String(type).toLowerCase()}]`;
  }
}
