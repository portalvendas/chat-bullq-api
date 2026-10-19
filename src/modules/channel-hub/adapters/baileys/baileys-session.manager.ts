/**
 * Runtime STATEFUL do Baileys: mantém um socket WhatsApp por canal, gera o QR
 * de pareamento, reconecta e empurra as mensagens recebidas pra fila
 * `inbound-messages` (mesmo pipeline dos webhooks).
 *
 * ⚠️ Instância ÚNICA: um socket Baileys é stateful e não pode rodar em 2
 * réplicas ao mesmo tempo (a sessão do WhatsApp cai). Este manager DEVE viver
 * num processo único (worker single-instance). Ver doc de deploy.
 *
 * ⚠️ Importa `@whiskeysockets/baileys` + `qrcode` (deps a adicionar no Mac com
 * `yarn add`). NÃO é typechecado neste ambiente.
 *
 * MVP: pareamento por QR + reconexão + rehidratação no boot + TEXTO 2-vias.
 * Mídia é TODO.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChannelType, MessageStatus } from '@prisma/client';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../../database/prisma.service';
import { BaileysAuthStateService } from './baileys-auth-state.service';
import { BaileysMessageMapper } from './baileys.message-mapper';
import { UploadsService } from '../../../messaging/messages/uploads.service';

type ConnStatus = 'connecting' | 'connected' | 'disconnected';

interface SessionState {
  sock: any;
  organizationId: string;
  status: ConnStatus;
  qr: string | null; // data-URI do QR atual (null quando conectado)
  phone: string | null;
  starting: boolean;
  reconnectAttempts: number;
}

/** Logger pino-compatível silencioso — evita a dep direta do pino. */
function silentLogger(): any {
  const noop = () => undefined;
  const l: any = {
    level: 'silent',
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  };
  l.child = () => l;
  return l;
}

