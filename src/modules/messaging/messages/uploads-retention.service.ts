import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { UploadsService } from './uploads.service';

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

/**
 * Mantém o disco de uploads (mídia re-hospedada de WhatsApp/Instagram/áudios)
 * dentro do limite: poda arquivos além da janela de retenção no boot — o que
 * libera espaço logo após um deploy — e depois a cada 12h. Sem @nestjs/schedule
 * (não usado no projeto): um setInterval simples basta, já que o disco é local
 * à instância da API.
 */
@Injectable()
export class UploadsRetentionService implements OnModuleInit {
  private readonly logger = new Logger(UploadsRetentionService.name);

  constructor(private readonly uploads: UploadsService) {}

  onModuleInit(): void {
    void this.run();
    const timer = setInterval(() => void this.run(), TWELVE_HOURS);
    // Não segura o processo vivo por causa do timer.
    timer.unref?.();
  }

  private async run(): Promise<void> {
    try {
      await this.uploads.pruneOlderThan();
    } catch (err: any) {
      this.logger.warn(`Poda de uploads falhou: ${err?.message ?? err}`);
    }
  }
}
