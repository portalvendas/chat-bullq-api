import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationType } from '@prisma/client';
import { NotificationsRepository } from './notifications.repository';
import { PrismaService } from '../../database/prisma.service';
import { LeadScopeService } from '../lead-distribution/lead-scope.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly prisma: PrismaService,
    @InjectQueue('notifications') private readonly notifQueue: Queue,
    private readonly leadScope: LeadScopeService,
  ) {}

  /**
   * Notificação sobre um LEAD/conversa que já tem vendedora: as OUTRAS
   * vendedoras não recebem (cada uma só vê os próprios leads). Gestores e a
   * dona continuam recebendo. Sem conversa/dono → não filtra.
   */
  private async dropOtherSellers(
    organizationId: string,
    recipients: string[],
    data?: Record<string, any>,
  ): Promise<string[]> {
    const conversationId = data?.conversationId as string | undefined;
    if (!conversationId) return recipients;
    try {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        select: { assignedToId: true },
      });
      const owner = conv?.assignedToId;
      if (!owner) return recipients;
      const sellers = await this.leadScope.sellerIds(organizationId);
      return recipients.filter((id) => id === owner || !sellers.has(id));
    } catch (err: any) {
      this.logger.warn(`dropOtherSellers falhou: ${err?.message ?? err}`);
      return recipients;
    }
  }

  async notify(params: {
    recipientId: string;
    organizationId: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const notification = await this.repository.create({
      recipientId: params.recipientId,
      organizationId: params.organizationId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data || {},
    });

    await this.notifQueue.add('deliver', {
      notificationId: notification.id,
      recipientId: params.recipientId,
      organizationId: params.organizationId,
      type: params.type,
      title: params.title,
      body: params.body,
      data: params.data,
    });

    return notification;
  }

  async notifyOrgAgents(params: {
    organizationId: string;
    excludeUserId?: string;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const members = await this.prisma.userOrganization.findMany({
      where: { organizationId: params.organizationId },
      select: { userId: true },
    });

    const recipients = await this.dropOtherSellers(
      params.organizationId,
      members.map((m) => m.userId).filter((id) => id !== params.excludeUserId),
      params.data,
    );

    for (const recipientId of recipients) {
      await this.notify({
        recipientId,
        organizationId: params.organizationId,
        type: params.type,
        title: params.title,
        body: params.body,
        data: params.data,
      });
    }
  }

  /**
   * Notifica o RESPONSÁVEL (assignedTo) + os GESTORES (OWNER/ADMIN) da org.
   * Dedupe automático (se o responsável é gestor, recebe uma vez) e exclui o
   * ator que gerou o evento (excludeUserId), pra ele não se auto-notificar.
   */
  async notifyManagersAndUser(params: {
    organizationId: string;
    responsibleUserId?: string | null;
    excludeUserId?: string | null;
    type: NotificationType;
    title: string;
    body: string;
    data?: Record<string, any>;
  }) {
    const managers = await this.prisma.userOrganization.findMany({
      where: {
        organizationId: params.organizationId,
        role: { in: ['OWNER', 'ADMIN'] },
      },
      select: { userId: true },
    });

    const recipients = new Set<string>(managers.map((m) => m.userId));
    if (params.responsibleUserId) recipients.add(params.responsibleUserId);
    if (params.excludeUserId) recipients.delete(params.excludeUserId);
    const allowed = await this.dropOtherSellers(params.organizationId, [...recipients], params.data);

    for (const recipientId of allowed) {
      await this.notify({
        recipientId,
        organizationId: params.organizationId,
        type: params.type,
        title: params.title,
        body: params.body,
        data: params.data,
      });
    }
    return { delivered: allowed.length };
  }

  async findByUser(userId: string, orgId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;
    const { notifications, total } = await this.repository.findByUser(userId, orgId, skip, limit);
    const unreadCount = await this.repository.countUnread(userId, orgId);
    return {
      notifications,
      unreadCount,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async markRead(id: string) {
    return this.repository.markRead(id);
  }

  async markAllRead(userId: string, orgId: string) {
    return this.repository.markAllRead(userId, orgId);
  }

  async getUnreadCount(userId: string, orgId: string) {
    return this.repository.countUnread(userId, orgId);
  }
}
