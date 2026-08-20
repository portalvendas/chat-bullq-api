import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { ChatbotSessionService } from '../session/chatbot-session.service';
import { ChatbotFlowsRepository } from './chatbot-flows.repository';
import { CreateChatbotFlowDto, UpdateChatbotFlowDto, ChatbotNodeDto } from './dto/create-chatbot-flow.dto';

@Injectable()
export class ChatbotFlowsService {
  constructor(
    private readonly repository: ChatbotFlowsRepository,
    private readonly prisma: PrismaService,
    private readonly session: ChatbotSessionService,
    @InjectQueue('chatbot-processor') private readonly chatbotQueue: Queue,
  ) {}

  async create(organizationId: string, dto: CreateChatbotFlowDto) {
    return this.repository.create({
      organizationId,
      name: dto.name,
      description: dto.description,
      triggerType: dto.triggerType || 'KEYWORD',
      triggerConfig: dto.triggerConfig || {},
    });
  }

  async findAll(organizationId: string) {
    return this.repository.findByOrg(organizationId);
  }

  async findOne(id: string, organizationId: string) {
    const flow = await this.repository.findById(id);
    if (!flow) throw new NotFoundException('Chatbot flow not found');
    if (flow.organizationId !== organizationId) throw new ForbiddenException();
    return flow;
  }

  async update(id: string, organizationId: string, dto: UpdateChatbotFlowDto) {
    await this.findOne(id, organizationId);
    return this.repository.update(id, dto);
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  async saveNodes(id: string, organizationId: string, nodes: ChatbotNodeDto[]) {
    await this.findOne(id, organizationId);
    return this.repository.replaceNodes(
      id,
      nodes.map((n) => ({
        type: n.type,
        name: n.name,
        positionX: n.positionX,
        positionY: n.positionY,
        data: n.data,
        edges: n.edges,
      })),
    );
  }

  async linkChannels(id: string, organizationId: string, channelIds: string[]) {
    await this.findOne(id, organizationId);
    await this.repository.setChannels(id, channelIds);
    return this.findOne(id, organizationId);
  }

  async findActiveFlowForChannel(channelId: string) {
    return this.repository.findActiveFlowForChannel(channelId);
  }

  /**
   * Inicia MANUALMENTE este fluxo (salesbot) numa conversa específica —
   * usado, por ex., pela Auditoria de Funil ("aplicar salesbot no card").
   * Cria a sessão no nó START (avança pro próximo, igual ao engine) e
   * enfileira no processor do chatbot, que executa e ENVIA as mensagens
   * pelo mesmo caminho do disparo automático. Idempotente-ish: reinicia a
   * sessão se já houver uma.
   */
  async startOnConversation(
    organizationId: string,
    flowId: string,
    conversationId: string,
  ): Promise<{ ok: true; flowId: string; flowName: string }> {
    const flow = await this.repository.findById(flowId);
    if (!flow || flow.organizationId !== organizationId) {
      throw new NotFoundException('Fluxo não encontrado');
    }
    if (flow.deletedAt) throw new BadRequestException('Fluxo excluído');
    if (!flow.nodes?.length) {
      throw new BadRequestException('Fluxo sem nós configurados');
    }

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true, channelId: true, contactId: true },
    });
    if (!conv) throw new NotFoundException('Conversa não encontrada');
    if (!conv.contactId) {
      throw new BadRequestException('Conversa sem contato para o bot');
    }

    const cc = await this.prisma.contactChannel.findFirst({
      where: { contactId: conv.contactId, channelId: conv.channelId },
      select: { externalId: true },
    });
    if (!cc?.externalId) {
      throw new BadRequestException(
        'Contato sem canal para envio — o salesbot não tem por onde falar.',
      );
    }

    const startNode = flow.nodes.find((n) => n.type === 'START') ?? flow.nodes[0];
    await this.session.create(conversationId, flow.id, startNode.id);
    if (startNode.type === 'START') {
      const edges = (startNode.edges as any[]) ?? [];
      const nextId = edges[0]?.targetNodeId;
      if (nextId) {
        await this.session.update(conversationId, { currentNodeId: nextId });
      }
    }

    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { status: 'BOT' as any },
      })
      .catch(() => undefined);

    await this.chatbotQueue.add('run-manual', {
      conversationId,
      channelId: conv.channelId,
      contactExternalId: cc.externalId,
      organizationId,
      messageText: '',
    });

    return { ok: true, flowId: flow.id, flowName: flow.name };
  }
}
