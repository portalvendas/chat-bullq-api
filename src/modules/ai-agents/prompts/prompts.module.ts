import { Module } from '@nestjs/common';
import { SecurityLayerService } from './layers/security.layer';
import { PersonalityLayerService } from './layers/personality.layer';
import { CapabilitiesLayerService } from './layers/capabilities.layer';
import { ContextLayerService } from './layers/context.layer';
import { PromptComposerService } from './composer/prompt-composer.service';

/**
 * PromptsModule — camada de composição de prompt em 4 layers (BullQ-style).
 *
 * Exporta `PromptComposerService` pra outros módulos (ai-agents/runner)
 * usarem na Fase 2 da migração. Layer services também são exportados pra
 * testes isolados e cenários onde o consumer quer construir layers
 * individuais sem passar pelo composer.
 *
 * NOTA: este módulo é PARALELO ao `prompt-builder.service.ts` legado.
 * A integração no AiAgentsModule é feita em outro PR (Fase 2, sequencial).
 */
@Module({
  providers: [
    SecurityLayerService,
    PersonalityLayerService,
    CapabilitiesLayerService,
    ContextLayerService,
    PromptComposerService,
  ],
  exports: [
    PromptComposerService,
    SecurityLayerService,
    PersonalityLayerService,
    CapabilitiesLayerService,
    ContextLayerService,
  ],
})
export class PromptsModule {}
