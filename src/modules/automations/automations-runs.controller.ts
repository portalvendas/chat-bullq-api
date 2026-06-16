import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AutomationRunStatus, Prisma } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { PrismaService } from '../../database/prisma.service';

const MAX_PAGE_SIZE = 100;

@ApiTags('Automations / Runs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('automations')
export class AutomationsRunsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id/runs')
  @ApiOperation({
    summary: 'List execution history of an automation (paged, newest first)',
  })
  async listRuns(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Query('limit') limit = '50',
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ) {
    const automation = await this.prisma.automation.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!automation) throw new NotFoundException('Automation not found');

    const take = Math.min(Number(limit) || 50, MAX_PAGE_SIZE);

    const where: Prisma.AutomationRunWhereInput = {
      automationId: id,
      organizationId: orgId,
    };
    if (status && this.isRunStatus(status)) {
      where.status = status;
    }

    const runs = await this.prisma.automationRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: take + 1, // +1 to detect next page existence
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = runs.length > take;
    const page = hasMore ? runs.slice(0, take) : runs;
    return {
      data: page,
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    };
  }

  @Get(':id/stats')
  @ApiOperation({ summary: 'Aggregate counters for an automation' })
  async stats(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
  ) {
    const automation = await this.prisma.automation.findFirst({
      where: { id, organizationId: orgId },
      select: {
        runCount: true,
        successCount: true,
        failureCount: true,
        consecutiveFailures: true,
        lastRunAt: true,
        autoPausedAt: true,
        autoPausedReason: true,
      },
    });
    if (!automation) throw new NotFoundException('Automation not found');
    return automation;
  }

  private isRunStatus(value: string): value is AutomationRunStatus {
    return (
      value === 'SUCCESS' ||
      value === 'PARTIAL' ||
      value === 'FAILED' ||
      value === 'SKIPPED'
    );
  }
}
