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

## Consequências

- O operador responde "o que há de errado com esta organização" sem nenhum acesso a dados do tenant; uma nova pergunta de diagnóstico é uma coluna a mais no papel e um campo a mais na função, revisados, não uma permissão ampla.
- O custo é uma consulta com várias contagens por organização (todas por índices de organização), só quando um operador abre a organização.

## Limites aceitos

- O nome da organização é mostrado ao operador (ajuda a achá-la): é um dado digitado pelo cliente, mas não é dado pessoal por definição; o gate prova que o dono das funções só lê as colunas listadas e que o JSON tem formato fechado, sem nenhum texto livre além do nome.
- Sem dados de atividade comercial (vendas, receita): são dados de negócio e ficam atrás do acesso temporário.
- Os pontos de atenção são heurísticas fixas (uma hora, sete dias); ajustar é uma mudança de código.
- "Jobs e erros" do plano cobre os eventos de cobrança (estado, parados, tentativas) e as recusas de sincronização; a limpeza de mídia e outras tarefas agendadas entram quando tiverem estado próprio para consultar.
- O último visto offline vem do aparelho, que pode servir a mais de uma organização: o mesmo valor aparece nas duas.
- Um catálogo de planos danificado faz o diagnóstico responder 503 com código estável (o produto também falha fechado nesse caso).

## Alternativas rejeitadas

- **Dar ao papel do Admin `SELECT` nas tabelas com políticas por contexto:** o desenho alvo da fase para o acesso temporário, mas excessivo para contagens e arriscado se uma política falhar.
- **Visões materializadas de diagnóstico:** dados defasados e mais uma cópia para manter, sem ganho para o volume esperado.