@Injectable()
export class BaileysSessionManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private readonly sessions = new Map<string, SessionState>();
  private cachedVersion: any = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authState: BaileysAuthStateService,
    private readonly mapper: BaileysMessageMapper,
    private readonly uploads: UploadsService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('inbound-messages') private readonly inboundQueue: Queue,
  ) {}

  /**
   * No boot, reata os canais Baileys que já pareados (têm sessão persistida).
   * Assim reinícios do worker não exigem re-scan do QR.
   */
  async onModuleInit(): Promise<void> {
    try {
      const channels = await this.prisma.channel.findMany({
        where: { type: ChannelType.WHATSAPP_BAILEYS, isActive: true },
        select: { id: true, organizationId: true },
      });
      for (const ch of channels) {
        const sess = await this.prisma.whatsappBaileysSession.findUnique({
          where: { channelId: ch.id },
          select: { creds: true },
        });
        if (!sess?.creds) continue; // nunca pareou — espera o usuário abrir o QR
        this.logger
          .log(`Reatando sessão Baileys canal=${ch.id}`);
        this.connect(ch.id, ch.organizationId).catch((e) =>
          this.logger.error(
            `Falha ao reatar canal=${ch.id}: ${e?.message ?? e}`,
          ),
        );
      }
    } catch (e: any) {
      this.logger.error(`onModuleInit Baileys: ${e?.message ?? e}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const [channelId, s] of this.sessions.entries()) {
      try {
        s.sock?.end?.(undefined);
      } catch {
        /* noop */
      }
      this.sessions.delete(channelId);
    }
  }

  /**
   * Garante que a sessão exista e devolve o estado atual pro polling da tela de
   * QR. Se ainda não há socket, dispara o connect (que produz o QR async).
   */
  async ensure(
    channelId: string,
    organizationId: string,
  ): Promise<{ connected: boolean; status: ConnStatus; qrcode: string | null }> {
    let s = this.sessions.get(channelId);
    if (!s) {
      await this.connect(channelId, organizationId);
      s = this.sessions.get(channelId);
    }
    if (!s) {
      return { connected: false, status: 'disconnected', qrcode: null };
    }
    return {
      connected: s.status === 'connected',
      status: s.status,
      qrcode: s.status === 'connected' ? null : s.qr,
    };
  }

  /** Força novo pareamento: limpa credenciais e reconecta pra gerar QR novo. */
  async reset(channelId: string, organizationId: string): Promise<void> {
    const s = this.sessions.get(channelId);
    try {
      s?.sock?.end?.(undefined);
    } catch {
      /* noop */
    }
    this.sessions.delete(channelId);
    await this.authState.clear(channelId);
    await this.connect(channelId, organizationId);
  }

  /**
   * Envia texto. Lança se a sessão não estiver conectada (o caller traduz pra
   * erro apropriado / retry da fila outbound).
   */
  async sendContent(
    channelId: string,
    toJidOrNumber: string,
    content: any,
  ): Promise<{ id: string }> {
    const s = this.sessions.get(channelId);
    if (!s || s.status !== 'connected' || !s.sock) {
      throw new Error(`Sessão Baileys não conectada (canal=${channelId})`);
    }
    const jid = toJidOrNumber.includes('@')
      ? toJidOrNumber
      : await this.resolveNumberJid(channelId, s.sock, toJidOrNumber);
    const sent = await s.sock.sendMessage(jid, content);
    return { id: sent?.key?.id || '' };
  }

  /**
   * JID real de um número neste canal, para gravar como
   * `ContactChannel.externalId` já na ENTRADA do contato (antes da 1ª
   * mensagem). Best-effort: sessão desconectada ou falha do WhatsApp → `null`
   * e o caller segue com o telefone canônico (o envio resolve de novo).
   * Lança apenas quando o WhatsApp confirma que o número não existe.
   *
   *   lookupJid('ch1', '5573988688598') → '557388688598@s.whatsapp.net'
   */
  async lookupJid(channelId: string, number: string): Promise<string | null> {
    const s = this.sessions.get(channelId);
    if (!s || s.status !== 'connected' || !s.sock) return null;
    const jid = await this.resolveNumberJid(channelId, s.sock, number);
    // resolveNumberJid devolve o JID canônico como fallback quando o WhatsApp
    // não respondeu; só confiamos no que veio do cache (= confirmado).
    const digits = this.mapper.numberToJid(number).replace(/@.*$/, '');
    return this.jidCache.get(`${channelId}:${digits}`) === jid ? jid : null;
  }

  /** Cache canal+número → JID real (o WhatsApp não muda o JID de um número). */
  private readonly jidCache = new Map<string, string>();

  /**
   * Número solto (sem `@`) → JID REAL no WhatsApp.
   *
   * No Brasil, muitos celulares antigos estão registrados no WhatsApp SEM o
   * 9º dígito (`557388688598@s.whatsapp.net`). Montar o JID "canônico" com o 9
   * (`5573988688598@…`) aponta para um número que não existe no WhatsApp: o
   * envio é aceito (1 tique) e nunca chega — nem aparece no celular do
   * vendedor. Por isso perguntamos ao WhatsApp (`onWhatsApp`) qual das duas
   * formas existe e usamos essa. Nenhuma existe → erro claro (sem WhatsApp).
   */
  private async resolveNumberJid(channelId: string, sock: any, raw: string): Promise<string> {
    const canonicalJid = this.mapper.numberToJid(raw); // com o 9 quando aplicável
    const digits = canonicalJid.replace(/@.*$/, '');
    const key = `${channelId}:${digits}`;
    const cached = this.jidCache.get(key);
    if (cached) return cached;

    const candidates = [digits];
    // 55 + DDD + 9 + 8 dígitos → também testa sem o 9 (registro antigo).
    if (/^55\d{2}9\d{8}$/.test(digits)) candidates.push(digits.slice(0, 4) + digits.slice(5));

    try {
      const res: Array<{ jid: string; exists: boolean }> =
        (await sock.onWhatsApp(...candidates.map((d) => `${d}@s.whatsapp.net`))) ?? [];
      const hit = res.find((r) => r?.exists && r.jid);
      if (hit) {
        this.jidCache.set(key, hit.jid);
        return hit.jid;
      }
      if (res.length) {
        throw new Error(`O número ${digits} não tem WhatsApp (testado com e sem o 9º dígito).`);
      }
    } catch (err: any) {
      if (String(err?.message ?? '').includes('não tem WhatsApp')) throw err;
      this.logger.warn(`onWhatsApp falhou (canal=${channelId}, ${digits}): ${err?.message ?? err}`);
    }
    return canonicalJid; // sem resposta do WhatsApp: segue o comportamento anterior
  }

  /** Atalho pra texto (mantido por compatibilidade). */
  async sendText(
    channelId: string,
    toJidOrNumber: string,
    text: string,
  ): Promise<{ id: string }> {
    return this.sendContent(channelId, toJidOrNumber, { text });
  }

  // --------------------------------------------------------------------------

  private async connect(
    channelId: string,
    organizationId: string,
  ): Promise<void> {
    const existing = this.sessions.get(channelId);
    if (existing?.starting || existing?.status === 'connected') return;

    const s: SessionState = existing ?? {
      sock: null,
      organizationId,
      status: 'connecting',
      qr: null,
      phone: null,
      starting: true,
      reconnectAttempts: 0,
    };
    s.starting = true;
    s.status = 'connecting';
    s.organizationId = organizationId;
    this.sessions.set(channelId, s);

    try {
      if (!this.cachedVersion) {
        const { version } = await fetchLatestBaileysVersion();
        this.cachedVersion = version;
      }
      const { state, saveCreds } = await this.authState.load(channelId);

      const sock = makeWASocket({
        version: this.cachedVersion,
        auth: state,
        markOnlineOnConnect: false,
        browser: ['Kortia CRM', 'Chrome', '1.0.0'],
        logger: silentLogger(),
        syncFullHistory: false,
      });
      s.sock = sock;

      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', (update: any) => {
        this.onConnectionUpdate(channelId, organizationId, update).catch((e) =>
          this.logger.error(
            `connection.update canal=${channelId}: ${e?.message ?? e}`,
          ),
        );
      });

      sock.ev.on('messages.upsert', (evt: any) => {
        if (evt?.type !== 'notify') return; // ignora history-sync/append
        const msgs: any[] = evt?.messages ?? [];
        for (const m of msgs) {
          this.handleInbound(channelId, organizationId, m).catch((e) =>
            this.logger.error(
              `handleInbound canal=${channelId}: ${e?.message ?? e}`,
            ),
          );
        }
      });

      // Acks de entrega/leitura das NOSSAS mensagens (fromMe). Sem isto o inbox
      // mostrava 1 tique pra sempre nos canais Baileys (nunca recebíamos o
      // Entregue/Lido). Atualiza o status e emite pro front refletir.
      sock.ev.on('messages.update', (updates: any[]) => {
        this.handleStatusUpdate(channelId, organizationId, updates).catch((e) =>
          this.logger.warn(
            `messages.update canal=${channelId}: ${e?.message ?? e}`,
          ),
        );
      });
    } catch (e: any) {
      this.logger.error(`connect canal=${channelId}: ${e?.message ?? e}`);
      s.status = 'disconnected';
    } finally {
      s.starting = false;
    }
  }

  /** Ordem dos status pra não regredir (ex.: não voltar de READ pra SENT). */
  private statusRank(s: MessageStatus): number {
    const rank: Record<string, number> = {
      QUEUED: 0,
      SENT: 1,
      DELIVERED: 2,
      READ: 3,
      FAILED: 4,
    };
    return rank[s] ?? 0;
  }

  /** Código de status do Baileys (WAMessageStatus) → nosso MessageStatus. */
  private baileysStatusToOurs(code: number): MessageStatus | null {
    switch (code) {
      case 0:
        return MessageStatus.FAILED; // ERROR
      case 2:
        return MessageStatus.SENT; // SERVER_ACK
      case 3:
        return MessageStatus.DELIVERED; // DELIVERY_ACK
      case 4:
      case 5:
        return MessageStatus.READ; // READ / PLAYED
      default:
        return null; // 1 = PENDING / desconhecido
    }
  }

  /**
   * Aplica os acks de entrega/leitura das mensagens que NÓS enviamos (fromMe).
   * Casa pela nossa `externalId` (= key.id do Baileys), avança o status sem
   * regredir e emite `message:status` pro inbox atualizar os tiques.
   */
  private async handleStatusUpdate(
    channelId: string,
    organizationId: string,
    updates: any[],
  ): Promise<void> {
    for (const u of updates ?? []) {
      const key = u?.key;
      const upd = u?.update;
      if (!key?.fromMe || !key?.id || !upd) continue;
      const code = Number(upd.status);
      if (!Number.isFinite(code)) continue;
      const next = this.baileysStatusToOurs(code);
      if (!next) continue;

      const msg = await this.prisma.message.findFirst({
        where: {
          externalId: key.id,
          conversation: { is: { channelId, organizationId } },
        },
        select: { id: true, status: true, conversationId: true },
      });
      if (!msg) continue;

      // FAILED vence (a não ser que já tenha sido lida); senão só avança.
      if (next !== MessageStatus.FAILED) {
        if (this.statusRank(next) <= this.statusRank(msg.status)) continue;
      } else if (msg.status === MessageStatus.READ) {
        continue;
      }

      const data: Record<string, any> = { status: next };
      if (next === MessageStatus.DELIVERED) data.deliveredAt = new Date();
      if (next === MessageStatus.READ) data.readAt = new Date();
      await this.prisma.message
        .update({ where: { id: msg.id }, data })
        .catch(() => undefined);

      this.realtime.emitToConversation(msg.conversationId, 'message:status', {
        messageId: msg.id,
        status: next,
        conversationId: msg.conversationId,
      });
    }
  }

  private async onConnectionUpdate(
    channelId: string,
    organizationId: string,
    update: any,
  ): Promise<void> {
    const s = this.sessions.get(channelId);
    if (!s) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        s.qr = await QRCode.toDataURL(qr);
        s.status = 'connecting';
      } catch (e: any) {
        this.logger.warn(`QR render canal=${channelId}: ${e?.message ?? e}`);
      }
    }

    if (connection === 'open') {
      s.status = 'connected';
      s.qr = null;
      s.reconnectAttempts = 0;
      const jid: string | undefined = s.sock?.user?.id;
      s.phone = jid ? this.mapper.jidToNumber(jid) : s.phone;
      await this.persistStatus(channelId, 'connected', s.phone);
      this.logger.log(
        `Baileys conectado canal=${channelId} phone=${s.phone ?? '?'}`,
      );
    } else if (connection === 'close') {
      const code =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.output?.payload?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      s.status = 'disconnected';
      if (loggedOut) {
        // Deslogado no celular: credenciais inválidas, exige novo QR.
        await this.authState.clear(channelId);
        this.sessions.delete(channelId);
        await this.persistStatus(channelId, 'disconnected', null);
        this.logger.warn(
          `Baileys loggedOut canal=${channelId} — precisa parear de novo`,
        );
      } else {
        s.reconnectAttempts += 1;
        const delay = Math.min(30000, 2000 * s.reconnectAttempts);
        this.logger.warn(
          `Baileys close canal=${channelId} code=${code} — reconecta em ${delay}ms (tentativa ${s.reconnectAttempts})`,
        );
        setTimeout(() => {
          this.connect(channelId, organizationId).catch((e) =>
            this.logger.error(
              `reconnect canal=${channelId}: ${e?.message ?? e}`,
            ),
          );
        }, delay);
      }
    }
  }

  private async handleInbound(
    channelId: string,
    organizationId: string,
    waMsg: any,
  ): Promise<void> {
    const message = this.mapper.normalizeInbound(waMsg);
    if (!message) return;

    // Mídia recebida (cliente -> Kortia): o WhatsApp entrega cifrado pelo
    // socket, então baixamos os bytes e re-hospedamos no storage, preenchendo
    // content.mediaUrl (mesmo formato durável dos outros canais).
    if (this.mapper.isMedia(message.type) && !message.content.mediaUrl) {
      await this.downloadAndAttachMedia(channelId, waMsg, message);
    }

    // Ecos (mensagens enviadas pelo próprio número, ex.: pelo celular) entram
    // no mesmo fluxo dos webhooks — o pipeline decide o que fazer com isEcho.
    await this.inboundQueue.add(
      'process-inbound',
      { channelId, organizationId, message },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  private async downloadAndAttachMedia(
    channelId: string,
    waMsg: any,
    message: { content: any; externalMessageId: string },
  ): Promise<void> {
    const s = this.sessions.get(channelId);
    try {
      const buffer = (await downloadMediaMessage(
        waMsg,
        'buffer',
        {},
        {
          logger: silentLogger(),
          reuploadRequest: s?.sock?.updateMediaMessage,
        } as any,
      )) as Buffer;
      const saved = await this.uploads.saveInboundMedia({
        buffer,
        mimeType: message.content?.mimeType || 'application/octet-stream',
        channelId,
        originalFilename: message.content?.fileName || null,
      });
      message.content.mediaUrl = saved.url;
      message.content.mimeType = saved.mimeType;
      message.content.fileSize = saved.size;
    } catch (e: any) {
      // Não bloqueia: sem mediaUrl a msg ainda entra (o inbox mostra o tipo).
      this.logger.error(
        `download mídia canal=${channelId} msg=${message.externalMessageId}: ${e?.message ?? e}`,
      );
    }
  }

  private async persistStatus(
    channelId: string,
    status: ConnStatus,
    phone: string | null,
  ): Promise<void> {
    try {
      await this.prisma.whatsappBaileysSession.updateMany({
        where: { channelId },
        data: { status, ...(phone ? { phone } : {}) },
      });
    } catch (e: any) {
      this.logger.warn(`persistStatus canal=${channelId}: ${e?.message ?? e}`);
    }
  }
}
