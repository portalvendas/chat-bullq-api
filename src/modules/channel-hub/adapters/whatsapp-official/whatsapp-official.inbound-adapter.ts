import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppCoexistenceService } from './whatsapp-coexistence.service';

@Injectable()
export class WhatsAppOfficialInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_OFFICIAL;
  private readonly logger = new Logger(WhatsAppOfficialInboundAdapter.name);
  /** Teto defensivo de mensagens de histórico processadas por webhook. */
  private static readonly HISTORY_CAP = 500;

  constructor(
    private readonly mapper: WhatsAppOfficialMessageMapper,
    private readonly coexistence: WhatsAppCoexistenceService,
  ) {}

  extractLocators(payload: unknown): ChannelLocator[] {
    const body = (payload ?? {}) as Record<string, any>;
    const entries: any[] = body?.entry || [];
    const seen = new Set<string>();
    const locators: ChannelLocator[] = [];

    for (const entry of entries) {
      const businessAccountId: string | undefined = entry?.id
        ? String(entry.id)
        : undefined;
      const changes = entry?.changes || [];
      for (const change of changes) {
        const metadata = change?.value?.metadata || {};
        const phoneNumberId: string | undefined = metadata.phone_number_id
          ? String(metadata.phone_number_id)
          : undefined;
        const key = `${businessAccountId ?? '-'}:${phoneNumberId ?? '-'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const locator: ChannelLocator = {};
        if (phoneNumberId) locator.phoneNumberId = phoneNumberId;
        if (businessAccountId) locator.businessAccountId = businessAccountId;
        if (phoneNumberId || businessAccountId) locators.push(locator);
      }
    }

    return locators;
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    if (locator.phoneNumberId && config.phoneNumberId) {
      return String(config.phoneNumberId) === locator.phoneNumberId;
    }
    if (locator.businessAccountId && config.businessAccountId) {
      return String(config.businessAccountId) === locator.businessAccountId;
    }
    return false;
  }

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    _webhookSecret?: string,
    channel?: Channel,
  ): boolean {
    const appSecret = (channel?.config as Record<string, any> | undefined)
      ?.appSecret;
    if (!appSecret) {
      this.logger.warn(
        `WA Official channel ${channel?.id} missing config.appSecret — rejecting webhook`,
      );
      return false;
    }

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  parseWebhook(payload: unknown, channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };

    try {
      const body = payload as Record<string, any>;
      const entries = body?.entry || [];
      const rawExpected = (channel?.config as any)?.phoneNumberId;
      const expectedPhoneNumberId = rawExpected ? String(rawExpected) : undefined;

      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value;
          if (!value) continue;

          const metadataPhoneId = value.metadata?.phone_number_id
            ? String(value.metadata.phone_number_id)
            : undefined;
          // Strict scoping: drop events for a different phone_number_id
          if (
            expectedPhoneNumberId &&
            metadataPhoneId &&
            metadataPhoneId !== expectedPhoneNumberId
          ) {
            continue;
          }

          const field = change?.field;

          // ─── COEXISTENCE ───────────────────────────────────────────────
          // Mensagens que o lojista mandou pelo APP WhatsApp Business.
          if (field === 'smb_message_echoes') {
            for (const echo of value.message_echoes || []) {
              const n = this.mapper.normalizeEcho(echo);
              if (n) result.messages.push(n);
            }
            continue;
          }

          // Histórico (até 180 dias). Cap defensivo por webhook.
          if (field === 'history') {
            const businessPhone = value.metadata?.display_phone_number;
            let count = 0;
            for (const h of value.history || []) {
              for (const thread of h.threads || []) {
                for (const m of thread.messages || []) {
                  if (count >= WhatsAppOfficialInboundAdapter.HISTORY_CAP) break;
                  const n = this.mapper.normalizeHistoryMessage(
                    m,
                    thread.id,
                    businessPhone,
                  );
                  if (n) {
                    result.messages.push(n);
                    count++;
                  }
                }
              }
            }
            continue;
          }

          // Mudança de conta: offboard (desconectou pelo app) / reconnect.
          if (field === 'account_update') {
            const event = value.event;
            if (
              channel &&
              (event === 'PARTNER_REMOVED' || event === 'ACCOUNT_OFFBOARDED')
            ) {
              void this.coexistence.handleOffboard(channel.id);
            } else if (channel && event === 'ACCOUNT_RECONNECTED') {
              void this.coexistence.handleReconnect(channel.id);
            }
            continue;
          }

          // Contatos do address book (smb_app_state_sync): v1 ignora — os
          // contatos materializam das threads de mensagem.
          if (field === 'smb_app_state_sync') {
            continue;
          }
          // ───────────────────────────────────────────────────────────────

          const contacts = value.contacts || [];
          const messages = value.messages || [];
          const statuses = value.statuses || [];

          for (const msg of messages) {
            const contact =
              contacts.find((c: any) => c.wa_id === msg.from) || {};
            const normalized = this.mapper.normalizeInbound(msg, contact);
            if (normalized) {
              result.messages.push(normalized);
            }
          }

          for (const status of statuses) {
            const normalized = this.mapper.normalizeStatus(status);
            if (normalized) {
              result.statuses.push(normalized);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse WA Official webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    query: Record<string, string>,
    webhookSecret?: string,
    channel?: Channel,
  ): VerificationResponse {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    const verifyToken =
      (channel?.config as Record<string, any> | undefined)?.verifyToken ||
      webhookSecret;

    if (mode === 'subscribe' && verifyToken && token === verifyToken) {
      this.logger.log('Meta webhook verification successful');
      return { statusCode: 200, body: challenge };
    }

    this.logger.warn('Meta webhook verification failed');
    return { statusCode: 403, body: { error: 'Verification failed' } };
  }
}
