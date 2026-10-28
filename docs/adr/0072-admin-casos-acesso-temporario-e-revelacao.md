---
status: accepted
---

# Admin: casos de suporte, acesso temporário ao tenant e revelação de dados pessoais

## Contexto

O diagnóstico (ADR 0071) responde "o que há de errado" sem tocar em dado do tenant. Resolver um problema real às vezes exige ver registros da organização, e o plano (PR96 a PR98) pede que isso aconteça **com motivo, por tempo limitado, mascarado por padrão e auditado**. O desenho original ainda pedia uma prova com Hyperdrive e PostgreSQL de que o contexto administrativo funciona com RLS; a decisão abaixo a evita tornando o caminho do Admin o mesmo que já provamos no catálogo público: funções, não políticas nas tabelas do tenant.

## Decisão

- **O papel do Admin continua sem ler nenhuma tabela.** Todas as operações são funções `SECURITY DEFINER` com `search_path` fixo, de propriedade do mesmo papel sem login do ADR 0071 (`polaris_admin_owner`). Esse papel ganha apenas: leitura de `id` e `status` dos principais, leitura e inserção em três tabelas próprias do Admin (casos, acessos, auditoria) com atualização só das colunas de encerramento, e leitura por coluna de **uma** tabela do tenant, `customers`. Nenhuma política nas tabelas do tenant vale para outro papel.
- **Caso de suporte** (`support_cases`): organização, tipo (`support` ou `privacy`), motivo (1 a 500 caracteres), contexto opcional (até 2000), quem abriu, estado (`open`, `closed`) e resolução. Abrir exige uma organização que existe e um operador ativo. Fechar é idempotente e **revoga todos os acessos** do caso.
- **Acesso temporário** (`tenant_access_grants`): somente leitura, de **um operador**, a **uma organização**, pendurado em **um caso aberto**; padrão de 60 minutos, de 5 a 240 (o banco recusa mais de quatro horas), não se prorroga (dar outro acesso é uma nova decisão registrada na auditoria; não há teto de quantidade, limite aceito abaixo). Só pode ser encerrado antes do fim (revogação), por qualquer operador ativo. Vale só enquanto não revogado, dentro da janela e com o caso aberto; o relógio é o do banco.
- **O acesso é a única porta para os registros.** Um caso fechado não reabre e um acesso revogado não volta (gatilhos). Cada função de leitura começa exigindo um acesso ativo do operador no caso; sem ele, recusa (`42501`, sem dizer por quê). A primeira leitura entregue é a lista de **clientes**, uma página de 1 a 50 por cursor; um novo modelo de leitura do tenant entra pelo mesmo teste e por uma coluna a mais no papel, revisada.
- **Mascarado por padrão.** O nome mostra a primeira letra de cada palavra (e nada de uma palavra de uma letra), o e-mail a primeira letra de cada lado e só o último rótulo do domínio (`m***@e***.br`; o que não é um endereço mostra `***`), o telefone os dois últimos dígitos (nada se tiver menos de quatro) e as observações só aparecem como "existem ou não". A página tem um formato fechado de chaves.
- **Revelar é uma ação explícita**: um campo (`name`, `email`, `phone` ou `notes`) de um cliente da organização do caso, com acesso ativo, e **não existe outro campo a revelar** (senhas, tokens, segredos de cartão ou de webhook nem estão no papel). A revelação não acontece sem o registro: a função que devolve o valor é a que grava a auditoria.
- **Auditoria administrativa** (`platform_audit_events`): somente inserção (gatilho que recusa alterar, apagar e truncar, até para o dono do banco, por DML), escrita **na mesma transação** pela função que faz a coisa. Registra quem (principal), o quê (caso aberto ou fechado, acesso dado ou revogado, leitura de clientes, revelação), qual caso e organização, e uma nota curta e não sensível (o tipo, os minutos, o número de registros, **o nome do campo** revelado). **Nunca o valor.** Um cliente que não foi achado não deixa revelação.
- **Capacidades** (ADR 0070): `support_case:manage` (abrir, listar, ler e fechar casos e ver a trilha), `tenant_access:grant` (dar e revogar acesso), `tenant_data:read` (ler clientes mascarados), `pii:reveal` (revelar). A identidade do operador vem do login verificado, nunca do corpo.
- **Entrada.** Pedidos de mudança exigem corpo JSON pequeno e, quando o navegador informa a origem, que seja a do próprio Admin (o login é um cookie). IDs são UUID, páginas de 1 a 50, textos com tamanho limitado e sem caracteres de controle (o contexto aceita quebras de linha); um caso de privacidade não se abre por aqui: tem fluxo e capacidade próprios (`privacy_case:manage`, [ADR 0077](0077-casos-de-privacidade.md)) e a abertura genérica o recusa; um erro do banco nunca chega ao operador.

