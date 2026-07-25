import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

/**
 * @Global — o KnowledgeService é lido pelo runner (ai-agents) e pela
 * regeneração (messaging). Global evita import cruzado/ciclo, no mesmo padrão
 * de PrismaModule/RealtimeModule. Registra a fila `rag-indexer` pra indexar
 * itens validados no RAG (recall semântico).
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'rag-indexer' })],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
