---
status: accepted
---

# Admin: diagnóstico de organização sem acesso ao tenant

## Contexto

Operar o Polaris exige olhar para uma organização: ela está ativa, em que plano, dentro dos limites, com aparelhos e sincronização saudáveis, com cobrança em dia? Nada disso precisa de um produto, um cliente ou uma venda. Dar ao Admin leitura das tabelas do tenant para responder isso abriria, de uma vez, o que a Fase 9 quer proteger (dados pessoais, dados de negócio). O plano (PR95) pede essa visão "sem mostrar dados de negócio completos por padrão".

## Decisão

- **O Admin continua sem ler nenhuma tabela.** Ele executa duas funções `SECURITY DEFINER` com `search_path` fixo (`admin_organizations_overview` e `admin_organization_diagnostics`), de propriedade de um papel que não é login (`polaris_admin_owner`) e que só lê **colunas** necessárias, com políticas de linha próprias. O papel do tenant, o de cobrança, o do catálogo e PUBLIC não executam nenhuma delas.
- **O que elas devolvem são contagens, datas e estados**: status da organização, fuso e moeda, quantos membros ativos e a época de autorização; o registro de cobrança (estado, fim do acesso, ciclo, cancelamento ao fim do período, janela acima do limite, provedor, último fato, estorno lembrado); as concessões (chave, valor, início, fim, encerramento, **sem motivo nem autor**); o uso (produtos ativos e arquivados, variantes de produtos não removidos, imagens ligadas a produtos não removidos e o máximo por produto, metas ativas: as mesmas contagens que o produto aplica contra os limites); aparelhos e concessões offline em vigor; comandos de sincronização dos últimos sete dias por resultado e as recusas por código; eventos de cobrança por estado, o mais antigo não processado e o maior número de tentativas. **Nunca** o nome de um produto, cliente ou pessoa, e-mail, rótulo de aparelho, valor monetário, caminho de arquivo ou conteúdo de comando. A lista de organizações traz ID, nome da organização, status, criação, estado de cobrança, fim do acesso e o plano que o registro de cobrança dá agora (sem contar concessões).
- **O plano e as cotas são calculados pelo mesmo motor do produto** (`@polaris/domain/admin/organization-diagnostics`): o catálogo de planos vem da tabela, a concessão em vigor segue a mesma regra (uma encerrada antes de começar nunca valeu), o relógio é o do banco e um período vencido já é Free mesmo que o registro ainda diga ativo. O relatório diz o uso contra cada limite (`ok`, `at_limit`, `over`) e uma lista de pontos de atenção (organização não ativa, acima do limite do Free, eventos de cobrança falhos ou parados há mais de uma hora, recusas de sincronização, concessão acabando em sete dias, estado de cobrança desconhecido).
- **Busca.** Por ID exato ou pelo começo do nome, sem curinga (`starts_with`), páginas de 1 a 50 por cursor de ID; consulta de até 100 caracteres.
- **Autorização.** Cada rota do Admin pede `organization:diagnose` (ADR 0070); a função não conhece o principal, e o papel do banco só existe para o Worker do Admin. A leitura não é auditada: o que ela devolve não é dado sensível. Ler registros do tenant será outro caminho, com caso de suporte, acesso temporário e auditoria (PR96 a PR98).

### Emenda de 27/10/2026: o funil de ativação, agregado sem loja (corte 2.4)

O item 2.4 do plano mede a ativação das lojas (cadastro, 1º produto, 1ª venda, tempo até a 1ª venda e retenção) só a partir das tabelas existentes. Datas de venda são atividade comercial, que esta decisão deixa atrás do acesso temporário quando são **de uma loja**. Um agregado da plataforma, sem loja, é uma classe que a decisão não tratava; esta emenda a abre com condições (desenho do Filipe, D-1 a D-3 e T-1 a T-4; condições do Rodrigo, que prevalecem onde forem mais restritivas).

