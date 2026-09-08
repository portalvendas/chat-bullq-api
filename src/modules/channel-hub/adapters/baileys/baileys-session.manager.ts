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
import { ChannelType } from '@prisma/client';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import * as QRCode from 'qrcode';
import { PrismaService } from '../../../../database/prisma.service';
import { BaileysAuthStateService } from './baileys-auth-state.service';
import { BaileysMessageMapper } from './baileys.message-mapper';

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
      : this.mapper.numberToJid(toJidOrNumber);
    const sent = await s.sock.sendMessage(jid, content);
    return { id: sent?.key?.id || '' };
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
    } catch (e: any) {
      this.logger.error(`connect canal=${channelId}: ${e?.message ?? e}`);
      s.status = 'disconnected';
    } finally {
      s.starting = false;
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
