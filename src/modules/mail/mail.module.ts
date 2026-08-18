import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/** Global: MailService fica injetável em qualquer módulo sem import explícito. */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
