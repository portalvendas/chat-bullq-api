import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../common/guards';
import { PendingActionService } from './pending-action.service';
import type { PendingAction } from './confirmation.types';

interface AuthedRequest {
  user?: { id?: string; sub?: string };
}

/**
 * REST endpoints for the destructive-action confirmation system.
 *
 *   GET    /pending-actions               -> list PENDING (optionally per conversation)
 *   GET    /pending-actions/:id           -> fetch one
 *   POST   /pending-actions/:id/approve   -> approve (only PENDING)
 *   POST   /pending-actions/:id/reject    -> reject  (only PENDING; reason required)
 */
@ApiTags('AI Pending Actions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('pending-actions')
export class PendingActionController {
  constructor(private readonly service: PendingActionService) {}

  @Get()
  @ApiOperation({
    summary:
      'List PENDING destructive actions. Optionally filter by conversationId.',
  })
  async list(
    @Query('conversationId') conversationId?: string,
  ): Promise<PendingAction[]> {
    return this.service.listPending(conversationId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single pending action by id.' })
  async get(@Param('id') id: string): Promise<PendingAction> {
    const action = await this.service.get(id);
    if (!action) throw new NotFoundException('Pending action not found');
    return action;
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a pending action and unlock execution.' })
  async approve(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Body() body: { text?: string },
  ): Promise<PendingAction> {
    const userId = this.requireUserId(req);
    return this.service.approve(id, userId, body?.text);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a pending action with a reason.' })
  async reject(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
    @Body() body: { reason: string },
  ): Promise<PendingAction> {
    const userId = this.requireUserId(req);
    return this.service.reject(id, userId, body?.reason ?? '');
  }

  private requireUserId(req: AuthedRequest): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      // Should never happen behind JwtAuthGuard, but keeps types safe.
      throw new NotFoundException('Authenticated user not found in request');
    }
    return userId;
  }
}
