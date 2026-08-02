import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CardStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  CustomFieldsService,
  CustomFieldInput,
} from '../custom-fields/custom-fields.service';

export interface ImportLeadRow {
  externalId?: string | null; // Kommo "ID Lead" → metadata.kommo_id (dedupe)
  title?: string | null; // Nome do lead → card.title
  contactName?: string | null; // Contato principal
  phone?: string | null;
  email?: string | null;
  stageName?: string | null; // Etapa atual (Kommo)
  status?: string | null; // OPEN | WON | LOST (ou Aberto/Ganho/Perdido)
  value?: number | string | null;
  closedReason?: string | null;
  tags?: string[];
  createdAt?: string | null; // ISO
  tracking?: Record<string, any> | null;
  custom?: Record<string, any> | null; // valores por key de campo custom (CARD)
}

export interface ImportLeadsDto {
  pipelineId: string;
  createMissingStages?: boolean;
  customFields?: CustomFieldInput[];
  rows: ImportLeadRow[];
}

function normalizePhone(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const digits = String(v).replace(/\D+/g, '');
  return digits.length >= 6 ? digits : null;
}

function normStatus(s?: string | null): CardStatus {
  const v = String(s ?? '').trim().toLowerCase();
  if (v === 'won' || v.includes('ganho') || v.includes('venda')) return CardStatus.WON;
  if (v === 'lost' || v.includes('perd')) return CardStatus.LOST;
  return CardStatus.OPEN;
}

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customFields: CustomFieldsService,
  ) {}

  /**
   * Importa uma leva de leads (contato + card) num pipeline. Idempotente:
   * dedupe de contato por telefone/email e de card por metadata.kommo_id
   * (externalId). Cria etapas e campos personalizados que faltarem.
   *
   * Projetado pra ser chamado em lotes (o frontend fatia o XLSX), então
   * garantir campos/etapas a cada chamada é barato e idempotente.
   */
  async importLeads(organizationId: string, dto: ImportLeadsDto) {
    if (!dto?.pipelineId) throw new BadRequestException('pipelineId é obrigatório');
    const rows = Array.isArray(dto.rows) ? dto.rows : [];

    // 1) Garante os campos personalizados (defs).
    if (dto.customFields?.length) {
      await this.customFields.ensureMany(organizationId, dto.customFields);
    }

    // 2) Carrega o pipeline + etapas.
    const pipeline = await this.prisma.pipeline.findUnique({
      where: { id: dto.pipelineId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!pipeline) throw new NotFoundException('Pipeline não encontrado');
    if (pipeline.organizationId !== organizationId) throw new ForbiddenException();
    if (pipeline.stages.length === 0)
      throw new BadRequestException('Pipeline sem etapas');

    // Mapa nome(lower) → stage. Cria etapas faltantes se pedido.
    const stageByName = new Map<string, { id: string }>();
    for (const s of pipeline.stages) stageByName.set(s.name.toLowerCase(), s);
    let maxOrder = Math.max(...pipeline.stages.map((s) => s.order));
    let stagesCreated = 0;

    const wantedStages = new Set(
      rows
        .map((r) => (r.stageName ?? '').trim())
        .filter((n) => n.length > 0),
    );
    for (const name of wantedStages) {
      if (stageByName.has(name.toLowerCase())) continue;
      if (dto.createMissingStages) {
        const created = await this.prisma.pipelineStage.create({
          data: { pipelineId: pipeline.id, name, order: ++maxOrder },
        });
        stageByName.set(name.toLowerCase(), created);
        stagesCreated++;
      }
    }
    const firstStage = pipeline.stages[0];

    const summary = {
      contactsCreated: 0,
      contactsUpdated: 0,
      cardsCreated: 0,
      cardsSkipped: 0,
      stagesCreated,
      errors: [] as Array<{ row: number; error: string }>,
    };

    // 3) Importa linha a linha (best-effort).
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        const phone = normalizePhone(r.phone);
        const email = r.email?.trim() || null;
        const name = (r.contactName || r.title || '')?.trim() || null;

        // Dedupe de card por kommo_id.
        if (r.externalId) {
          const dup = await this.prisma.card.findFirst({
            where: {
              organizationId,
              metadata: { path: ['kommo_id'], equals: String(r.externalId) },
            },
            select: { id: true },
          });
          if (dup) {
            summary.cardsSkipped++;
            continue;
          }
        }

        // Upsert de contato por telefone → email.
        let contact = phone
          ? await this.prisma.contact.findFirst({
              where: { organizationId, phone },
            })
          : null;
        if (!contact && email) {
          contact = await this.prisma.contact.findFirst({
            where: { organizationId, email },
          });
        }
        const tracking = r.tracking ?? {};
        if (contact) {
          const meta = (contact.metadata as Record<string, any>) ?? {};
          contact = await this.prisma.contact.update({
            where: { id: contact.id },
            data: {
              name: contact.name ?? name,
              email: contact.email ?? email,
              phone: contact.phone ?? phone,
              metadata: {
                ...meta,
                source: meta.source ?? 'import_kommo',
                tracking: { ...(meta.tracking ?? {}), ...tracking },
              },
            },
          });
          summary.contactsUpdated++;
        } else {
          contact = await this.prisma.contact.create({
            data: {
              organizationId,
              name,
              phone,
              email,
              metadata: { source: 'import_kommo', tracking },
            },
          });
          summary.contactsCreated++;
        }

        // Tags no contato.
        for (const tagName of r.tags ?? []) {
          const nm = String(tagName).trim();
          if (!nm) continue;
          const tag = await this.prisma.tag.upsert({
            where: { organizationId_name: { organizationId, name: nm } },
            update: {},
            create: { organizationId, name: nm },
          });
          await this.prisma.contactTag.upsert({
            where: { contactId_tagId: { contactId: contact.id, tagId: tag.id } },
            update: {},
            create: { contactId: contact.id, tagId: tag.id },
          });
        }

        // Resolve etapa + status.
        const stage =
          stageByName.get((r.stageName ?? '').trim().toLowerCase()) ?? firstStage;
        const status = normStatus(r.status);
        const value =
          r.value === null || r.value === undefined || r.value === ''
            ? null
            : Number(r.value);

        const count = await this.prisma.card.count({
          where: { pipelineId: pipeline.id, stageId: stage.id },
        });
        await this.prisma.card.create({
          data: {
            organizationId,
            pipelineId: pipeline.id,
            stageId: stage.id,
            title: (r.title || name || 'Lead').toString().slice(0, 200),
            status,
            value: Number.isFinite(value as number) ? (value as any) : null,
            closedReason: r.closedReason?.trim() || null,
            closedAt: status !== 'OPEN' ? new Date() : null,
            contactId: contact.id,
            order: count,
            ...(r.createdAt ? { createdAt: new Date(r.createdAt) } : {}),
            metadata: {
              source: 'import_kommo',
              ...(r.externalId ? { kommo_id: String(r.externalId) } : {}),
              tracking,
              custom: r.custom ?? {},
            } as any,
          },
        });
        summary.cardsCreated++;
      } catch (err: any) {
        summary.errors.push({ row: i, error: err?.message ?? String(err) });
      }
    }

    this.logger.log(
      `Import Kommo (org ${organizationId}): +${summary.cardsCreated} cards, ${summary.cardsSkipped} skip, +${summary.stagesCreated} etapas, ${summary.errors.length} erros`,
    );
    return summary;
  }
}
