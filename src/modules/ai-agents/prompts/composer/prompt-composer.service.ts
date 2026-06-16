import { Injectable, Logger } from '@nestjs/common';
import {
  ComposeInput,
  ComposedPrompt,
  LayerKind,
  PromptLayer,
} from '../types';
import {
  SecurityLayerService,
  resolveSecurityRules,
} from '../layers/security.layer';
import { PersonalityLayerService } from '../layers/personality.layer';
import {
  CapabilitiesLayerService,
  SkillForCapabilities,
} from '../layers/capabilities.layer';
import { ContextLayerService } from '../layers/context.layer';

/**
 * PromptComposerService — concatena as 4 camadas em ordem fixa:
 *
 *   1. SECURITY      (sempre primeiro, inviolável)
 *   2. PERSONALITY   (quem o agent é, do AiAgent.systemPrompt sanitizado)
 *   3. CAPABILITIES  (skills + built-in tools)
 *   4. CONTEXT       (cliente, canal, hora, memória, catálogo)
 *
 * Esta classe NÃO toca em DB, NÃO chama o LLM, NÃO conhece Prisma. Tudo
 * vem pré-coletado no `ComposeInput`. Isso mantém o composer determinístico,
 * fácil de testar e reutilizável (jobs, debug tooling, etc).
 *
 * Roadmap (Fase 2): substituir o `prompt-builder.service.ts` atual por uma
 * fina camada que monta `ComposeInput` (via Agent 8) e chama este composer.
 */
@Injectable()
export class PromptComposerService {
  private readonly logger = new Logger(PromptComposerService.name);

  constructor(
    private readonly securityLayer: SecurityLayerService,
    private readonly personalityLayer: PersonalityLayerService,
    private readonly capabilitiesLayer: CapabilitiesLayerService,
    private readonly contextLayer: ContextLayerService,
  ) {}

  /**
   * Composição principal.
   *
   * @param input — agent + skills + builtin tools + contexto enriquecido
   * @returns prompt final pronto pra enviar ao LLM como `system`
   */
  compose(input: ComposeInput): ComposedPrompt {
    const rules = resolveSecurityRules(input.securityRules);

    const security = this.securityLayer.build(rules);
    const personality = this.personalityLayer.build(input.agent ?? {});
    const capabilities = this.capabilitiesLayer.build(
      this.normalizeSkills(input.skills),
      input.builtinTools,
    );
    const context = this.contextLayer.build(input.enrichedContext);

    const layers: PromptLayer[] = [security, personality, capabilities, context];

    const system = layers.map((l) => l.content).join('\n\n---\n\n');

    const layerBreakdown: Record<LayerKind, number> = {
      security: security.tokenEstimate,
      personality: personality.tokenEstimate,
      capabilities: capabilities.tokenEstimate,
      context: context.tokenEstimate,
    };
    const totalTokens =
      layerBreakdown.security +
      layerBreakdown.personality +
      layerBreakdown.capabilities +
      layerBreakdown.context;

    this.logger.log(
      { msg: 'prompt_composed', totalTokens, layerBreakdown },
      `Prompt composed: ${totalTokens} tokens (security=${layerBreakdown.security}, personality=${layerBreakdown.personality}, capabilities=${layerBreakdown.capabilities}, context=${layerBreakdown.context})`,
    );

    return {
      system,
      totalTokens,
      layerBreakdown,
      generatedAt: new Date(),
    };
  }

  /**
   * Aceita skills no formato Prisma (campos extras) ou no formato
   * minimal `SkillForCapabilities`. Devolve o shape limpo.
   */
  private normalizeSkills(skills: unknown[]): SkillForCapabilities[] {
    if (!Array.isArray(skills)) return [];
    return skills
      .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
      .map((s) => ({
        name: String(s.name ?? ''),
        description: String(s.description ?? ''),
        category:
          typeof s.category === 'string'
            ? s.category
            : s.category == null
              ? null
              : String(s.category),
        promptInstructions:
          typeof s.promptInstructions === 'string'
            ? s.promptInstructions
            : s.promptInstructions == null
              ? null
              : String(s.promptInstructions),
      }))
      .filter((s) => s.name.length > 0 && s.description.length > 0);
  }
}
