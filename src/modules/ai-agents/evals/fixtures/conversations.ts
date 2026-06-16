/**
 * Conversation history fixtures for evals.
 *
 * Each fixture id is referenced by EvalCase.conversationContext. The runner
 * is expected to load the matching turn list and feed it to the agent as
 * prior conversation context BEFORE running the eval input.
 */

export interface FixtureTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type FixtureId =
  | 'leadFrio'
  | 'leadAquecidoComCompra'
  | 'clienteIrritado';

export const fixtures: Record<FixtureId, FixtureTurn[]> = {
  /**
   * Lead novo, só falou "oi" — nada qualificado, ainda não declarou nicho.
   * Use pra testar caminho A do Augusto e abertura padrão de qualquer worker.
   */
  leadFrio: [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'opa, aqui é o Augusto da Bravy. pode falar, em que posso te ajudar?' },
  ],

  /**
   * Lead já qualificado, conheceu o curso de tráfego, declarou compra agora.
   * Use pra testar handoff de venda → pós-venda (Daniel/Augusto → Lívia).
   */
  leadAquecidoComCompra: [
    { role: 'user', content: 'queria entender melhor o curso de tráfego' },
    { role: 'assistant', content: 'fechou. o curso é completo, 12 módulos, com aula ao vivo toda quarta. quer que eu te mande o link de checkout?' },
    { role: 'user', content: 'beleza, comprei agora pelo link' },
    { role: 'assistant', content: 'perfeito! te envio o acesso já já.' },
  ],

  /**
   * Cliente já tentou resolver sozinho, não conseguiu, está hostil.
   * Use pra testar empatia LATTE da Lívia, validação antes de pedir dado.
   */
  clienteIrritado: [
    { role: 'user', content: 'tô há 2 horas tentando acessar e nada' },
    { role: 'assistant', content: 'que situação chata. vou resolver agora.' },
  ],
};
