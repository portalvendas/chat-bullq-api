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

/**
 * Data de criação do card no import: usa r.createdAt; se vier vazio (ex.: o
 * leitor de planilha não mapeou a coluna "Criado em" — acontece quando o
 * cabeçalho vem em formato de data), cai na MENOR data ISO encontrada nos
 * campos custom (que no Kommo são Criado/Atualizado/Fechado — a menor é a de
 * criação). Evita que a base importada fique toda com a data do import.
 */
function resolveCreatedAt(r: ImportLeadRow): Date | undefined {
  if (r.createdAt) {
    const d = new Date(r.createdAt);
    if (!isNaN(d.getTime())) return d;
  }
  let min: number | undefined;
  for (const v of Object.values(r.custom ?? {})) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) continue;
    const t = Date.parse(v);
    if (!isNaN(t) && (min === undefined || t < min)) min = t;
  }
  return min !== undefined ? new Date(min) : undefined;
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
   * Corrige a data (createdAt) dos cards importados do Kommo que ficaram com a
   * data da IMPORTAÇÃO, usando a MENOR data ISO guardada em metadata.custom
   * (que no Kommo é a "Criado em"). execute=false = prévia (nada muda).
   */
  async backfillImportedDates(organizationId: string, execute: boolean) {
    const preview = await this.prisma.$queryRaw<
      { corrigiveis: number; data_min: Date | null; data_max: Date | null }[]
    >`
      with sub as (
        select id, created_at, (
          select min(v::timestamptz)
          from jsonb_each_text(metadata->'custom') as x(k, v)
          where v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
        ) as min_iso
        from cards
        where organization_id = ${organizationId}
          and metadata->>'source' = 'import_kommo'
      )
      select count(*)::int as corrigiveis, min(min_iso) as data_min, max(min_iso) as data_max
      from sub
      where min_iso is not null and min_iso < created_at
    `;

    let atualizados = 0;
    if (execute) {
      atualizados = await this.prisma.$executeRaw`
        update cards c
        set created_at = sub.min_iso
        from (
          select id, created_at, (
            select min(v::timestamptz)
            from jsonb_each_text(metadata->'custom') as x(k, v)
            where v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'
          ) as min_iso
          from cards
          where organization_id = ${organizationId}
            and metadata->>'source' = 'import_kommo'
        ) sub
        where c.id = sub.id
          and sub.min_iso is not null
          and sub.min_iso < c.created_at
      `;
    }

    const p = preview[0];
    return {
      corrigiveis: Number(p?.corrigiveis ?? 0),
      dataMin: p?.data_min ?? null,
      dataMax: p?.data_max ?? null,
      atualizados,
    };
  }

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
      cardsUpdated: 0,
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

        // Resolve etapa + status + valor.
        const stage =
          stageByName.get((r.stageName ?? '').trim().toLowerCase()) ?? firstStage;
        const status = normStatus(r.status);
        const title = (r.title || name || 'Lead').toString().slice(0, 200);
        const value =
          r.value === null || r.value === undefined || r.value === ''
            ? null
            : Number(r.value);
        const numValue = Number.isFinite(value as number)
          ? (value as number)
          : null;
        const closedReason = r.closedReason?.trim() || null;
        const custom = (r.custom ?? {}) as Record<string, any>;

        // Acha o card existente do MESMO lead: 1) por kommo_id; 2) senão, o
        // card do mesmo contato neste pipeline. Isso garante nunca duplicar.
        let existing = r.externalId
          ? await this.prisma.card.findFirst({
              where: {
                organizationId,
                metadata: { path: ['kommo_id'], equals: String(r.externalId) },
              },
            })
          : null;
        if (!existing) {
          existing = await this.prisma.card.findFirst({
            where: {
              organizationId,
              pipelineId: pipeline.id,
              contactId: contact.id,
            },
            orderBy: { createdAt: 'desc' },
          });
        }

        if (existing) {
          // ENRIQUECE só o que mudou — nunca sobrescreve com vazio, nunca duplica.
          const meta = (existing.metadata as Record<string, any>) ?? {};
          const patch: Record<string, any> = {};
          if (r.title && title !== existing.title) patch.title = title;
          if (numValue !== null && Number(existing.value ?? NaN) !== numValue)
            patch.value = numValue as any;
          if (r.status && status !== existing.status) {
            patch.status = status;
            patch.closedAt =
              status !== 'OPEN' ? existing.closedAt ?? new Date() : null;
          }
          if (r.stageName && stage.id !== existing.stageId) {
            patch.stageId = stage.id;
            const c = await this.prisma.card.count({
              where: { pipelineId: pipeline.id, stageId: stage.id },
            });
            patch.order = c;
          }
          if (closedReason && closedReason !== existing.closedReason)
            patch.closedReason = closedReason;
          // Merge de metadata (tracking + custom): adiciona chaves novas sem
          // perder as existentes.
          const mergedTracking = { ...(meta.tracking ?? {}), ...tracking };
          const mergedCustom = { ...(meta.custom ?? {}), ...custom };
          const newMeta = {
            ...meta,
            source: meta.source ?? 'import_kommo',
            ...(r.externalId ? { kommo_id: String(r.externalId) } : {}),
            tracking: mergedTracking,
            custom: mergedCustom,
          };
          const metaChanged =
            JSON.stringify(newMeta) !== JSON.stringify(meta);
          if (metaChanged) patch.metadata = newMeta as any;

          if (Object.keys(patch).length === 0) {
            summary.cardsSkipped++;
          } else {
            await this.prisma.card.update({
              where: { id: existing.id },
              data: patch,
            });
            summary.cardsUpdated++;
          }
        } else {
          const count = await this.prisma.card.count({
            where: { pipelineId: pipeline.id, stageId: stage.id },
          });
          await this.prisma.card.create({
            data: {
              organizationId,
              pipelineId: pipeline.id,
              stageId: stage.id,
              title,
              status,
              value: numValue as any,
              closedReason,
              closedAt: status !== 'OPEN' ? new Date() : null,
              contactId: contact.id,
              order: count,
              ...((): { createdAt?: Date } => {
                const c = resolveCreatedAt(r);
                return c ? { createdAt: c } : {};
              })(),
              metadata: {
                source: 'import_kommo',
                ...(r.externalId ? { kommo_id: String(r.externalId) } : {}),
                tracking,
                custom,
              } as any,
            },
          });
          summary.cardsCreated++;
        }
      } catch (err: any) {
        summary.errors.push({ row: i, error: err?.message ?? String(err) });
      }
    }

    this.logger.log(
      `Import Kommo (org ${organizationId}): +${summary.cardsCreated} cards, ~${summary.cardsUpdated} enriquecidos, ${summary.cardsSkipped} sem mudança, +${summary.stagesCreated} etapas, ${summary.errors.length} erros`,
    );
    return summary;
  }
}
