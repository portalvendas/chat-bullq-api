/**
 * Templates aprovados pela Meta, extraídos dos "Modelos de chat" do Kommo
 * (Armazém Decora). Todos APPROVED, categoria MARKETING, pt_BR. Usados para
 * popular a tela de Modelos de imediato; a fonte de verdade contínua é o sync
 * na Graph API (GET /{waba}/message_templates).
 */
export interface WaTemplateSeed {
  name: string;
  waba: string;
  bodyText: string;
}

export const WA_TEMPLATE_SEED: WaTemplateSeed[] = [
  // ── WABA 1728403631734473 (BM03 + boas-vindas BM02) ──
  {
    name: 'BM02 Boas vindas - Geral e Formulário - Kelen',
    waba: '1728403631734473',
    bodyText:
      'Oi, aqui é a Kelen da Armazém Decora e vai ser um prazer te atender, quer que eu envie o catálogo para você dar uma olhada nas opções?',
  },
  {
    name: 'BM02 Boas vindas - Geral e Formulário',
    waba: '1728403631734473',
    bodyText:
      'Oi, aqui é a Gabriela da Armazém Decora e vai ser um prazer te atender, quer que eu envie o catálogo para você dar uma olhada nas opções?',
  },
  {
    name: 'BM03 Podemos dar continuidade? COM botão',
    waba: '1728403631734473',
    bodyText: 'Preciso pedir/passar algumas informações. Podemos dar continuidade?',
  },
  {
    name: 'BM03 FUP automático 4',
    waba: '1728403631734473',
    bodyText:
      'Oi😊 Estamos com uma condição especial hoje e consigo aplicar diretamente na sua proposta. Consegue responder uma ou duas mensagens aqui?',
  },
  {
    name: 'BM03 FUP automático 3',
    waba: '1728403631734473',
    bodyText:
      'Oi, eu de novo 😊 Passando para te avisar que se confirmado nas próximas horas, consigo colocar seu pedido em produção ainda hoje.',
  },
  {
    name: 'BM03 FUP automático 2 Com botão',
    waba: '1728403631734473',
    bodyText:
      'Imagino que a rotina esteja corrida. Fiquei aguardando sua confirmação para seguir com seu orçamento. Podemos seguir? 😁',
  },
  {
    name: 'BM03 FUP automático 1',
    waba: '1728403631734473',
    bodyText: 'Oie! Consegue conversar agora ou prefere outro momento?',
  },
  {
    name: 'BM03 Chamar em 24+ Sem botão',
    waba: '1728403631734473',
    bodyText:
      'Oieee, tudo bem? Passando para dar um alô e a gente dar continuidade aqui na nossa conversa.',
  },
  {
    name: 'BM03 Chamar em 24h+ Com botão',
    waba: '1728403631734473',
    bodyText:
      'Oieee, tudo bem? Passando para dar um alô e a gente dar continuidade aqui na nossa conversa. Podemos continuar?',
  },
  {
    name: 'BM03 Fora de Expediente',
    waba: '1728403631734473',
    bodyText:
      'Você deixou seu nome e contato em nosso anúncio, não estamos online no momento, mas te atenderemos assim que abrirmos às 08h!',
  },
  {
    name: 'BM03 Boas vindas - Parceiros',
    waba: '1728403631734473',
    bodyText:
      'Oi, tudo bem? 👋 Vi que você tem interesse em realizar uma parceria com a Armazém Decora, pode me explicar um pouco mais sobre o trabalho que desenvolve atualmente?',
  },
  {
    name: 'BM03 Boas vindas - Geral e Formulário',
    waba: '1728403631734473',
    bodyText:
      'Oi, aqui é a Gabriela da Armazém Decora e vai ser um prazer te atender, quer que eu envie o catálogo para você dar uma olhada nas opções?',
  },

  // ── WABA 996103593208406 (BM02) ──
  {
    name: 'BM02 Boas vindas - Parceiros',
    waba: '996103593208406',
    bodyText:
      'Oi, tudo bem? 👋 Vi que você tem interesse em realizar uma parceria com a Armazém Decora, pode me explicar um pouco mais sobre o trabalho que desenvolve atualmente?',
  },
  {
    name: 'BM02 Fora de Expediente',
    waba: '996103593208406',
    bodyText:
      'Você deixou seu nome e contato em nosso anúncio, não estamos online no momento, mas te atenderemos assim que abrirmos às 08h!',
  },
  {
    name: 'BM02 Chamar em 24+ COM botão',
    waba: '996103593208406',
    bodyText:
      'Oieee, tudo bem? Passando para dar um alô e a gente dar continuidade aqui na nossa conversa.',
  },
  {
    name: 'BM02 Chamar em 24+ SEM botão',
    waba: '996103593208406',
    bodyText:
      'Oieee, tudo bem? Passando para dar um alô e a gente dar continuidade aqui na nossa conversa.',
  },
  {
    name: 'BM02 FUP automático 1',
    waba: '996103593208406',
    bodyText: 'Oie! Consegue conversar agora ou prefere outro momento?',
  },
  {
    name: 'BM02 FUP automático 2 SEM botão',
    waba: '996103593208406',
    bodyText:
      'Imagino que a rotina esteja corrida. Fiquei aguardando sua confirmação para seguir com seu orçamento. Podemos seguir? 😁',
  },
  {
    name: 'BM02 FUP automático 2 COM botão',
    waba: '996103593208406',
    bodyText:
      'Imagino que a rotina esteja corrida. Fiquei aguardando sua confirmação para seguir com seu orçamento. Podemos seguir? 😁',
  },
  {
    name: 'BM02 FUP automático 4',
    waba: '996103593208406',
    bodyText:
      'Oi😊 Estamos com uma condição especial hoje e consigo aplicar diretamente na sua proposta. Consegue responder uma ou duas mensagens aqui?',
  },
  {
    name: 'BM02 FUP automático 3',
    waba: '996103593208406',
    bodyText:
      'Oi, eu de novo 😊 Passando para te avisar que se confirmado nas próximas horas, consigo colocar seu pedido em produção ainda hoje.',
  },
  {
    name: 'BM02 Podemos dar continuidade? COM botão',
    waba: '996103593208406',
    bodyText: 'Preciso pedir/passar algumas informações. Podemos dar continuidade?',
  },

  // ── WABA 1022021287001848 (rascunhos "Novo modelo") ──
  {
    name: 'Novo modelo do WhatsApp (23.06.2026 09:13)',
    waba: '1022021287001848',
    bodyText:
      'Oi, tudo bem? 👋 Vi que você tem interesse em realizar uma parceria com a Armazém Decora, pode me explicar um pouco mais sobre o trabalho que desenvolve atualmente?',
  },
  {
    name: 'Novo modelo do WhatsApp (23.06.2026 09:12)',
    waba: '1022021287001848',
    bodyText:
      'Você deixou seu nome e contato em nosso anúncio, não estamos online no momento, mas te atenderemos assim que abrirmos às 08h!',
  },
  {
    name: 'Novo modelo do WhatsApp (23.06.2026 09:11)',
    waba: '1022021287001848',
    bodyText:
      'Oi, aqui é a Gabriela e vai ser um prazer te atender, quer que eu envie o catálogo para você dar uma olhada nas opções?',
  },
  {
    name: 'Novo modelo do WhatsApp (23.06.2026 09:10)',
    waba: '1022021287001848',
    bodyText:
      'Oi, aqui é a Gabriela e vai ser um prazer te atender, quer que eu envie o catálogo para você dar uma olhada nas opções?',
  },
  {
    name: 'Novo modelo do WhatsApp (22.06.2026 09:53)',
    waba: '1022021287001848',
    bodyText:
      'Oi😊 Estamos com uma condição especial hoje e consigo aplicar diretamente na sua proposta.',
  },
  {
    name: 'Novo modelo do WhatsApp (22.06.2026 09:52)',
    waba: '1022021287001848',
    bodyText:
      'Oi, eu de novo 😊 Passando para te avisar que se confirmado nas próximas horas, consigo colocar seu pedido em produção ainda hoje.',
  },
  {
    name: 'Novo modelo do WhatsApp (22.06.2026 09:52)',
    waba: '1022021287001848',
    bodyText:
      'Imagino que a rotina seja corrida. Fiquei aguardando sua confirmação para seguir com seu orçamento. Me avisa quando puder, por favor. 😁',
  },
  {
    name: 'Novo modelo do WhatsApp (22.06.2026 09:49)',
    waba: '1022021287001848',
    bodyText: 'Oie! Consegue conversar agora ou prefere outro momento?',
  },
];
