import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Res,
  Logger,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { Public, CurrentOrg } from '../../common/decorators';
import { TinyService } from './tiny.service';

/**
 * Integração com o ERP Olist Tiny (rotas autenticadas).
 *  - GET /tiny/oauth/start      → URL de consentimento
 *  - GET /tiny/status           → estado da conexão
 *  - POST /tiny/sync            → sincroniza agora (manual)
 *  - GET /tiny/documents?contactId= → pedidos/orçamentos do lead
 *  - DELETE /tiny/connection    → desconecta
 *
 * O callback do OAuth é PÚBLICO (o Tiny redireciona o browser sem nosso JWT)
 * e vive no {@link TinyOAuthCallbackController} pra não colidir com os guards.
 */
@ApiTags('Tiny ERP')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('tiny')
export class TinyController {
  constructor(private readonly service: TinyService) {}

  @Get('oauth/start')
  @ApiOperation({ summary: 'URL de consentimento OAuth do Tiny' })
  start(@CurrentOrg('id') orgId: string): Promise<{ url: string }> {
    return this.service.startOAuth(orgId);
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

  @Get('summary')
  @ApiOperation({ summary: 'Totais de pedidos e propostas + por vendedor (cards do topo)' })
  summary(
    @CurrentOrg('id') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.summary(orgId, from, to);
  }

  @Get('orders')
  @ApiOperation({ summary: 'Lista paginada de pedidos/orçamentos com o lead vinculado' })
  orders(
    @CurrentOrg('id') orgId: string,
    @Query('kind') kind: 'PEDIDO' | 'ORCAMENTO',
    @Query('page') page = '1',
    @Query('limit') limit = '30',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const k = kind === 'ORCAMENTO' ? 'ORCAMENTO' : 'PEDIDO';
    return this.service.listDocuments(orgId, k, Number(page) || 1, Number(limit) || 30, from, to);
  }

  @Get('documents/:id/items')
  @ApiOperation({ summary: 'Itens de um pedido/orçamento (sob demanda)' })
  items(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.getItems(orgId, id);
  }

  @Delete('connection')
  @ApiOperation({ summary: 'Desconecta a integração Tiny' })
  async disconnect(@CurrentOrg('id') orgId: string) {
    await this.service.disconnect(orgId);
    return { ok: true };
  }
}

/**
 * Callback OAuth do Tiny — PÚBLICO. O Tiny redireciona o browser pra cá
 * (sem JWT); identificamos a org pelo `state` assinado e voltamos pro front.
 * Controller separado porque `@Public()` não desliga guards aplicados via
 * `@UseGuards` de classe — só o guard global. Sem guards de classe aqui, o
 * `@Public()` cobre a rota.
 */
@ApiTags('Tiny ERP')
@Controller('tiny/oauth')
export class TinyOAuthCallbackController {
  private readonly logger = new Logger(TinyOAuthCallbackController.name);

  constructor(
    private readonly service: TinyService,
    private readonly config: ConfigService,
  ) {}

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth do Tiny (redireciona pro front)' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '').replace(/\/$/, '');
    const done = (q: string) => res.redirect(`${webUrl}/settings/integracoes?${q}`);
    try {
      if (!code || !state) throw new Error('code/state ausentes');
      await this.service.handleCallback(code, state);
      return done('tiny=connected');
    } catch (err: any) {
      this.logger.error(`Callback OAuth Tiny falhou: ${err?.message ?? err}`);
      return done('tiny=error');
    }
  }
}
