# Acordo de Tratamento de Dados Pessoais (DPA) — Kortia CRM

> **MINUTA / RASCUNHO — NÃO É PARECER JURÍDICO.** Primeira versão para revisão por
> advogado(a) habilitado(a). Preencha os campos `[ ]`. Base: Lei nº 13.709/2018 (LGPD).
> Última atualização: 2026-08-18.

Este Acordo integra e complementa os Termos de Uso do Kortia CRM e disciplina o
tratamento de Dados Pessoais realizado pela Plataforma.

**Partes:**
- **Controladora:** a Empresa Contratante (organização/workspace) que utiliza a Plataforma.
- **Operadora:** `ARMAZÉM DECORA LTDA`, CNPJ `37.760.408/0001-71`, operadora do Kortia CRM.

## 1. Definições

Os termos **Dado Pessoal, Dado Pessoal Sensível, Titular, Tratamento, Controlador,
Operador, Encarregado (DPO), Eliminação, ANPD** têm o significado da LGPD.

## 2. Objeto e papéis

2.1. A Controladora determina as finalidades e os meios do tratamento dos Dados
Pessoais dos Clientes Finais (leads, compradores, contatos) inseridos ou coletados
por meio da Plataforma.
2.2. A Operadora trata esses Dados Pessoais **em nome e sob as instruções da
Controladora**, exclusivamente para prestar os serviços do Kortia CRM.
2.3. A Operadora poderá tratar dados de cadastro dos **Usuários** da Controladora
(nome, e-mail) como Controladora, para fins de autenticação, segurança e suporte —
regidos pela Política de Privacidade.

## 3. Natureza do tratamento

- **Finalidade:** operação de CRM e atendimento multicanal — receber, armazenar,
  organizar, exibir e responder mensagens; gestão de contatos, conversas, funis e
  automações; envio/recebimento por canais integrados.
- **Categorias de titulares:** clientes finais, leads e contatos da Controladora.
- **Categorias de dados:** identificação e contato (nome, telefone, e-mail),
  conteúdo de conversas e anexos, identificadores de canais/marketplaces, e demais
  dados que a Controladora optar por inserir. A Controladora compromete-se a **não
  inserir dados sensíveis** sem base legal adequada e ciência dos riscos.
- **Duração:** enquanto durar o contrato, ressalvadas obrigações legais de retenção.

## 4. Obrigações da Operadora

A Operadora:
4.1. Tratará os Dados apenas conforme as instruções documentadas da Controladora
(estes Termos, o DPA e as configurações da conta), salvo obrigação legal.
4.2. Garantirá que pessoas autorizadas a tratar os Dados estejam sob dever de sigilo.
4.3. Adotará medidas de segurança técnicas e administrativas adequadas (cláusula 7).
4.4. Auxiliará a Controladora, na medida do possível, no atendimento às requisições
dos titulares e no cumprimento das obrigações da LGPD (relatórios de impacto,
consultas da ANPD).
4.5. Comunicará à Controladora eventual **incidente de segurança** que possa acarretar
risco ou dano relevante aos titulares, **sem demora injustificada** após tomar
conhecimento, com as informações disponíveis para que a Controladora avalie a
comunicação à ANPD e aos titulares (art. 48 da LGPD).
4.6. Manterá registro das operações de tratamento que realizar.
4.7. Ao término, eliminará ou devolverá os Dados conforme a cláusula 8.

## 5. Obrigações da Controladora

5.1. Possuir **base legal** para o tratamento (art. 7º/11 da LGPD) e ser responsável
pela relação com os titulares.
5.2. Fornecer instruções lícitas e configurar a Plataforma adequadamente.
5.3. Responder, como Controladora, às requisições e reclamações dos titulares,
utilizando os recursos da Plataforma (inclusive exportação e exclusão de dados).
5.4. Não inserir dados ilícitos ou sem base legal.

## 6. Suboperadores

6.1. A Controladora autoriza a Operadora a contratar **suboperadores** para a
prestação do serviço, mediante obrigações de proteção de dados equivalentes às
deste DPA. Suboperadores atuais incluem, entre outros:
- **Render, Inc.** — hospedagem/infraestrutura (aplicação e banco de dados), EUA (Oregon);
- **Resend** — envio de e-mail transacional;
- **Backblaze B2** — armazenamento de mídias (imagens, áudios e anexos das conversas);
- **Provedor de IA/LLM** (ex.: OpenAI e/ou Anthropic) — processamento de conteúdo de
  conversas pelos agentes de IA, quando ativados pela Controladora;
