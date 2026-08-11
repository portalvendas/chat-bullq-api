import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Res,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { Public, CurrentOrg } from '../../common/decorators';
import { TinyService } from './tiny.service';

/**
 * Integração com o ERP Olist Tiny.
 *  - GET /tiny/oauth/start      (autenticado) → URL de consentimento
 *  - GET /tiny/oauth/callback   (público)     → Tiny redireciona aqui; troca o
 *                                                code e volta pro front
 *  - GET /tiny/status           (autenticado) → estado da conexão
 *  - POST /tiny/sync            (autenticado) → sincroniza agora (manual)
 *  - GET /tiny/documents?contactId= (autenticado) → pedidos/orçamentos do lead
 *  - DELETE /tiny/connection    (autenticado) → desconecta
 */
@ApiTags('Tiny ERP')
@ApiBearerAuth()
@Controller('tiny')
export class TinyController {
  private readonly logger = new Logger(TinyController.name);

  constructor(
    private readonly service: TinyService,
    private readonly config: ConfigService,
  ) {}

  @Get('oauth/start')
  @ApiOperation({ summary: 'URL de consentimento OAuth do Tiny' })
  start(@CurrentOrg('id') orgId: string): Promise<{ url: string }> {
    return this.service.startOAuth(orgId);
  }

  @Get('oauth/callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth do Tiny (redireciona pro front)' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '').replace(/\/$/, '');
    const done = (q: string) => res.redirect(`${webUrl}/settings/integrations?${q}`);
    try {
      if (!code || !state) throw new Error('code/state ausentes');
      await this.service.handleCallback(code, state);
      return done('tiny=connected');
    } catch (err: any) {
      this.logger.error(`Callback OAuth Tiny falhou: ${err?.message ?? err}`);
      return done('tiny=error');
    }
  }

  @Get('status')
  @ApiOperation({ summary: 'Estado da conexão Tiny' })
  status(@CurrentOrg('id') orgId: string) {
    return this.service.getStatus(orgId);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sincroniza pedidos e orçamentos do Tiny agora' })
  sync(@CurrentOrg('id') orgId: string) {
    return this.service.syncNow(orgId);
  }

  @Get('documents')
  @ApiOperation({ summary: 'Pedidos e orçamentos vinculados a um lead' })
  documents(
    @CurrentOrg('id') orgId: string,
    @Query('contactId') contactId: string,
  ) {
    if (!contactId) throw new BadRequestException('contactId é obrigatório');
    return this.service.listForContact(orgId, contactId);
  }

  @Delete('connection')
  @ApiOperation({ summary: 'Desconecta a integração Tiny' })
  async disconnect(@CurrentOrg('id') orgId: string) {
    await this.service.disconnect(orgId);
    return { ok: true };
  }
}
