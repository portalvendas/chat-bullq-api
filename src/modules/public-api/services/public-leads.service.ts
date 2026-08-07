import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { PipelinesService } from '../../pipelines/pipelines.service';

/**
 * Intake público de leads (ex.: n8n vindo da Landing Page). Recebe QUALQUER
 * payload — extrai nome/telefone/email por vários aliases e captura todo o
 * restante como tracking/metadata (UTMs, click IDs, IP, referrer, etc.),
 * garantindo paridade com o que hoje alimenta o Kommo. Cria/atualiza o
 * contato e abre um card na etapa de entrada do funil.
 */
@Injectable()
export class PublicLeadsService {
  private readonly logger = new Logger(PublicLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
  ) {}

  /** Chaves de tracking conhecidas que capturamos do payload (nível raiz). */
  private static readonly TRACKING_KEYS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'utm_id',
    'fbclid',
    'gclid',
    'gbraid',
    'wbraid',
    'ttclid',
    'msclkid',
    'referrer',
    'referer',
    'landing_url',
    'landing_page',
    'page_url',
    'ip',
    'ip_address',
    'user_agent',
    'fbp',
    'fbc',
    'ga_client_id',
  ];

  private pick(body: Record<string, any>, keys: string[]): any {
    for (const k of keys) {
      const v = body?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  }

  private normalizePhone(phone?: any): string | null {
    if (phone === undefined || phone === null) return null;
    const digits = String(phone).replace(/[^\d+]/g, '');
    return digits || null;
  }

  private extractTracking(body: Record<string, any>): Record<string, any> {
    const t: Record<string, any> = {};
    // objeto tracking explícito, se vier
    if (body?.tracking && typeof body.tracking === 'object') {
      Object.assign(t, body.tracking);
    }
    // chaves conhecidas no nível raiz
    for (const k of PublicLeadsService.TRACKING_KEYS) {
      if (body?.[k] !== undefined && body[k] !== null && String(body[k]).trim() !== '') {
        // normaliza referer→referrer
        const key = k === 'referer' ? 'referrer' : k === 'ip_address' ? 'ip' : k;
        if (t[key] === undefined) t[key] = body[k];
      }
    }
    return t;
  }

  /** Normaliza a temperatura do lead; se ausente, deriva do score
   *  (>=70 Quente, >=40 Morno, <40 Frio). Retorna 'Quente'|'Morno'|'Frio'. */
  private resolveTemperature(
    raw: any,
    score: number | null,
  ): 'Quente' | 'Morno' | 'Frio' | null {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s.includes('quente') || s === 'hot') return 'Quente';
    if (s.includes('morno') || s.includes('warm')) return 'Morno';
    if (s.includes('frio') || s === 'cold') return 'Frio';
    if (score == null) return null;
    if (score >= 70) return 'Quente';
    if (score >= 40) return 'Morno';
    return 'Frio';
  }

  /** Aplica a tag de temperatura no contato (aparece também no WhatsApp).
   *  Idempotente, best-effort. */
  private async applyTemperatureTag(
    organizationId: string,
    contactId: string,
    temperature: string | null,
  ): Promise<void> {
    if (!temperature) return;
    const name = `Lead ${temperature}`;
    try {
      const tag = await this.prisma.tag.upsert({
        where: { organizationId_name: { organizationId, name } },
        update: {},
        create: { organizationId, name },
      });
      await this.prisma.contactTag.upsert({
        where: { contactId_tagId: { contactId, tagId: tag.id } },
        update: {},
        create: { contactId, tagId: tag.id },
      });
    } catch (err: any) {
      this.logger.warn(`applyTemperatureTag falhou: ${err?.message}`);
    }
  }

  private normalizeValue(v: any): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n =
      typeof v === 'number'
        ? v
        : parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  async ingest(
    organizationId: string,
    body: Record<string, any>,
  ): Promise<{
    ok: boolean;
    contactId: string;
    cardId: string | null;
    deduped: boolean;
    updated: boolean;
  }> {
    const name =
      this.pick(body, [
        'name',
        'nome',
        'full_name',
        'fullName',
        'form_fields[name]',
      ]) ?? null;
    const phone = this.normalizePhone(
      this.pick(body, [
        'phone',
        'telefone',
        'whatsapp',
        'celular',
        'form_fields[telefone]',
        'form_fields[whatsapp]',
      ]),
    );
    const email =
      this.pick(body, ['email', 'e-mail', 'form_fields[email]']) ?? null;
    const source =
      this.pick(body, ['source', 'origem', 'lead_source']) ?? 'landing_page';
    const tracking = this.extractTracking(body);

    // Campos do CARD (antes ignorados): descrição, valor e título explícito.
    const description =
      this.pick(body, [
        'description',
        'descricao',
        'descrição',
        'observacao',
        'observação',
        'obs',
        'notes',
        'mensagem',
        'message',
      ]) ?? null;
    // Lead score / temperatura (LP manda `lead_score` + `lead_temperatura`).
    const leadScore = this.normalizeValue(
      this.pick(body, ['lead_score', 'leadscore', 'leadScore', 'score']),
    );
    const temperature = this.resolveTemperature(
      this.pick(body, [
        'lead_temperatura',
        'temperatura',
        'temperature',
        'lead_temperature',
      ]),
      leadScore,
    );

    // VALOR do card: quando há lead_score, o campo `valor` do payload é o
    // SCORE (não uma proposta) → deixa o Valor ZERADO pra receber propostas
    // futuras. Sem lead_score, mantém o comportamento normal (valor monetário).
    const value =
      leadScore != null
        ? null
        : this.normalizeValue(
            this.pick(body, ['value', 'valor', 'amount', 'price', 'preco', 'preço']),
          );
    const explicitTitle =
      this.pick(body, ['title', 'titulo', 'título']) ?? null;
    const title = explicitTitle || name || phone || email || 'Lead';

    const contact = await this.findOrCreateContact(
      organizationId,
      { name, phone, email },
      source,
      tracking,
    );

    // Tag de temperatura no contato (aparece no card E no WhatsApp do lead).
    await this.applyTemperatureTag(organizationId, contact.id, temperature);

    const cardMeta: Record<string, any> = {
      source,
      tracking,
      raw: body,
      ...(leadScore != null ? { leadScore } : {}),
      ...(temperature ? { leadTemperature: temperature } : {}),
    };

    const card = await this.pipelines.createEntryCardForContact(
      organizationId,
      contact.id,
      title,
      cardMeta,
      // Roteamento por origem: LP usa leadSource + utm_source.
      { leadSource: source, utmSource: (tracking as any)?.utm_source ?? null },
      { description, value },
    );

    // DEDUP = UPSERT: se o contato já tinha um card ABERTO, ENRIQUECE ele
    // (descrição/valor/título quando vierem + merge de tracking) em vez de
    // ignorar. Assim o 2º disparo (payload completo) atualiza o card do 1º
    // (parcial) — não precisa esperar/racing.
    let updated = false;
    let cardId = card?.id ?? null;
    if (!card) {
      const existing = await this.prisma.card.findFirst({
        where: { organizationId, contactId: contact.id, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        const patch: Record<string, any> = {};
        if (description && !existing.description) patch.description = description;
        if (value != null && (existing.value == null || Number(existing.value) === 0))
          patch.value = value as any;
        // Corrige o Valor que tinha sido preenchido com o score.
        if (
          leadScore != null &&
          existing.value != null &&
          Number(existing.value) === leadScore
        )
          patch.value = 0 as any;
        if (explicitTitle && explicitTitle !== existing.title)
          patch.title = explicitTitle;
        const meta = (existing.metadata as Record<string, any>) ?? {};
        patch.metadata = {
          ...meta,
          source: meta.source ?? source,
          tracking: { ...(meta.tracking ?? {}), ...tracking },
          raw: body,
          ...(leadScore != null ? { leadScore } : {}),
          ...(temperature ? { leadTemperature: temperature } : {}),
        };
        await this.prisma.card.update({
          where: { id: existing.id },
          data: patch,
        });
        cardId = existing.id;
        updated = true;
      }
    }

    this.logger.log(
      `Public lead: contato ${contact.id} (org ${organizationId}, origem ${source}) → ${
        card ? `card ${card.id}` : updated ? `card ${cardId} atualizado` : 'card já existia'
      }`,
    );

    return {
      ok: true,
      contactId: contact.id,
      cardId,
      deduped: !card,
      updated,
    };
  }

  private async findOrCreateContact(
    organizationId: string,
    data: { name: string | null; phone: string | null; email: string | null },
    source: string,
    tracking: Record<string, any>,
  ) {
    let contact: any = null;
    if (data.phone) {
      contact = await this.prisma.contact.findFirst({
        where: { organizationId, phone: data.phone },
      });
    }
    if (!contact && data.email) {
      contact = await this.prisma.contact.findFirst({
        where: { organizationId, email: data.email },
      });
    }

    if (contact) {
      const patch: Record<string, any> = {};
      if (!contact.name && data.name) patch.name = data.name;
      if (!contact.email && data.email) patch.email = data.email;
      if (!contact.phone && data.phone) patch.phone = data.phone;
      // acumula tracking no metadata do contato sem sobrescrever o já existente
      const meta = (contact.metadata as Record<string, any>) ?? {};
      const mergedTracking = { ...(meta.tracking ?? {}), ...tracking };
      patch.metadata = {
        ...meta,
        source: meta.source ?? source,
        tracking: mergedTracking,
      };
      contact = await this.prisma.contact.update({
        where: { id: contact.id },
        data: patch,
      });
      return contact;
    }

    return this.prisma.contact.create({
      data: {
        organizationId,
        name: data.name,
        phone: data.phone,
        email: data.email,
        metadata: { source, tracking },
      },
    });
  }
}
