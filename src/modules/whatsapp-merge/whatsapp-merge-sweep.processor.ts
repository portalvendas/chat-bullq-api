import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { WhatsappMergeService } from './whatsapp-merge.service';

export const WHATSAPP_MERGE_SWEEP_QUEUE = 'whatsapp-merge-sweep';
export const WHATSAPP_MERGE_SWEEP_JOB = 'sweep-duplicates';

/**
 * Rede de segurança para duplicados de contato do WhatsApp (Z-API).
 *
 * A unificação por telefone no ingest (ContactResolverService) já cobre o caso
 * comum, mas restam brechas raras — ex.: contato "echo-only" criado sem número
 * que descobre o telefone depois e colide com um contato já chaveado por
 * telefone. Este job varre periodicamente TODAS as orgs com canal Z-API e roda
 * o merge (LID + telefone) em modo EXECUTE. É idempotente: sem duplicado,
 * merged=0. Reusa a MESMA lógica testada dos endpoints /whatsapp-merge.
 */
@Processor(WHATSAPP_MERGE_SWEEP_QUEUE, { concurrency: 1 })
export class WhatsappMergeSweepProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappMergeSweepProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly merge: WhatsappMergeService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{
    orgs: number;
    lidMerged: number;
    phoneMerged: number;
    errors: number;
  }> {
    const orgs = await this.prisma.channel.findMany({
      where: { type: 'WHATSAPP_ZAPI' as any, deletedAt: null },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });

    let lidMerged = 0;
    let phoneMerged = 0;
    let errors = 0;

    for (const { organizationId } of orgs) {
      try {
        const lid = await this.merge.run(organizationId, true);
        const phone = await this.merge.runPhoneDuplicates(organizationId, true);
        lidMerged += lid.merged;
        phoneMerged += phone.merged;
        errors += (lid.errors?.length ?? 0) + (phone.errors?.length ?? 0);
        if (lid.merged || phone.merged) {
          this.logger.log(
            `whatsapp_merge_sweep org=${organizationId} lidMerged=${lid.merged} ` +
              `phoneMerged=${phone.merged} cards=${lid.cardsAbsorbed + phone.cardsAbsorbed}`,
          );
        }
      } catch (err: any) {
        errors += 1;
        this.logger.error(
          `whatsapp_merge_sweep falhou org=${organizationId}: ${err?.message ?? err}`,
        );
      }
    }

    if (lidMerged || phoneMerged || errors) {
      this.logger.log(
        `whatsapp_merge_sweep_done orgs=${orgs.length} lidMerged=${lidMerged} ` +
          `phoneMerged=${phoneMerged} errors=${errors}`,
      );
    }
    return { orgs: orgs.length, lidMerged, phoneMerged, errors };
  }
}
