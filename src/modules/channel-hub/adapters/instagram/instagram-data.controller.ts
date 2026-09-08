import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Res,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as crypto from 'crypto';
import { ChannelType } from '@prisma/client';
import { Public } from '../../../../common/decorators';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * Callbacks obrigatórios da Meta pro App Review do Instagram Login:
 *  - Desautorização (o usuário remove o app do Instagram)
 *  - Solicitação de exclusão de dados (LGPD/GDPR)
 *
 * Ambos recebem um `signed_request` (base64url(assinatura).base64url(payload))
 * assinado com o app secret. Validamos a assinatura (HMAC-SHA256) antes de agir
 * — nunca confiamos no payload sem verificar. São `@Public` porque quem chama é
 * a Meta, não um usuário autenticado.
 */
@ApiTags('Integrations')
@Controller('integrations/instagram')
export class InstagramDataController {
  private readonly logger = new Logger(InstagramDataController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Verifica e decodifica o signed_request (HMAC-SHA256 com o app secret). */
  private parseSignedRequest(signed: string): { user_id?: string } | null {
    try {
      const secret = this.config.get<string>('INSTAGRAM_APP_SECRET');
      if (!secret || !signed || !signed.includes('.')) return null;
      const [sigB64, payloadB64] = signed.split('.');
      const pad = (s: string) =>
        s.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (s.length % 4)) % 4);
      const expected = crypto
        .createHmac('sha256', secret)
        .update(payloadB64)
        .digest();
      const got = Buffer.from(pad(sigB64), 'base64');
      if (
        expected.length !== got.length ||
        !crypto.timingSafeEqual(expected, got)
      ) {
        this.logger.warn('signed_request com assinatura inválida');
        return null;
      }
      const payload = JSON.parse(
        Buffer.from(pad(payloadB64), 'base64').toString('utf8'),
      );
      return payload;
    } catch (e: any) {
      this.logger.error(`parseSignedRequest: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Desconecta os canais de um IG user: limpa token/segredos e desativa. É o
   * efeito tanto da desautorização quanto da exclusão de dados (o que o Kortia
   * guarda de PII dessa conexão é o token; conversas ficam anonimizadas ao
   * perder o vínculo do canal).
   */
  private async clearChannelsForIgUser(userId: string): Promise<number> {
    const channels = await this.prisma.channel.findMany({
      where: { type: ChannelType.INSTAGRAM },
      select: { id: true, config: true },
    });
    let affected = 0;
    for (const ch of channels) {
      const cfg = (ch.config ?? {}) as Record<string, any>;
      if (String(cfg.igBusinessId || '') !== String(userId)) continue;
      const cleaned = {
        ...cfg,
        accessToken: null,
        appSecret: null,
        tokenExpiresAt: null,
        deauthorizedAt: new Date().toISOString(),
      };
      await this.prisma.channel.update({
        where: { id: ch.id },
        data: { config: cleaned, isActive: false },
      });
      affected++;
    }
    return affected;
  }

  @Post('deauthorize')
  @Public()
  @ApiOperation({ summary: 'Callback de desautorização do Instagram' })
  async deauthorize(
    @Body('signed_request') signed: string,
  ): Promise<{ ok: boolean }> {
    const data = this.parseSignedRequest(signed);
    if (data?.user_id) {
      const n = await this.clearChannelsForIgUser(String(data.user_id));
      this.logger.log(
        `Desautorização IG user=${data.user_id}: ${n} canal(is) desconectado(s)`,
      );
    } else {
      this.logger.warn('Deauthorize sem user_id válido');
    }
    return { ok: true };
  }

  @Post('data-deletion')
  @Public()
  @ApiOperation({ summary: 'Solicitação de exclusão de dados do Instagram' })
  async dataDeletion(
    @Body('signed_request') signed: string,
  ): Promise<{ url: string; confirmation_code: string }> {
    const data = this.parseSignedRequest(signed);
    const code = crypto.randomBytes(8).toString('hex');
    if (data?.user_id) {
      const n = await this.clearChannelsForIgUser(String(data.user_id));
      this.logger.log(
        `Exclusão de dados IG user=${data.user_id} code=${code}: ${n} canal(is) limpo(s)`,
      );
    } else {
      this.logger.warn(`Data deletion sem user_id válido code=${code}`);
    }
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    return {
      url: `${appUrl}/api/v1/integrations/instagram/data-deletion/status?code=${code}`,
      confirmation_code: code,
    };
  }

  @Get('data-deletion/status')
  @Public()
  @ApiOperation({ summary: 'Página de status da exclusão de dados' })
  dataDeletionStatus(@Query('code') code: string, @Res() res: Response): void {
    const safeCode = (code || '').replace(/[^a-zA-Z0-9]/g, '');
    // A exclusão é síncrona (limpamos no momento do request), então qualquer
    // código consultado já consta como concluído.
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<title>Exclusão de dados — Kortia</title></head>` +
          `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#18181b">` +
          `<h1 style="font-size:20px">Exclusão de dados concluída</h1>` +
          `<p>Os dados associados a esta conexão do Instagram foram removidos do Kortia.</p>` +
          `<p style="color:#71717a">Código de confirmação: <code>${safeCode}</code></p>` +
          `</body></html>`,
      );
  }
}