- provedores dos canais integrados (Meta/WhatsApp Cloud API e Instagram; Z-API e
  Zappfy para WhatsApp; Mercado Livre; Shopee; Tiny/Olist), conforme o canal ativado
  pela Controladora.
6.2. A Operadora informará alterações relevantes no rol de suboperadores, facultando
oposição fundamentada.

## 7. Segurança da informação

Medidas adotadas incluem, no mínimo:
- **Criptografia** de segredos sensíveis em repouso (ex.: tokens de canais) e uso de
  conexões seguras (TLS) em trânsito;
- **Isolamento lógico entre organizações** (multi-tenant), com controle de acesso por
  papéis e escopo por canal;
- **Autenticação** por credenciais e tokens de sessão com expiração;
- **Trilhas de auditoria** para ações administrativas sensíveis;
- Controle de acesso restrito e princípio do menor privilégio;
- Rotinas de backup do provedor de infraestrutura.
`[Detalhar/atualizar conforme a realidade e revisão de segurança.]`

## 8. Devolução e eliminação

8.1. A qualquer tempo durante a vigência, a Controladora pode **exportar** os dados da
sua organização por meio da Plataforma (formato estruturado).
8.2. Ao término do contrato, ou mediante solicitação, a Operadora **eliminará** os
Dados Pessoais da organização, ressalvadas hipóteses legais de conservação (art. 16
da LGPD). A Plataforma dispõe de função de exclusão definitiva por organização.
8.3. A eliminação ocorrerá em até **90 (noventa) dias** após o término do contrato — janela em que a Controladora ainda pode exportar/recuperar os dados —, ressalvadas obrigações legais de conservação.

## 9. Transferência internacional

9.1. A infraestrutura da Plataforma é hospedada em provedor localizado **fora do
Brasil** (ex.: **Render, Inc. — região de Oregon, EUA**). Assim, o tratamento envolve
**transferência internacional de Dados Pessoais**.
9.2. A Operadora adotará garantias adequadas para tais transferências, nos termos do
Capítulo V da LGPD (arts. 33 a 36), incluindo cláusulas contratuais e/ou os
mecanismos que vierem a ser reconhecidos pela ANPD.
9.3. A Controladora declara ciência e concorda com essa transferência como necessária
à prestação do serviço. `[Sujeito a revisão jurídica e eventual adequação a normas da ANPD.]`

## 10. Responsabilidade

Cada parte responde pelos danos que causar em razão do descumprimento de suas
obrigações sob a LGPD e este DPA, observadas as limitações dos Termos de Uso e a
repartição de responsabilidade prevista nos arts. 42 a 45 da LGPD.

## 11. Vigência

Este DPA vigora enquanto houver tratamento de Dados Pessoais no âmbito do contrato,
sobrevivendo, no que couber, ao término deste (ex.: sigilo, eliminação).

## 12. Encarregado (DPO)

Encarregado pela proteção de dados da Operadora: `Diogo Augustin — diogoaugustin@gmail.com`.
Canal para titulares e para a Controladora: `diogoaugustin@gmail.com`.

---

**Anexo I — Resumo do tratamento** (preencher/ajustar):
| Item | Descrição |
|---|---|
| Finalidade | CRM e atendimento multicanal |
| Categorias de titulares | Clientes finais, leads, contatos da Controladora |
| Categorias de dados | Nome, telefone, e-mail, conteúdo de conversas e anexos, IDs de canal |
| Suboperadores | `Render, Resend, Backblaze B2, provedor de IA/LLM, provedores de canais (Meta, Z-API, Zappfy, Mercado Livre, Shopee, Tiny)` |
| Local de tratamento | Brasil e `EUA (Oregon)` (transferência internacional) |
| Retenção | Durante o contrato + `90 dias após o término (para exportação/recuperação), seguido de eliminação; ressalvadas retenções legais obrigatórias`; exclusão sob demanda |
