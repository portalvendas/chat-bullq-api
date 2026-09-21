import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { canonicalPhone, phoneVariants, phoneDigits } from '../../common/phone.util';
import { CONTACT_IMPORT_QUEUE, CONTACT_IMPORT_JOB } from './broadcast.constants';

export interface ImportRow {
  name?: string;
  phone?: string;
  email?: string;
}

@Injectable()
export class ContactImportService {
  private readonly logger = new Logger(ContactImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CONTACT_IMPORT_QUEUE) private readonly queue: Queue,
  ) {}

  /** Cria o registro de importação e enfileira o processamento (assíncrono). */
  async enqueue(
    organizationId: string,
    userId: string,
    dto: { fileName?: string; rows: ImportRow[]; tagIds?: string[] },
  ) {
    const rows = Array.isArray(dto.rows) ? dto.rows : [];
    if (!rows.length) throw new BadRequestException('Nenhuma linha para importar.');
    if (rows.length > 50000) {
      throw new BadRequestException('Envie no máximo 50.000 linhas por lote.');
    }
    const record = await this.prisma.contactImport.create({
      data: {
        organizationId,
        fileName: dto.fileName ?? 'import.csv',
        storagePath: '(inline)',
        status: 'PENDING',
        totalRows: rows.length,
        createdByUserId: userId,
      },
    });
    await this.queue.add(
      CONTACT_IMPORT_JOB,
      { importId: record.id, organizationId, rows, tagIds: dto.tagIds ?? [] },
      { jobId: record.id, removeOnComplete: true, removeOnFail: 100 },
    );
    return record;
  }

  async getImport(organizationId: string, id: string) {
    const rec = await this.prisma.contactImport.findFirst({
      where: { id, organizationId },
    });
    if (!rec) throw new NotFoundException('Importação não encontrada.');
    return rec;
  }

  /** Processa o lote: normaliza telefone (E.164 BR), dedupe pelo 9º dígito. */
  async runImport(
    importId: string,
    organizationId: string,
    rows: ImportRow[],
    tagIds: string[],
  ): Promise<void> {
    await this.prisma.contactImport.update({
      where: { id: importId },
      data: { status: 'PROCESSING' },
    });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const errors: Array<{ row: number; reason: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] ?? {};
      const digits = phoneDigits(r.phone);
      if (digits.length < 10) {
        skipped += 1;
        errors.push({ row: i + 1, reason: 'telefone ausente ou inválido' });
        continue;
      }
      const canon = canonicalPhone(r.phone) ?? digits;
      try {
        const existing = await this.prisma.contact.findFirst({
          where: {
            organizationId,
            deletedAt: null,
            phone: { in: phoneVariants(r.phone) },
          },
          select: { id: true, name: true, email: true },
        });

        let contactId: string;
        if (existing) {
          const patch: Record<string, any> = {};
          if (!existing.name && r.name) patch.name = r.name.trim();
          if (!existing.email && r.email) patch.email = r.email.trim();
          if (Object.keys(patch).length) {
            await this.prisma.contact.update({
              where: { id: existing.id },
              data: patch,
            });
          }
          contactId = existing.id;
          updated += 1;
        } else {
          const c = await this.prisma.contact.create({
            data: {
              organizationId,
              name: r.name?.trim() || null,
              phone: canon,
              email: r.email?.trim() || null,
            },
            select: { id: true },
          });
          contactId = c.id;
          created += 1;
        }

        for (const tagId of tagIds) {
          await this.prisma.contactTag
            .upsert({
              where: { contactId_tagId: { contactId, tagId } },
              create: { contactId, tagId },
              update: {},
            })
            .catch(() => undefined);
        }
      } catch (err: any) {
        skipped += 1;
        errors.push({ row: i + 1, reason: err?.message?.slice(0, 200) ?? 'erro' });
      }
    }

    await this.prisma.contactImport.update({
      where: { id: importId },
      data: {
        status: 'COMPLETED',
        createdCount: created,
        updatedCount: updated,
        skippedCount: skipped,
        errorReport: errors.length ? (errors.slice(0, 1000) as any) : undefined,
        completedAt: new Date(),
      },
    });
    this.logger.log(
      `contact_import ${importId} created=${created} updated=${updated} skipped=${skipped}`,
    );
  }

  async markFailed(importId: string, reason: string) {
    await this.prisma.contactImport
      .update({
        where: { id: importId },
        data: { status: 'FAILED', errorReport: [{ row: 0, reason }] as any },
      })
      .catch(() => undefined);
  }
}
