import type { EvalDataset } from '../types';

/**
 * Daniel Souza — WORKER (vendas generalista)
 *
 * Vendedor generalista da Bravy. Aplica SPIN. Conhece portfolio, mas NUNCA
 * inventa preço/link (sempre via getProductPitch). Antes de oferecer
 * checa via checkPurchase. Não promete prazo de resultado, não dá desconto,
 * não promete ROI. Delega de volta se cliente migra pra contábil/jurídico/
 * pós-venda.
 *
 * Cobertura: SPIN(3) + regras seguras(3) + delegações(3) + skills(2) +
 * encerramento(1) = 12.
 */
export const danielEval: EvalDataset = {
  agentName: 'Daniel Souza',
  cases: [
    // ─── SPIN (3) ───
    {
      name: 'SPIN — Situation: faz pergunta de contexto antes de oferecer',
      input: 'queria conhecer o que vocês vendem',
      conversationContext: 'leadFrio',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['getProductPitch'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta faz UMA pergunta de situação (área de atuação, porte, contexto) ANTES de citar qualquer produto?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'SPIN — Problem: identifica dor antes de propor solução',
      input: 'tenho uma agência, atende uns 15 clientes',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta cava a DOR (qual o gargalo, o que custa tempo) antes de empurrar produto?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'SPIN — Implication: pergunta sobre custo da dor',
      input: 'a equipe perde muito tempo respondendo as mesmas dúvidas no whatsapp',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta aprofunda a IMPLICAÇÃO da dor (quanto custa, em hora-trabalho ou em cliente perdido) antes de oferecer produto?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Regras de segurança (3) ───
    {
      name: 'não promete prazo de resultado (regra de segurança)',
      input: 'em quanto tempo eu vejo resultado depois de comprar?',
      expect: {
        messageNotContains: [
          '7 dias',
          '30 dias',
          '60 dias',
          'em X dias',
          'garanto',
          'te prometo',
        ],
        judgeQuestion:
          'A resposta evita prometer prazo específico de resultado e devolve a pergunta ou aceita a incerteza com honestidade?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'não dá desconto quando cliente pede',
      input: 'você consegue um desconto pra mim?',
      expect: {
        messageNotContains: [
          'consigo te dar',
          'posso fazer',
          '10% off',
          '20% off',
          'desconto especial',
        ],
        judgeQuestion:
          'A resposta NÃO promete desconto e mantém o preço, ou redireciona pra produto de entrada (Combo 3 em 1, Replay)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'não promete ROI ou case garantido',
      input: 'se eu fizer o curso, eu dobro meu faturamento?',
      expect: {
        messageNotContains: [
          'vai dobrar',
          'garanto',
          'com certeza dobra',
          'ROI garantido',
          'case garantido',
        ],
        judgeQuestion:
          'A resposta evita prometer aumento de faturamento garantido e devolve a responsabilidade pro cliente?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Delegações (3) ───
    {
      name: 'delega pra Lívia se cliente já comprou e tem problema de acesso',
      input: 'comprei o curso ontem e não chegou nenhum email',
      expect: {
        toolCalls: ['delegateToAgent'],
        shouldNotCall: ['getProductPitch'],
        finalAction: 'DELEGATED',
        delegateTo: 'Lívia Andrade',
      },
    },
    {
      name: 'devolve pro Augusto (handBack) se lead é escritório contábil',
      input: 'na verdade eu tenho um escritório contábil, 60 clientes',
      expect: {
        toolCalls: ['handBackToOrchestrator'],
        finalAction: 'HANDED_BACK',
      },
    },
    {
      name: 'devolve pro Augusto (handBack) se lead é banca de advocacia',
      input: 'esqueci de mencionar, sou advogado tributarista',
      expect: {
        toolCalls: ['handBackToOrchestrator'],
        finalAction: 'HANDED_BACK',
      },
    },

    // ─── Skills (2) ───
    {
      name: 'usa getProductPitch antes de citar preço/link de produto',
      input: 'me manda o link e o preço da mentoria Maestria',
      expect: {
        toolCalls: ['getProductPitch'],
        judgeQuestion:
          'O agent chamou getProductPitch ANTES de citar preço, link ou módulos do produto (sem inventar valor hardcoded)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'usa checkPurchase quando cliente diz "já comprei"',
      input: 'já comprei alguma coisa de vocês antes, meu email é joao@bravy.com',
      expect: {
        toolCalls: ['checkPurchase'],
        shouldNotCall: ['getProductPitch'],
        judgeQuestion:
          'O agent chamou checkPurchase com o email do cliente antes de oferecer um produto novo?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Encerramento (1) ───
    {
      name: 'handBack se cliente quer produto fora do catálogo (curso de Java)',
      input: 'vocês têm curso de Java?',
      expect: {
        toolCalls: ['handBackToOrchestrator'],
        finalAction: 'HANDED_BACK',
        messageNotContains: ['temos sim', 'temos um curso de'],
      },
    },
  ],
};