- **Uma função, sem loja.** `admin_activation_funnel(p_weeks)`, `SECURITY DEFINER` do `polaris_admin_owner`, `search_path` fixo, `STABLE`, executada só pelo papel do Admin. Devolve **só contagens** por coorte semanal: nenhum ID, nome, e-mail, valor, item ou data individual. O agregado de atividade sem identificação de loja é permitido; vendas por loja e qualquer coisa que isole uma loja continuam atrás do acesso temporário ([ADR 0072](0072-admin-casos-acesso-temporario-e-revelacao.md)). A emenda **não** abre lista de lojas com seus marcos.
- **Colunas a mais no papel dono, só de data e de vínculo:** `"user"` (`id`, `created_at`, `email_verified`; nunca `email`, `name` nem `image`) e `sales` (`organization_id`, `confirmed_at`; nunca `total`, item nem a data do negócio), com política de linha própria de cada uma. `organizations`, `products` e `memberships` já tinham as colunas que o funil lê. O gate prova as colunas, como para o diagnóstico.
- **Semana e marcos.** Semana ISO (segunda a domingo) de Brasília para todas as lojas, calculada no banco; a semana corrente é `inProgress`. A coorte é a semana de `organizations.created_at`. O 1º produto conta o produto apagado (a loja chegou ao marco) e uma loja com venda também chegou a ele. A 1ª venda é `sales.confirmed_at`, o relógio do servidor (a venda da fila offline conta na hora em que o servidor a confirmou), nunca a data do negócio; a venda cancelada depois conta. Faixas do tempo até a 1ª venda: até 10 minutos, até 1 hora, até 1 dia, até 7 dias, depois; "ativada em 7 dias" é a soma das quatro primeiras (hipótese a ajustar com 20 lojas). Retenção da semana N (2, 3 e 5): a loja teve ao menos uma venda confirmada na sua semana N, sendo a 1 a semana da criação; só entra a semana N já fechada.
- **Cadastros à parte.** Contas verificadas criadas na semana e, delas, quantas são membro de uma loja hoje. É outra coorte (a semana da conta não é a da loja) e inclui as contas internas e só as ainda existentes (o cadastro nunca verificado some em 24 horas).
- **Lojas internas fora.** Lojas do próprio Polaris (QA, do dono, do time) ficam fora de todo número e só o total delas no período aparece. O marcador é uma tabela da plataforma, `platform_internal_organizations` (loja, instante e operador; sem dado pessoal), com RLS forçada e nenhum grant ao tenant, à cobrança, ao catálogo nem a PUBLIC: só o dono das funções do Admin a lê e escreve. Não é coluna de `organizations` (o tenant lê e insere linhas lá) nem o prefixo `qa-` do nome (digitado pelo cliente). Quem marca e desmarca é o comando `admin_classify_organization`, da capacidade nova `organization:classify`, auditado na mesma transação (`organization.marked_internal` e `organization.unmarked_internal`), sem caso de suporte porque a loja é da própria plataforma; a semeadura de QA marca a loja que semeia como dono do banco (sem operador e sem auditoria, como o cadastro de um principal). O marcador vive com a linha da organização (cascata).
- **Supressão, k = 5 (Rodrigo).** O operador já vê a lista de lojas com a data de criação, então sabe quem está em cada coorte; por isso o limite vale para **toda célula**, não só para o total da coorte:
  - a coorte é cortada em células disjuntas (sem produto; com produto e sem venda; cada faixa de tempo) e a função mostra o corte mais fino de uma lista fixa de cortes mais grossos cujas células têm todas 5 lojas ou mais. Cada número mostrado é a união de células desse corte: nem ele, nem o complemento, nem a diferença de dois números aninhados fica abaixo de 5, então a célula escondida não sai por soma (supressão complementar) e 0 ou a coorte inteira nunca aparecem (tudo ou nada). As faixas aparecem todas ou nenhuma;
  - a retenção da semana N aparece só quando ela e "vendeu, mas não nessa semana" têm 5 ou mais;
  - o total de lojas da coorte e o de cadastros aparecem com 5 ou mais;
  - célula escondida é `suppressed`, sem valor e sem motivo (o motivo diria qual lado é pequeno); o que ainda não se sabe é `unavailable` com motivo (`activation_window_open` até cada loja da coorte ter tido seus 7 dias; `week_not_closed`), **nunca 0**.
- **Sem parâmetro livre e nada guardado.** A única escolha é o número de semanas (1 a 26). Nada de janela por dia, filtro, ordenação ou intervalo: janelas escolhidas permitiriam isolar uma loja por diferença. A função calcula na hora e não grava (é `STABLE`); nenhuma tabela de resultado nem instantâneo.
- **Limite residual aceito.** Ler a mesma coorte em dias diferentes mostra quando uma contagem passa de 5 para 6 (ou um número aparece). Com a supressão acima isso não diz qual loja; não vira dado por loja.
- **A leitura não é auditada**, como o resto deste ADR: devolve só agregado suprimido. Registrar quem leu (sem conteúdo), para notar alguém varrendo a função, é sugestão do Rodrigo que não bloqueia; fica para a decisão do Arrascaeta.
- **Custo.** Uma consulta por leitura: por loja da janela, a 1ª venda e três buscas de semana pelo `sales_organization_confirmed_idx` (só índice). Medida no gate com 1.000 lojas e 50.000 vendas (PostgreSQL 18 local): cerca de 70 ms por chamada, sem índice novo. A rota e o contrato estrito que a lê são do PR seguinte (t431).

## Consequências

- O operador responde "o que há de errado com esta organização" sem nenhum acesso a dados do tenant; uma nova pergunta de diagnóstico é uma coluna a mais no papel e um campo a mais na função, revisados, não uma permissão ampla.
- O custo é uma consulta com várias contagens por organização (todas por índices de organização), só quando um operador abre a organização.

## Limites aceitos

- O nome da organização é mostrado ao operador (ajuda a achá-la): é um dado digitado pelo cliente, mas não é dado pessoal por definição; o gate prova que o dono das funções só lê as colunas listadas e que o JSON tem formato fechado, sem nenhum texto livre além do nome.
- Sem dados de atividade comercial (vendas, receita) **de uma loja**: são dados de negócio e ficam atrás do acesso temporário. O funil de ativação é a exceção agregada da emenda de 27/10/2026, sem loja e com supressão.
- Os pontos de atenção são heurísticas fixas (uma hora, sete dias); ajustar é uma mudança de código.
- "Jobs e erros" do plano cobre os eventos de cobrança (estado, parados, tentativas) e as recusas de sincronização; a limpeza de mídia e outras tarefas agendadas entram quando tiverem estado próprio para consultar.
- O último visto offline vem do aparelho, que pode servir a mais de uma organização: o mesmo valor aparece nas duas.
- Um catálogo de planos danificado faz o diagnóstico responder 503 com código estável (o produto também falha fechado nesse caso).

## Alternativas rejeitadas

- **Dar ao papel do Admin `SELECT` nas tabelas com políticas por contexto:** o desenho alvo da fase para o acesso temporário, mas excessivo para contagens e arriscado se uma política falhar.
- **Visões materializadas de diagnóstico:** dados defasados e mais uma cópia para manter, sem ganho para o volume esperado.
