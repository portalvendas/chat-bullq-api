import { BadRequestException, Controller, Get, Header, Query, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { ConversionsReportService } from '../services/conversions-report.service';

/**
 * Relatórios para integrações (n8n, planilhas). Autenticação por chave pk_
 * (header Authorization: Bearer pk_…).
 */
@ApiTags('Public API · Reports')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/reports')
export class PublicReportsController {
  constructor(private readonly conversions: ConversionsReportService) {}

  @Get('conversions')
  @ApiOperation({
    summary:
      'Uma linha por pedido e por orçamento do Tiny, com origem do lead (canal, UTMs, anúncio de WhatsApp) e status do envio à Meta. Sem dados pessoais.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'YYYY-MM-DD (padrão: 90 dias atrás)' })
  @ApiQuery({ name: 'to', required: false, description: 'YYYY-MM-DD (padrão: hoje)' })
  @ApiQuery({ name: 'format', required: false, enum: ['json', 'csv'] })
  @Header('Cache-Control', 'no-store')
  async getConversions(
    @CurrentOrg('id') orgId: string,
    // @Res() manual: o CSV não pode passar pelo envelope global {data, meta}.
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('format') format?: string,
  ): Promise<void> {
    const range = parseRange(from, to);
    const report = await this.conversions.build(orgId, range);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="conversoes_${report.from}_${report.to}.csv"`,
      );
      res.send('﻿' + this.conversions.toCsv(report.rows));
      return;
    }
    // Mesmo envelope das outras rotas: { data, meta }.
    res.json({ data: report, meta: { timestamp: new Date().toISOString() } });
  }
}

function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !re.test(from)) || (to && !re.test(to))) {
    throw new BadRequestException('Use datas no formato YYYY-MM-DD.');
  }
  const now = new Date();
  const f = from ? new Date(`${from}T00:00:00-03:00`) : new Date(now.getTime() - 90 * 24 * 3600 * 1000);
  const t = to ? new Date(`${to}T23:59:59.999-03:00`) : now;
  if (f > t) throw new BadRequestException('"from" depois de "to".');
  return { from: f, to: t };
}
