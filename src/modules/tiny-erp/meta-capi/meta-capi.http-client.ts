import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface CapiEvent {
  event_name: string;
  event_time: number;
  event_id?: string;
  action_source: string;
  event_source_url?: string;
  user_data: Record<string, any>;
  custom_data?: Record<string, any>;
}

export interface CapiSendResult {
  ok: boolean;
  httpStatus: number;
  fbTraceId?: string;
  eventsReceived?: number;
  error?: string;
}

/**
 * Cliente da Conversions API (Graph API) da Meta.
 * POST https://graph.facebook.com/{version}/{pixelId}/events?access_token=...
 * Corpo: { data: [event], test_event_code? }.
 */
@Injectable()
export class MetaCapiHttpClient {
  private readonly logger = new Logger(MetaCapiHttpClient.name);

  async sendEvents(params: {
    pixelId: string;
    accessToken: string;
    apiVersion: string;
    events: CapiEvent[];
    testEventCode?: string | null;
  }): Promise<CapiSendResult> {
    const { pixelId, accessToken, apiVersion, events, testEventCode } = params;
    const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/events`;
    const body: Record<string, any> = { data: events };
    if (testEventCode) body.test_event_code = testEventCode;

    try {
      const { data, status } = await axios.post(url, body, {
        params: { access_token: accessToken },
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      });
      return {
        ok: true,
        httpStatus: status,
        fbTraceId: data?.fbtrace_id,
        eventsReceived: data?.events_received,
      };
    } catch (err: any) {
      const status = err?.response?.status ?? 0;
      const metaErr = err?.response?.data?.error;
      const msg = metaErr?.message || err?.message || 'CAPI error';
      this.logger.warn(`CAPI send falhou [${status}]: ${msg}`);
      return {
        ok: false,
        httpStatus: status,
        fbTraceId: metaErr?.fbtrace_id,
        error: msg,
      };
    }
  }
}
