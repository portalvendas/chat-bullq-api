import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PermissionGroupsModule } from '../permission-groups/permission-groups.module';
import {
  BROADCAST_SEND_QUEUE,
  CONTACT_IMPORT_QUEUE,
  BROADCAST_RECONCILE_QUEUE,
} from './broadcast.constants';
import { BroadcastPricingService } from './pricing.service';
import { BroadcastBudgetService } from './budget.service';
import { BroadcastAudienceService } from './audience.service';
import { BroadcastEstimateService } from './estimate.service';
import { WaRateLimiter } from './wa-rate-limiter';
import { BroadcastWaSender } from './broadcast-wa.sender';
import { BroadcastService } from './broadcast.service';
import { BroadcastStatusService } from './broadcast-status.service';
import { BroadcastSendProcessor } from './broadcast-send.processor';
import { ContactImportService } from './contact-import.service';
import { ContactImportProcessor } from './contact-import.processor';
import {
  BroadcastReconcileCron,
  BroadcastReconcileProcessor,
} from './broadcast-reconcile.processor';
import {
  BroadcastController,
  BroadcastConfigController,
} from './broadcast.controller';
import { ContactImportController } from './contact-import.controller';
import { ModulePermissionGuard } from '../../common/guards/module-permission.guard';

@Module({
  imports: [
    PermissionGroupsModule,
    BullModule.registerQueue(
      { name: BROADCAST_SEND_QUEUE },
      { name: CONTACT_IMPORT_QUEUE },
      { name: BROADCAST_RECONCILE_QUEUE },
    ),
  ],
  controllers: [
    BroadcastConfigController,
    BroadcastController,
    ContactImportController,
  ],
  providers: [
    ModulePermissionGuard,
    BroadcastPricingService,
    BroadcastBudgetService,
    BroadcastAudienceService,
    BroadcastEstimateService,
    WaRateLimiter,
    BroadcastWaSender,
    BroadcastService,
    BroadcastStatusService,
    BroadcastSendProcessor,
    ContactImportService,
    ContactImportProcessor,
    BroadcastReconcileCron,
    BroadcastReconcileProcessor,
  ],
  exports: [BroadcastStatusService],
})
export class BroadcastModule {}
