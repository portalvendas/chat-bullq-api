import type { EvalDataset } from '../types';

/**
 * Augusto Mendes — ORCHESTRATOR
 *
 * Função única: rotear pro worker certo. Não vende, não responde dúvida,
 * não cita preço/prazo/feature. Quatro caminhos: A) abrir porta,
 * B) qualificar uma vez, C) delegar, D) transferir pra humano.
 *
 * Cobertura: 4 roteamento correto + 2 ambíguo + 2 small talk + 1 transfer
 * + 1 classificação (vendor não-Bravy).
 */
export const augustoEval: EvalDataset = {
  agentName: 'Augusto Mendes',
  cases: [
    // ─── 4 casos de roteamento correto ───
    {
      name: 'roteia pra André quando lead é escritório contábil',
      input: 'tenho escritório contábil em SP, 80 clientes ativos',
      expect: {
        toolCalls: ['delegateToAgent'],
        shouldNotCall: ['replyToConversation'],
        finalAction: 'DELEGATED',
        delegateTo: 'André Silva',
        judgeQuestion:
          'O Augusto delegou pra André sem responder ao cliente antes (handoff invisível, sem replyToConversation antes do delegateToAgent)?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'roteia pra Bruno quando lead é banca de advocacia',
      input: 'sou advogado, banca trabalhista de 8 advogados aqui em BH',
      expect: {
        toolCalls: ['delegateToAgent'],
        finalAction: 'DELEGATED',
        delegateTo: 'Bruno Costa',
      },
    },
    {
      name: 'roteia pra Lívia se cliente já comprou e tem problema de acesso',
      input: 'comprei o curso ontem e não consigo logar',
      expect: {
        toolCalls: ['delegateToAgent'],
        finalAction: 'DELEGATED',
        delegateTo: 'Lívia Andrade',
      },
    },
    {
      name: 'roteia pra Daniel quando lead é setor genérico (agência)',
      input: 'tenho uma agência de marketing de 12 pessoas, queria automatizar',
      expect: {
        toolCalls: ['delegateToAgent'],
        finalAction: 'DELEGATED',
        delegateTo: 'Daniel Souza',
      },
    },

    // ─── 2 casos ambíguos (deve perguntar uma vez) ───
    {
      name: 'pergunta UMA vez quando lead é vago ("vi vocês no insta")',
      input: 'vi vocês no instagram, queria saber sobre os produtos',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['delegateToAgent'],
        finalAction: 'REPLIED',
        judgeQuestion:
          'A resposta faz UMA pergunta de qualificação curta (sobre nicho/área de atuação), sem listar produtos nem prometer demo?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'pergunta UMA vez quando lead diz só "queria saber sobre vocês"',
      input: 'queria saber mais sobre vocês',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['delegateToAgent'],
        finalAction: 'REPLIED',
        messageNotContains: ['preço', 'R$', 'curso de', 'mentoria'],
        judgeQuestion:
          'A resposta evita citar produto/preço/feature e faz UMA pergunta de qualificação aberta?',
        judgeMustBe: 'pass',
      },
    },

    // ─── 2 casos de small talk (responde ele mesmo, NÃO delega) ───
    {
      name: 'responde "oi" sem delegar (caminho A — abrir porta)',
      input: 'oi',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['delegateToAgent'],
        finalAction: 'REPLIED',
        messageNotContains: ['👋', '🙏', '✅'],
        judgeQuestion:
          'A resposta é curta, abre a conversa sem qualificar nem oferecer produto, e não usa emoji?',
        judgeMustBe: 'pass',
      },
    },
    {
      name: 'responde "bom dia" sem delegar (caminho A)',
      input: 'bom dia',
      expect: {
        toolCalls: ['replyToConversation'],
        shouldNotCall: ['delegateToAgent', 'transferToHuman'],
        finalAction: 'REPLIED',
      },
    },

    // ─── 1 caso de transferToHuman ───
    {
      name: 'transfere pra humano quando mensagem é incompreensível/spam',
      input: 'aaasdklajsdkljaskldj 12938712983 ???? !!!!! 🐱🐱🐱',
      expect: {
        toolCalls: ['transferToHuman'],
        shouldNotCall: ['delegateToAgent'],
        finalAction: 'TRANSFERRED_TO_HUMAN',
      },
    },

    // ─── 1 caso de classificação (lead claramente fora do escopo Bravy) ───
    {
      name: 'NÃO desqualifica lead que vende fone de ouvido (Bravy atende qualquer empresário)',
      input: 'tenho uma loja de fone de ouvido no shopping, 4 funcionários',
      expect: {
        toolCalls: ['delegateToAgent'],
        finalAction: 'DELEGATED',
        delegateTo: 'Daniel Souza',
        messageNotContains: [
          'não é nosso foco',
          'não atendemos',
          'não trabalhamos com',
        ],
        judgeQuestion:
          'O Augusto delegou pra Daniel (vendedor generalista) ao invés de dizer que não atende esse perfil?',
        judgeMustBe: 'pass',
      },
    },
  ],
};
