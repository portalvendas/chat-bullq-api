import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';
import { LlmKeyService } from './llm-key.service';

@Module({
  imports: [ConfigModule],
  providers: [LlmService, LlmKeyService],
  exports: [LlmService, LlmKeyService],
})
export class LlmModule {}
