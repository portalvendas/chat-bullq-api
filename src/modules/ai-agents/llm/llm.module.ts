import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmService } from './llm.service';
import { LlmKeyService } from './llm-key.service';
import { OpenaiKeyService } from './openai-key.service';

@Module({
  imports: [ConfigModule],
  providers: [LlmService, LlmKeyService, OpenaiKeyService],
  exports: [LlmService, LlmKeyService, OpenaiKeyService],
})
export class LlmModule {}
