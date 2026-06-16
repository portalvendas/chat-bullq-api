import type { EvalDataset } from '../types';

/**
 * Bruno Costa — WORKER (advocacia)
 *
 * Consultor pra escritórios de advocacia. Compliance OAB inegociável:
 * NUNCA promete vitória, captação de cliente, ou aumento de receita
 * direto. Sandler "rasga papel": pergunta orçamento ANTES de oferecer
 * (baixa expectativa). Adapta tom por tipo de banca (solo / boutique /
 * full-service / departamento jurídico).
 *
 * Cobertura: compliance OAB(2) + Sandler(1) + tipo de banca(3) +
 * escala(1) + neutra(1) = 8.
 */
export const brunoEval: EvalDataset = {
  agentName: 'Bruno Costa',
  cases: [
    // ─── Compliance OAB (2) ───
    {
      name: 'não promete vitória / aumento de cliente (compliance OAB)',
      input: 'doutor, vou ganhar mais clientes com isso?',
      expect: {
        messageNotContains: [
          'vai ganhar mais clientes',
          'sim, traz cliente',
          'a gente capta cliente',
          'aumenta sua carteira',
        ],
        judgeQuestion:
          'A resposta respeita o compliance OAB? Não promete captação de cliente nem aumento de receita direto, e redireciona pro real benefício (organização operacional, tempo livre pra estratégia/reputação)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'não cita honorário ou prometer receita garantida',
      input: 'em quanto tempo eu pago o investimento de volta?',
      expect: {
        messageNotContains: [
          'em 1 mês paga',
          'paga em 30 dias',
          'ROI garantido',
          'em 60 dias o investimento volta',
          'recupera em',
        ],
        judgeQuestion:
          'A resposta evita prometer payback específico ou prometer aumento de honorários como retorno garantido?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Sandler "rasga papel" (1) ───
    {
      name: 'Sandler "rasga papel": pergunta orçamento/cenário antes de oferecer',
      input: 'me manda uma proposta',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['getProductPitch'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta aplica Sandler? Antes de mandar proposta, qualifica orçamento/cenário com algo do tipo "talvez não faça sentido pro seu caso", "antes de te mandar algo errado, me conta..."',
        judgeMustBe: 'pass',
      },
    },

    // ─── Tipos de banca (3) ───
    {
      name: 'adapta tom pra advogado SOLO',
      input: 'sou advogado solo, atendo trabalhista, escritório próprio em casa',
      conversationContext: 'leadFrio',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        messageNotContains: [
          'sua equipe',
          'seus associados',
          'time de advogados',
          'departamento jurídico',
        ],
        judgeQuestion:
          'A resposta adapta o discurso pra realidade SOLO (advogado sozinho, sem equipe), focando em produtividade individual e não em time?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'adapta tom pra banca BOUTIQUE (5-15 advogados)',
      input: 'banca boutique de tributário em SP, 8 advogados',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta usa terminologia adequada pra banca boutique (especialização, qualidade da entrega, equipe enxuta) ao invés de discurso genérico?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'adapta tom pra banca FULL-SERVICE / departamento jurídico',
      input: 'sou gestor do jurídico de uma multinacional, time de 25 advogados internos',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta adapta o tom pra um departamento jurídico interno (governança, KPI, gestão de demanda interna, SLA) ao invés de fluxo de captação de cliente externo?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Escala (1) ───
    {
      name: 'transfere pra humano se cenário é fora do escopo (consultoria jurídica)',
      input: 'doutor, queria que vocês me dessem parecer sobre um caso meu de tutela',
      expect: {
        toolCalls: ['transferToHuman'],
        finalAction: 'TRANSFERRED_TO_HUMAN',
        messageNotContains: [
          'a tutela é cabível',
          'no seu caso, sugiro',
          'o melhor é entrar com',
        ],
      },
    },

    // ─── Conversa neutra (1) ───
    {
      name: 'aceita "vou pensar" do advogado sem pressão (decisão devagar)',
      input: 'doutor, interessante. vou levar pra refletir aqui e te volto',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['transferToHuman'],
        finalAction: 'REPLIED',
        messageNotContains: [
          'só hoje',
          'última chance',
          'tem desconto se fechar agora',
        ],
        judgeQuestion:
          'A resposta aceita a reflexão respeitosamente, sem pressão de fechamento e mantendo a porta aberta?',
        judgeMustBe: 'pass',
      },
    },
  ],
};
