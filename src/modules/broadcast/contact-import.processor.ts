import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ContactImportService, ImportRow } from './contact-import.service';
import { CONTACT_IMPORT_QUEUE } from './broadcast.constants';

interface ImportJobData {
  importId: string;
  organizationId: string;
  rows: ImportRow[];
  tagIds: string[];
}

@Processor(CONTACT_IMPORT_QUEUE, { concurrency: 2 })
export class ContactImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ContactImportProcessor.name);

  constructor(private readonly service: ContactImportService) {
    super();
  }

  async process(job: Job<ImportJobData>): Promise<void> {
    const { importId, organizationId, rows, tagIds } = job.data;
    try {
      await this.service.runImport(importId, organizationId, rows, tagIds ?? []);
    } catch (err: any) {
      this.logger.error(`contact_import ${importId} falhou: ${err?.message ?? err}`);
      await this.service.markFailed(importId, err?.message ?? 'erro');
    }
  }
}
