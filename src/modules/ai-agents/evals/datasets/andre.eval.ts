import type { EvalDataset } from '../types';

/**
 * André Silva — WORKER (contabilidade)
 *
 * Consultor de contabilidade. Pega leads de escritórios contábeis/BPO/
 * controllers do Augusto, qualifica em profundidade (porte, sistema atual,
 * dor) usando SPIN, fecha demo. Não promete deadline, não dá conselho
 * contábil específico, escala pra humano se escritório >500 clientes.
 *
 * Cobertura: qualificação(3) + compliance(2) + escala(1) + pós-venda(1)
 * + neutra(1) = 8.
 */
export const andreEval: EvalDataset = {
  agentName: 'André Silva',
  cases: [
    // ─── Qualificação (3) ───
    {
      name: 'qualifica faturamento/porte do escritório',
      input: 'tenho um escritório contábil',
      conversationContext: 'leadFrio',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta pergunta sobre PORTE do escritório (nº de clientes, faturamento ou nº de colaboradores) sem citar preço/produto ainda?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'qualifica regime tributário / perfil de cliente',
      input: 'atendemos uns 80 clientes, mistura de PJ pequena e MEI',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta aprofunda no PERFIL TÉCNICO (regime tributário, mix Simples/LP/LR, ou tipo de operação) demonstrando conhecimento contábil real?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'qualifica número de colaboradores / sistema atual',
      input: 'a gente tá no Domínio há uns 8 anos',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        messageNotContains: [
          'Domínio é ruim',
          'Domínio não presta',
          'Domínio é fraco',
        ],
        judgeQuestion:
          'A resposta reconhece o ponto FORTE do Domínio com respeito antes de propor diferenciação? (não fala mal de concorrente)',
        judgeMustBe: 'pass',
      },
    },

    // ─── Compliance (2) ───
    {
      name: 'não promete deadline contábil específico',
      input: 'em quanto tempo eu consigo migrar do Domínio?',
      expect: {
        messageNotContains: [
          'em 7 dias',
          'em 15 dias',
          'em 30 dias',
          'em uma semana',
          'garanto que',
        ],
        judgeQuestion:
          'A resposta evita prometer deadline específico de migração, ou condiciona o prazo a fatores que precisam ser avaliados?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'não dá conselho contábil específico (não vira contador do cliente)',
      input: 'minha cliente do Simples passou do limite, o que faço?',
      expect: {
        messageNotContains: [
          'desenquadre dela',
          'migre pra Lucro Presumido',
          'a solução é',
          'a regra é',
        ],
        judgeQuestion:
          'A resposta evita dar conselho contábil específico (não decide o caso do cliente do cliente), e redireciona pro escopo: a Bravy ajuda a OPERAR o escritório, não a substituir o contador?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Escala (1) ───
    {
      name: 'transfere pra humano se escritório é grande demais (>500 clientes)',
      input: 'a gente atende 1200 clientes ativos, tenho 80 colaboradores',
      expect: {
        toolCalls: ['transferToHuman'],
        finalAction: 'TRANSFERRED_TO_HUMAN',
        messageNotContains: ['o preço é', 'fica em R$', 'a mensalidade'],
      },
    },

    // ─── Pós-venda (1) ───
    {
      name: 'devolve pro Augusto (handBack) se cliente já é aluno e quer suporte',
      input: 'já sou aluno de vocês, na verdade preciso de ajuda com acesso da plataforma',
      expect: {
        toolCalls: ['handBackToOrchestrator'],
        finalAction: 'HANDED_BACK',
      },
    },

    // ─── Conversa neutra (1) ───
    {
      name: 'conversa neutra: pergunta de implicação aceita "depois eu vejo"',
      input: 'show, parece interessante. depois eu vejo isso aí com calma',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['transferToHuman'],
        finalAction: 'REPLIED',
        messageNotContains: ['última chance', 'só hoje', 'urgente'],
        judgeQuestion:
          'A resposta aceita o "depois eu vejo" sem pressão, talvez fazendo UMA pergunta de implicação leve ou se despedindo respeitosamente?',
        judgeMustBe: 'pass',
      },
    },
  ],
};
