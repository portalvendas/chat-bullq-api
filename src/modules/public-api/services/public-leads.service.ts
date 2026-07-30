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

  async ingest(
    organizationId: string,
    body: Record<string, any>,
  ): Promise<{
    ok: boolean;
    contactId: string;
    cardId: string | null;
    deduped: boolean;
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

    const contact = await this.findOrCreateContact(
      organizationId,
      { name, phone, email },
      source,
      tracking,
    );

    const card = await this.pipelines.createEntryCardForContact(
      organizationId,
      contact.id,
      name || phone || email || 'Lead',
      { source, tracking, raw: body },
    );

    this.logger.log(
      `Public lead: contato ${contact.id} (org ${organizationId}, origem ${source})${card ? ` → card ${card.id}` : ' (card já existia)'}`,
    );

    return {
      ok: true,
      contactId: contact.id,
      cardId: card?.id ?? null,
      deduped: !card,
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
