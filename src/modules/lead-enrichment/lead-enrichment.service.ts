import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  CadastroData,
  extractFromText,
  extractFromMessages,
} from './lead-data-extractor';

/**
 * Enriquece o contato/card do lead com os dados pessoais que ele manda na
 * conversa (nome, CPF/CNPJ, nascimento, CEP, endereço, e-mail). Determinístico
 * (regex) e SEMPRE fill-empty-only: nunca sobrescreve um dado que já existe.
 * Alimenta também o match do CAPI (metadata.cpfCnpj + name/email).
 */
@Injectable()
export class LeadEnrichmentService {
  private readonly logger = new Logger(LeadEnrichmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Enriquece a partir de UMA mensagem (hook automático do inbound). */
  async enrichFromText(
    organizationId: string,
    contactId: string,
    text?: string | null,
  ): Promise<{ applied: string[] }> {
    if (!text || !text.trim()) return { applied: [] };
    return this.persist(organizationId, contactId, extractFromText(text));
  }

  /**
   * Reprocessa a conversa inteira (botão "Extrair dados"): lê as mensagens
   * INBOUND de texto, consolida e persiste. Retorna o que foi aplicado + o
   * cadastro atual do contato.
   */
  async enrichFromConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<{ applied: string[]; contactId: string | null; cadastro: CadastroData }> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { contactId: true },
    });
    if (!conv?.contactId) return { applied: [], contactId: null, cadastro: {} };

    const msgs = await this.prisma.message.findMany({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: { content: true },
    });
    const texts = msgs
      .map((m) => {
        const c = (m.content ?? {}) as any;
        return typeof c.text === 'string' ? c.text : '';
      })
      .filter(Boolean)
      .reverse(); // ordem cronológica

    const parsed = extractFromMessages(texts);
    const { applied } = await this.persist(organizationId, conv.contactId, parsed);
    const cadastro = await this.currentCadastro(conv.contactId);
    return { applied, contactId: conv.contactId, cadastro };
  }

  /**
   * EXECUÇÃO AUTOMÁTICA EM LOTE: varre as conversas com atividade de entrada
   * recente e enriquece cada uma (fill-empty). Pega o que o hook por mensagem
   * eventualmente não cobriu e também conversas antigas reativadas. Chamado pelo
   * cron. @example { scanned: 120, enriched: 18 }
   */
  async enrichRecentConversations(
    sinceDays = 2,
    limit = 300,
  ): Promise<{ scanned: number; enriched: number }> {
    const since = new Date(Date.now() - sinceDays * 86400000);
    const convs = await this.prisma.conversation.findMany({
      where: {
        messages: { some: { direction: 'INBOUND', createdAt: { gte: since } } },
      },
      select: { id: true, organizationId: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    let enriched = 0;
    for (const c of convs) {
      try {
        const r = await this.enrichFromConversation(c.organizationId, c.id);
        if (r.applied.length) enriched++;
      } catch {
        /* best-effort por conversa */
      }
    }
    if (enriched) {
      this.logger.log(
        `lead-enrichment batch: ${enriched}/${convs.length} conversas enriquecidas`,
      );
    }
    return { scanned: convs.length, enriched };
  }

  /** Cadastro atual pela conversa (GET — só leitura, p/ exibir no card). */
  async getCadastroByConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<CadastroData> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { contactId: true },
    });
    if (!conv?.contactId) return {};
    return this.currentCadastro(conv.contactId);
  }

  /** Cadastro atual (p/ exibir no card). */
  async currentCadastro(contactId: string): Promise<CadastroData> {
    const c = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: { name: true, email: true, metadata: true },
    });
    if (!c) return {};
    const m = (c.metadata ?? {}) as any;
    const cad = (m.cadastro ?? {}) as Record<string, any>;
    return {
      name: c.name ?? undefined,
      email: c.email ?? undefined,
      cpfCnpj: m.cpfCnpj ?? m.cpf ?? m.cnpj ?? m.documento ?? undefined,
      birthDate: cad.birthDate,
      cep: cad.cep,
      estado: cad.estado,
      cidade: cad.cidade,
      bairro: cad.bairro,
      endereco: cad.endereco,
      numero: cad.numero,
      complemento: cad.complemento,
      addressText: cad.addressText,
    };
  }

  /** Grava os campos novos no contato (fill-empty-only). */
  private async persist(
    organizationId: string,
    contactId: string,
    data: CadastroData,
  ): Promise<{ applied: string[] }> {
    if (!data || Object.keys(data).length === 0) return { applied: [] };
    try {
      const contact = await this.prisma.contact.findFirst({
        where: { id: contactId, organizationId },
        select: { name: true, email: true, metadata: true },
      });
      if (!contact) return { applied: [] };

      const meta = (contact.metadata ?? {}) as Record<string, any>;
      const cadastro = { ...((meta.cadastro ?? {}) as Record<string, any>) };
      const update: Record<string, any> = {};
      const applied: string[] = [];

      // NOME: preenche se vazio, OU faz UPGRADE quando o lead manda o nome
      // completo e o atual é só o 1º nome (ex.: perfil do WhatsApp "Aley" →
      // "Aley Sadi Costa Ferreira"). Não sobrescreve um nome já completo.
      if (data.name) {
        const d = (s: string) =>
          s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
        const cur = (contact.name ?? '').trim();
        const nw = data.name.trim();
        const curWords = cur ? cur.split(/\s+/).length : 0;
        const nwWords = nw.split(/\s+/).length;
        const upgrade =
          !cur ||
          (nwWords > curWords && curWords <= 2 && d(nw).startsWith(d(cur)));
        if (upgrade && d(nw) !== d(cur)) {
          update.name = nw;
          applied.push('name');
        }
      }
      // E-MAIL: preenche só quando o contato não tem (não troca um e-mail bom).
      if (!contact.email && data.email) {
        update.email = data.email;
        applied.push('email');
      }

      // cpfCnpj no root do metadata (é o que o match do CAPI lê).
      const hasDoc = meta.cpfCnpj || meta.cpf || meta.cnpj || meta.documento;
      let metaChanged = false;
      if (!hasDoc && data.cpfCnpj) {
        meta.cpfCnpj = data.cpfCnpj;
        metaChanged = true;
        applied.push('cpfCnpj');
      }

      // demais campos do cadastro (fill-empty).
      const CAD_KEYS: (keyof CadastroData)[] = [
        'birthDate', 'cep', 'estado', 'cidade', 'bairro',
        'endereco', 'numero', 'complemento', 'addressText',
      ];
      for (const k of CAD_KEYS) {
        if (cadastro[k] == null && data[k] != null) {
          cadastro[k] = data[k];
          metaChanged = true;
          applied.push(k);
        }
      }

      if (metaChanged) {
        meta.cadastro = cadastro;
        update.metadata = meta;
      }

      if (!applied.length) return { applied: [] };

      await this.prisma.contact.update({
        where: { id: contactId },
        data: update,
      });
      this.logger.log(
        `lead enriquecido contact=${contactId} campos=${applied.join(',')}`,
      );
      return { applied };
    } catch (err: any) {
      this.logger.warn(
        `lead-enrichment persist falhou contact=${contactId}: ${err?.message ?? err}`,
      );
      return { applied: [] };
    }
  }
}
