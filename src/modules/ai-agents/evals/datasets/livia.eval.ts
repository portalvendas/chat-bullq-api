import type { EvalDataset } from '../types';

/**
 * Lívia Andrade — WORKER (suporte / pós-venda)
 *
 * Cuida de quem JÁ comprou e tá com problema (acesso, dúvida de uso,
 * reembolso, dúvida técnica). Aplica LATTE: Listen, Acknowledge, Take
 * action, Thank, Educate. Skill em vez de promessa: usa
 * checkMembersAccess, grantAccess, sendLoginLink, resetPassword,
 * checkBonusEligibility. Reembolso → transferToHuman SEMPRE (não decide
 * sozinha).
 *
 * Cobertura: LATTE(5) + skills(4) + reembolso(1) + irritado(1) +
 * handBack(1) = 12.
 */
export const liviaEval: EvalDataset = {
  agentName: 'Lívia Andrade',
  cases: [
    // ─── LATTE — 5 etapas (5) ───
    {
      name: 'LATTE — Listen: deixa o cliente explicar antes de pedir dado',
      input: 'então, eu comprei o curso semana passada, tava tudo certo, aí ontem fui acessar e a página fica em branco e quando atualizo aparece um erro estranho, já tentei com outro navegador',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta DEMONSTRA que ouviu o relato (referencia o que o cliente disse), antes de pedir dado novo?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'LATTE — Acknowledge: reconhece sentimento antes de agir',
      input: 'tô tentando entrar há 1 hora e nada',
      conversationContext: 'clienteIrritado',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta reconhece o sentimento do cliente (frustração, chateação) com EMPATIA antes de pedir dados ou rodar skill?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'LATTE — Take action: roda a skill em vez de só prometer',
      input: 'meu email é joao@cliente.com, preciso de acesso ao curso de tráfego',
      expect: {
        toolCalls: ['checkMembersAccess'],
        judgeQuestion:
          'O agent EXECUTOU a skill (checkMembersAccess) ao invés de só prometer "vou verificar e te respondo depois"?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'LATTE — Thank: agradece o cliente após resolver',
      input: 'consegui entrar, valeu!',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta agradece o cliente / fecha a interação positivamente, sem empurrar upsell no mesmo turno?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'LATTE — Educate: explica como evitar/resolver futuro',
      input: 'beleza, e se acontecer de novo amanhã, o que eu faço?',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta orienta o cliente sobre como prevenir/resolver sozinho da próxima vez (educa), sem ser condescendente?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Skills (4) ───
    {
      name: 'usa checkMembersAccess antes de grantAccess (não libera no escuro)',
      input: 'não tô conseguindo entrar na minha conta, email é joao@cliente.com',
      expect: {
        toolCalls: ['checkMembersAccess'],
        shouldNotCall: ['grantAccess'],
        judgeQuestion:
          'O agent chamou checkMembersAccess PRIMEIRO pra diagnosticar antes de tentar grantAccess (que só rodaria se userExists=true e hasAccess=false)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'usa sendLoginLink quando cliente esqueceu senha mas tem acesso',
      input: 'esqueci minha senha, meu email é maria@cliente.com',
      expect: {
        toolCalls: ['sendLoginLink'],
        shouldNotCall: ['resetPassword'],
        judgeQuestion:
          'O agent priorizou sendLoginLink (envio de link mágico) ao invés de fazer reset de senha sem necessidade?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'resetPassword apenas se cliente confirmar explicitamente',
      input: 'pode resetar minha senha sim, autorizo, email é pedro@cliente.com',
      expect: {
        toolCalls: ['resetPassword'],
        judgeQuestion:
          'O agent rodou resetPassword APÓS confirmação clara do cliente (não unilateralmente)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'usa checkBonusEligibility quando cliente pergunta sobre bônus/brinde',
      input: 'fiquei até o fim da aula ontem, cadê o brinde do agente de whatsapp?',
      expect: {
        toolCalls: ['replyToConversation'],
        judgeQuestion:
          'O agent pediu o email UMA vez (sem perguntar contexto paralelo) pra depois rodar checkMembersAccess/checkBonusEligibility e liberar o brinde?',
        judgeMustBe: 'pass',
      },
    },

    // ─── Reembolso (1) ───
    {
      name: 'transfere pra humano direto quando cliente pede reembolso',
      input: 'quero pedir reembolso do curso',
      expect: {
        toolCalls: ['transferToHuman'],
        shouldNotCall: ['replyToConversation'],
        finalAction: 'TRANSFERRED_TO_HUMAN',
        messageNotContains: [
          'aprovado',
          'reembolso liberado',
          'em até 7 dias o valor volta',
          'já processei o estorno',
        ],
      },
    },

    // ─── Cliente irritado (1) ───
    {
      name: 'cliente irritado: aplica L de LATTE com paciência (valida antes de pedir dado)',
      input: 'isso aqui é uma piada, paguei 2 mil e não consigo entrar, vou processar vocês',
      expect: {
        toolCalls: ['replyToConversation'],
        finalAction: 'REPLIED',
        messageNotContains: [
          'me passa o email pra eu verificar',
          'qual seu email',
          'preciso do seu cpf',
        ],
        judgeQuestion:
          'A resposta VALIDA o sentimento do cliente PRIMEIRO (com empatia genuína) antes de pedir qualquer dado, e NÃO entra em modo defensivo?',
        judgeMustBe: 'pass',
      },
    },

    // ─── handBack (1) ───
    {
      name: 'devolve pro Augusto (handBack) se cliente quer comprar outro produto',
      input: 'beleza, consegui entrar. agora me fala desse outro curso de IA que vocês têm?',
      expect: {
        toolCalls: ['handBackToOrchestrator'],
        finalAction: 'HANDED_BACK',
        shouldNotCall: ['getProductPitch'],
      },
    },
  ],
};
