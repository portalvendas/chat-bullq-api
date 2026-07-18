import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelType } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * Onboarding "Coexistence" do WhatsApp (Embedded Signup com
 * featureType=whatsapp_business_app_onboarding). O lojista escaneia um QR no
 * app WhatsApp Business; a Meta devolve pro frontend um `code` + `waba_id`.
 * Aqui trocamos o code por token, descobrimos o phone_number_id, assinamos o
 * app na WABA e criamos o canal WHATSAPP_OFFICIAL em modo coexistence — SEM
 * registrar o número (ele já está registrado no app). Depois disparamos o sync
 * de contatos + histórico (janela de 24h).
 *
 * ## Riscos / decisões
 * - API de terceiro (Graph) pode falhar em qualquer passo → cada chamada tem
 *   erro explícito e o onboarding aborta com mensagem clara (nada de canal
 *   meia-boca). O sync (contatos/histórico) é best-effort: se falhar, o canal
 *   já está utilizável e reprocessa-se via botão.
 * - Idempotência: canal chaveado por (org, phoneNumberId) — refazer o fluxo
 *   atualiza o mesmo canal em vez de duplicar.
 * - Segredos: APP_ID/APP_SECRET só via env. Token do lojista fica no config do
 *   canal (mesmo padrão do WhatsApp Official/ML/Shopee).
 */
