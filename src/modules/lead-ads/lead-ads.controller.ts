import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
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
  constructor(private readonly service: LeadAdsService) {}

  // ─── Webhook (público) ─────────────────────────
  @Get('webhooks/meta/leadads')
  @ApiOperation({ summary: 'Verificação do webhook Meta Leads Ads' })
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const result = this.service.verify(mode, token, challenge);
    return result ?? 'forbidden';
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
      // ficar reentregando (o log registra o descarte).
      return { received: false };
    }
    const changes = this.service.extractLeadgenChanges(body);
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