## Consequências

- Ver dados de um cliente exige: login no Access, ser operador ativo, ter aberto um caso com motivo, ter dado um acesso (que acaba sozinho) e, para o dado real, pedir a revelação de cada campo, tudo registrado sem o valor.
- O custo é uma verificação do acesso por chamada (uma linha pelo índice do caso) e uma linha de auditoria por leitura ou revelação.

## Limites aceitos

- O banco confia no ID do operador que o Worker do Admin passa (há um único login do Admin e o Worker o tira do token verificado): um Worker do Admin comprometido poderia agir como qualquer operador ativo; o que ele **não** consegue é ler fora de um acesso ativo ou deixar de auditar.
- Qualquer operador ativo pode revogar o acesso de outro (encerrar é sempre seguro).
- **Quem abre o caso pode dar o acesso a si mesmo**, e pode dar um acesso novo depois que o anterior acaba: não há segunda pessoa a aprovar nem teto de acessos por caso, só o registro de cada um. Uma aprovação por outra capacidade é o passo seguinte quando houver mais de um operador (o plano já separa as capacidades).
- **A auditoria só vale com o Hyperdrive do Admin sem cache de consultas.** Cada chamada é um `SELECT` de uma função que grava; o repositório torna cada comando volátil (`clock_timestamp()`) por defesa, mas a configuração sem cache é pré-condição registrada no runbook.
- Uma tentativa recusada (sem acesso, expirado, de outro operador) desfaz a transação e não deixa linha de auditoria; fica só no registro do operador (`tenant_access_denied`).
- Uma leitura que passou na verificação pode terminar milissegundos depois de o caso ser fechado em outra conexão.
- "Somente inserção" vale para DML (atualizar, apagar, truncar): o dono do banco ainda pode alterar a estrutura, o que é uma operação de manutenção, não do Admin.
- Só clientes são legíveis (mascarados); produtos, vendas e demais modelos entram quando houver necessidade e não são lidos hoje.
- O nome da organização e o motivo do caso (digitado pelo operador) aparecem nas listas.
- A tela do Admin (corte admin-tela-v1, parte B) lista os casos abertos da loja escolhida e abre caso de suporte com motivo (1 a 500 caracteres, sem controle); fechar caso, acesso temporário e revelação seguem só na API. Sem notificação ao cliente de que seus dados foram vistos (o caso de privacidade da Fase 10 cuida da prestação de contas ao titular).

## Alternativas rejeitadas

- **Políticas de linha por contexto administrativo nas tabelas do tenant:** a proposta original; exige provar contexto transacional com o pooler em cada tabela e deixa uma política errada como único freio. As funções têm uma superfície pequena e já foram provadas no catálogo.
- **Acesso por tempo mais longo ou renovável:** vira acesso permanente; um novo caso ou um novo acesso deixa a decisão registrada.
- **Revelar tudo de uma vez por cliente:** impede auditar o que de fato foi visto.
