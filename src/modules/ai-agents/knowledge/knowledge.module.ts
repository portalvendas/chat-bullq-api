import { Global, Module } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

/**
 * @Global — o KnowledgeService é lido pelo runner (ai-agents) e pela
 * regeneração (messaging). Global evita import cruzado/ciclo, no mesmo padrão
 * de PrismaModule/RealtimeModule.
 */
@Global()
@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
