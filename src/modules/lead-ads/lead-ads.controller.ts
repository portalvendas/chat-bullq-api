import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { LeadAdsService } from './lead-ads.service';

/**
 * Webhook público do Facebook Leads Ads (verificação + recebimento) e
 * endpoints autenticados para conectar páginas.
 */
@ApiTags('Lead Ads')
@Controller()
export class LeadAdsController {
  private readonly logger = new Logger(LeadAdsController.name);
  constructor(private readonly service: LeadAdsService) {}

  // ─── Webhook (público) ─────────────────────────
  @Get('webhooks/meta/leadads')
  @ApiOperation({ summary: 'Verificação do webhook Meta Leads Ads' })
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): void {
    const result = this.service.verify(mode, token, challenge);
    // A Meta exige o challenge CRU no corpo (sem wrapper JSON do interceptor).
    if (result === null) {
      res.status(403).send('Forbidden');
      return;
    }
    res.status(200).send(result);
  }

  @Post('webhooks/meta/leadads')
  @ApiOperation({ summary: 'Recebe eventos leadgen do Facebook' })
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: any,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<{ received: boolean }> {
    const ok = this.service.validateSignature(req.rawBody, signature);
    if (!ok) {
      // Assinatura inválida — não processa, mas responde 200 pra Meta não
      // ficar reentregando. Logamos pra diagnóstico (ex.: META_APP_SECRET
      // ausente/errado, ou rawBody indisponível).
      this.logger.warn(
        `Lead Ads webhook: assinatura inválida ou ausente (temSig=${!!signature}, temRawBody=${!!req.rawBody}). Evento descartado.`,
      );
      return { received: false };
    }
    const changes = this.service.extractLeadgenChanges(body);
    this.logger.log(
      `Lead Ads webhook: recebido com assinatura válida — ${changes.length} evento(s) leadgen`,
    );
    // Processa em background; responde rápido pra Meta.
    for (const change of changes) {
      void this.service.processLead(change);
    }
    return { received: true };
  }

  // ─── Config (autenticado) ──────────────────────
  @Get('lead-ads/pages')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard)
  @ApiOperation({ summary: 'Lista páginas de Lead Ads conectadas' })
  listPages(@CurrentOrg('id') orgId: string) {
    return this.service.listPages(orgId);
  }

  @Post('lead-ads/pages')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard)
  @ApiOperation({ summary: 'Conecta uma página de Lead Ads' })
  savePage(
    @CurrentOrg('id') orgId: string,
    @Body() dto: { pageId: string; pageName?: string; accessToken: string },
  ) {
    return this.service.savePage(orgId, dto);
  }

  @Delete('lead-ads/pages/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard)
  @ApiOperation({ summary: 'Remove uma página de Lead Ads' })
  removePage(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.removePage(orgId, id);
  }
}
