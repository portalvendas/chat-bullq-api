import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { AiAgentsModule } from '../ai-agents/ai-agents.module';
import { ProposalRecoveryCoreModule } from './core/proposal-recovery-core.module';
import { ProposalRecoveryService } from './proposal-recovery.service';
import { ProposalRecoveryController } from './proposal-recovery.controller';
import { ProposalRecoveryCron, ProposalRecoveryProcessor } from './proposal-recovery.processor';
import { PROPOSAL_RECOVERY_QUEUE } from './proposal-recovery.constants';

@Module({
  imports: [
    PrismaModule,
    AiAgentsModule,
    ProposalRecoveryCoreModule,
    BullModule.registerQueue({ name: PROPOSAL_RECOVERY_QUEUE }),
  ],
  controllers: [ProposalRecoveryController],
  providers: [ProposalRecoveryService, ProposalRecoveryCron, ProposalRecoveryProcessor],
})
export class ProposalRecoveryModule {}