@Injectable()
export class WhatsAppCoexistenceService {
  private readonly logger = new Logger(WhatsAppCoexistenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private graphVersion(): string {
    return this.config.get<string>('META_GRAPH_VERSION') || 'v21.0';
  }

  private graphBase(): string {
    return `https://graph.facebook.com/${this.graphVersion()}`;
  }

  private appCreds(): { appId: string; appSecret: string } {
    const appId = this.config.get<string>('META_APP_ID') || '';
    const appSecret = this.config.get<string>('META_APP_SECRET') || '';
    if (!appId || !appSecret) {
      throw new BadGatewayException(
        'Coexistence não configurado: defina META_APP_ID e META_APP_SECRET.',
      );
    }
    return { appId, appSecret };
  }

  /**
   * Fluxo completo de onboarding. Retorna os dados do canal criado/atualizado.
   */
  async onboard(
    organizationId: string,
    code: string,
    wabaId: string,
    name?: string,
  ): Promise<{
    channelId: string;
    phoneNumberId: string;
    displayPhoneNumber?: string;
  }> {
    if (!code || !wabaId) {
      throw new BadGatewayException('code e waba_id são obrigatórios');
    }

    const accessToken = await this.exchangeCode(code);
    const phone = await this.getFirstPhoneNumber(wabaId, accessToken);
    await this.subscribeApp(wabaId, accessToken);

    const channel = await this.upsertChannel(organizationId, {
      accessToken,
      wabaId,
      phoneNumberId: phone.id,
      displayPhoneNumber: phone.displayPhoneNumber,
      verifiedName: phone.verifiedName,
      name,
    });

    // Sync de contatos + histórico (best-effort, dentro da janela de 24h).
    await this.triggerSync(phone.id, accessToken);

    this.logger.log(
      `Coexistence conectado: canal ${channel.id} (waba ${wabaId}, phone ${phone.id})`,
    );
    return {
      channelId: channel.id,
      phoneNumberId: phone.id,
      displayPhoneNumber: phone.displayPhoneNumber,
    };
  }

  /** Troca o `code` do Embedded Signup por um token de negócio (system user). */
  private async exchangeCode(code: string): Promise<string> {
    const { appId, appSecret } = this.appCreds();
    try {
      const { data } = await axios.get(`${this.graphBase()}/oauth/access_token`, {
        params: {
          client_id: appId,
          client_secret: appSecret,
          code,
        },
        timeout: 20000,
      });
      if (!data?.access_token) {
        throw new Error(`resposta sem access_token: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data.access_token as string;
    } catch (err: any) {
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new BadGatewayException(`Falha ao trocar code por token: ${detail}`);
    }
  }

  /** Primeiro número da WABA (no coexistence normalmente há 1). */
  private async getFirstPhoneNumber(
    wabaId: string,
    accessToken: string,
  ): Promise<{
    id: string;
    displayPhoneNumber?: string;
    verifiedName?: string;
  }> {
    try {
      const { data } = await axios.get(
        `${this.graphBase()}/${wabaId}/phone_numbers`,
        {
          params: { fields: 'id,display_phone_number,verified_name,platform_type' },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 20000,
        },
      );
      const first = Array.isArray(data?.data) ? data.data[0] : null;
      if (!first?.id) {
        throw new Error('WABA sem phone number');
      }
      return {
        id: String(first.id),
        displayPhoneNumber: first.display_phone_number,
        verifiedName: first.verified_name,
      };
    } catch (err: any) {
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new BadGatewayException(`Falha ao obter phone_number da WABA: ${detail}`);
    }
  }

  /** Assina o app na WABA pra receber os webhooks (idempotente na Meta). */
  private async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    try {
      await axios.post(
        `${this.graphBase()}/${wabaId}/subscribed_apps`,
        {},
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 20000,
        },
      );
    } catch (err: any) {
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      throw new BadGatewayException(`Falha ao assinar app na WABA: ${detail}`);
    }
  }

  /**
   * Dispara sync de contatos + histórico. POST /{phoneNumberId}/smb_app_data.
   * Só pode ser chamado UMA vez por onboarding (Meta) — best-effort: se falhar,
   * logamos e seguimos (o canal já funciona).
   */
  private async triggerSync(
    phoneNumberId: string,
    accessToken: string,
  ): Promise<void> {
    for (const syncType of ['smb_app_state_sync', 'history']) {
      try {
        await axios.post(
          `${this.graphBase()}/${phoneNumberId}/smb_app_data`,
          { messaging_product: 'whatsapp', sync_type: syncType },
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 20000,
          },
        );
        this.logger.log(`Sync '${syncType}' disparado p/ phone ${phoneNumberId}`);
      } catch (err: any) {
        this.logger.warn(
          `Sync '${syncType}' falhou p/ ${phoneNumberId}: ${
            err?.response?.data ? JSON.stringify(err.response.data) : err.message
          }`,
        );
      }
    }
  }

  /** Cria/atualiza o canal WHATSAPP_OFFICIAL em modo coexistence. */
  private async upsertChannel(
    organizationId: string,
    data: {
      accessToken: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhoneNumber?: string;
      verifiedName?: string;
      name?: string;
    },
  ): Promise<Channel> {
    const verifyToken =
      this.config.get<string>('META_WA_VERIFY_TOKEN') || 'chatbullq';
    const config = {
      accessToken: data.accessToken,
      phoneNumberId: data.phoneNumberId,
      businessAccountId: data.wabaId,
      displayPhoneNumber: data.displayPhoneNumber ?? null,
      apiVersion: this.graphVersion(),
      coexistence: true,
    };

    // Idempotente: procura canal existente por phoneNumberId (filtro em JS —
    // Prisma JSON path é frágil).
    const candidates = await this.prisma.channel.findMany({
      where: { organizationId, type: ChannelType.WHATSAPP_OFFICIAL },
    });
    const existing = candidates.find(
      (c) =>
        String((c.config as Record<string, any>)?.phoneNumberId ?? '') ===
        data.phoneNumberId,
    );

    if (existing) {
      return this.prisma.channel.update({
        where: { id: existing.id },
        data: {
          isActive: true,
          config,
          webhookSecret: verifyToken,
        },
      });
    }

    return this.prisma.channel.create({
      data: {
        organizationId,
        type: ChannelType.WHATSAPP_OFFICIAL,
        name:
          data.name ||
          data.verifiedName ||
          `WhatsApp ${data.displayPhoneNumber ?? data.phoneNumberId}`,
        isActive: true,
        webhookSecret: verifyToken,
        config,
      },
    });
  }

  /**
   * Offboard (PARTNER_REMOVED / ACCOUNT_OFFBOARDED): desativa o canal e limpa o
   * token — a loja se desconectou pelo app WhatsApp Business.
   */
  async handleOffboard(channelId: string): Promise<void> {
    try {
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
      });
      if (!channel) return;
      const cfg = (channel.config ?? {}) as Record<string, any>;
      await this.prisma.channel.update({
        where: { id: channelId },
        data: {
          isActive: false,
          config: {
            ...cfg,
            accessToken: null,
            coexistenceOffboardedAt: new Date().toISOString(),
          },
        },
      });
      this.logger.log(`Canal ${channelId} desativado (offboard coexistence)`);
    } catch (err: any) {
      this.logger.error(
        `handleOffboard ${channelId} falhou: ${err?.message ?? err}`,
      );
    }
  }

  /** Reativa o canal (ACCOUNT_RECONNECTED). */
  async handleReconnect(channelId: string): Promise<void> {
    try {
      await this.prisma.channel.update({
        where: { id: channelId },
        data: { isActive: true },
      });
      this.logger.log(`Canal ${channelId} reativado (reconnect coexistence)`);
    } catch (err: any) {
      this.logger.warn(`handleReconnect ${channelId}: ${err?.message ?? err}`);
    }
  }
}
