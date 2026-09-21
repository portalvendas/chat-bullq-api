import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios from 'axios';

interface WaConfig {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
}

export interface WaSendResult {
  wamid: string | null;
}
export class WaSendError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/** Códigos de erro da Meta que NÃO adianta retentar (falha permanente). */
const PERMANENT_CODES = new Set([
  '131026', // Message undeliverable
  '131047', // Re-engagement required
  '131051', // Unsupported message type
  '131053', // Media upload error
  '132000', // template param mismatch
  '132001', // template not found
  '470', // re-engagement / template
  '131009', // parameter value invalid
  '100', // invalid parameter
]);

/**
 * Envia mensagem de template pelo WhatsApp Cloud API, direto pela config do
 * canal (self-contained; não acopla ao channel-hub). Classifica o erro em
 * permanente (→ FAILED sem retry) ou transitório (→ throw, backoff do BullMQ).
 */
@Injectable()
export class BroadcastWaSender {
  private readonly logger = new Logger(BroadcastWaSender.name);

  private config(channel: Channel): WaConfig {
    const cfg = (channel.config as any) ?? {};
    if (!cfg.accessToken || !cfg.phoneNumberId) {
      throw new WaSendError('Canal sem accessToken/phoneNumberId', null, true);
    }
    return {
      accessToken: cfg.accessToken,
      phoneNumberId: cfg.phoneNumberId,
      apiVersion: cfg.apiVersion || 'v21.0',
    };
  }

  phoneNumberId(channel: Channel): string {
    return this.config(channel).phoneNumberId;
  }

  async sendTemplate(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<WaSendResult> {
    const cfg = this.config(channel);
    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`,
        payload,
        {
          headers: { Authorization: `Bearer ${cfg.accessToken}` },
          timeout: 30000,
        },
      );
      return { wamid: data?.messages?.[0]?.id ?? null };
    } catch (err: any) {
      const metaErr = err?.response?.data?.error;
      const code = metaErr?.code != null ? String(metaErr.code) : null;
      const msg = metaErr?.message || err?.message || 'erro no envio';
      const httpStatus = err?.response?.status;
      // 4xx (exceto 429) e códigos permanentes → não retenta.
      const permanent =
        (code && PERMANENT_CODES.has(code)) ||
        (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429);
      throw new WaSendError(msg, code, !!permanent);
    }
  }
}
