import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { TinyService } from './tiny.service';
import { TINY_QUEUE } from './tiny.cron.service';

/**
 * Roda o sync incremental do Tiny para TODAS as organizações com integração
 * ativa. Concorrência 1 (o cron dispara a cada 15min). Erro numa org não
 * derruba as outras — cada org é isolada num try/catch.
 */
@Processor(TINY_QUEUE, { concurrency: 1 })
export class TinyProcessor extends WorkerHost {
  private readonly logger = new Logger(TinyProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly service: TinyService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ orgs: number }> {
    const integs = await this.prisma.tinyIntegration.findMany({
      where: { status: 'active' },
      select: { organizationId: true },
    });
    for (const { organizationId } of integs) {
      try {
        const r = await this.service.syncNow(organizationId, { reconcile: true });
        this.logger.log(
          `tiny_sync org=${organizationId} pedidos=${r.pedidos} orcamentos=${r.orcamentos}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `tiny_sync falhou org=${organizationId}: ${err?.message ?? err}`,
        );
      }
    }
    return { orgs: integs.length };
  }
}
