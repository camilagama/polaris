---
status: accepted
---

# Estratégia de testes de banco: gates em Neon descartável e CI com PostgreSQL 18

## Contexto

Quase toda a garantia do Polaris vive no banco: RLS com `FORCE`, triggers deferidos, ledger append-only, grants mínimos e funções `SECURITY DEFINER`. Até o checkpoint do Gate 4, nada disso rodava em CI: o pipeline executa lint com boundaries, typecheck, testes unitários, Knip, build e o gate de navegador do offline, mas **não sobe PostgreSQL**, não reaplica as migrations, não confere drift do `db:generate` e nem sequer roda `format:check`. Cerca de dezenove gates e trinta e nove migrations só foram verificados à mão, em branches Neon descartáveis, com travas de host e de nome de branch nos scripts que impedem rodá-los contra um PostgreSQL de serviço. O plano prevê a suíte PostgreSQL em CI no PR122, muito depois do ponto em que as garantias já importam.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **Dois ambientes de prova, com papéis diferentes.**
  - **Neon descartável** (branch schema-only, de curta duração, banco novo por gate): continua sendo o ambiente de prova de aceite de cada fase, porque reproduz o provedor real. Procedimento em [gate-4-sales-core.md](../runbooks/gate-4-sales-core.md) e, para o Gate 3, no runbook `docs/runbooks/gate-3-catalog-stock.md` (escrito pelo responsável).
  - **CI com PostgreSQL 18** como serviço: roda a cada pull request, reaplica todas as migrations do zero, executa `db:generate` com checagem de diff (drift), `format:check` e os gates de banco, com as travas de host e de branch parametrizadas para aceitar o serviço de CI. O CI reduz o custo de reexecutar e impede regressão silenciosa; não substitui a prova no provedor. Enquanto o job `database` não tiver um histórico verde no GitHub Actions, ele roda como **consultivo** (não bloqueia o merge); a promoção a check obrigatório fica registrada como decisão do responsável. O job `audit` (`bun audit`) também é consultivo.
- **Gates sequenciais por banco.** Dois gates nunca rodam em paralelo no mesmo banco, porque os de falha injetada criam triggers em tabelas compartilhadas e contaminam a execução do outro. No CI, a sequência roda em um job com um banco por execução; paralelismo só entre bancos distintos.
- **Roles realistas.** Os gates devem exercitar as roles reais de aplicação (sem `BYPASSRLS` e sem ownership), uma sessão com fuso diferente de UTC e, quando houver, papéis além de `owner`.
- **Lacunas explícitas.** O CI não prova o caminho Worker, Hyperdrive e Neon (pooling, `set_config` e triggers deferidos através do pooler): essa prova com código tenant real roda em staging e está no checklist de go-live dos [runbooks](../runbooks/README.md).
- **Oráculos independentes.** Cenários de dinheiro usam um oráculo que exercite o arredondamento half-up (não apenas casos exatos), e as asserções de contagem de migrations não ficam fixas em números obsoletos.

## Consequências

- Regressões de RLS, triggers e migrations passam a quebrar o CI em vez de esperar um gate manual.
- O CI de banco tem custo de tempo e de manutenção dos scripts de gate (suporte comum para ambiente, SQLSTATE esperado e fixtures de tenant, hoje duplicado entre scripts).
- Branches Neon continuam limitadas por plano; apagar a própria branch depois do gate segue obrigatório.
- A promessa do plano (PR122) é antecipada para antes da Fase 5; o PR122 passa a cobrir apenas o que sobrar (harness do Worker, suíte de concorrência).

## Alternativas consideradas

- **Só gates manuais em Neon.** Mantém a fidelidade ao provedor, mas depende de memória e de tempo humano a cada mudança.
- **Mocks de banco em testes unitários.** Rápidos, mas não provam RLS, triggers nem grants, que são a razão dos gates.
- **Esperar o PR122.** Deixa dezenas de PRs de banco sem prova repetível.

## Emenda: o job de banco deixa de ser consultivo

O job "PostgreSQL 18 gates" nasceu consultivo (`continue-on-error`) até provar que ficava verde no GitHub. Ele ficou verde em cada pull request da cadeia de billing, e todas as falhas que mostrou eram defeitos de verdade (a auditoria de funções do `review-hardening`, uma corrida de milissegundos na revogação de concessões, uma expectativa de privilégio desatualizada), pegos só por ele e só porque alguém olhou o resultado. Agora uma falha dele é uma falha do pull request. A auditoria de dependências segue consultiva (as duas advertências altas conhecidas são de ferramentas de desenvolvimento). Tornar o check *obrigatório para o merge* é uma configuração de proteção de branch do GitHub, do responsável, e não está neste repositório; os mesmos gates continuam obrigatórios numa branch Neon descartável antes de uma liberação.

## Emenda: a pegada dos gates no Neon (issue #115)

**Fato.** Os gates em Neon criam uma branch schema-only (raiz) por execução e a apagam depois; cerca de cem branches em dez dias. O projeto de gates passou a mostrar "Limit reached" para armazenamento, embora o banco real tenha poucos MB. Os números vêm de duas leituras que ninguém confirmou no console: a contagem de branches (cerca de cem em dez dias) é do time, e os cerca de 31 MB lógicos da única branch persistente (`production`) são de uma consulta de CLI em 17/10/2026. Quem confirmar no console cita aqui a data da leitura.

**Hipótese da issue, ainda não confirmada.** Que cada branch raiz some o tamanho lógico inteiro à métrica mensal e que apagar a branch não devolva o volume. A documentação atual do Neon aponta em outra direção: o armazenamento do plano gratuito é um limite **contínuo** (1 GB por projeto, 20 GB na conta), as branches raiz são medidas por GB-mês com leitura por hora (uma branch de poucos MB que vive minutos pesa quase nada) e o plano gratuito tem ainda um histórico de restauração de 6 horas limitado a **1 GB-mês de mudanças**. Os gates escrevem muito (migrations, fixtures, vendas, concorrência), então o medidor mais provável é o do histórico de restauração (`instant_restore_bytes_month`), e não o das branches raiz (`root_branch_bytes_month`). Quem tem acesso ao console confirma comparando essas duas métricas por branch (a consulta de projeto pelo CLI devolveu zero nos campos de armazenamento, então não serve para isso); até lá, a causa continua em aberto.

**Decisão (opção c da issue, que vale qualquer que seja a causa: menos escrita no Neon).**

- O CI com PostgreSQL 18 (job "PostgreSQL 18 gates") já roda **todos** os gates em cada pull request. Rodar a suíte inteira também em Neon a cada pull request é redundante com ele.
- **Por pull request**, no Neon: só o gate novo do PR e os gates dos objetos que o PR tocou (tabelas, funções, políticas, papéis ou o executor), numa única branch que é reaproveitada para todos eles e apagada logo depois. Uma branch nova só quando uma migration ainda não publicada é emendada, e então o gate novo roda primeiro, para validar a migration antes dos demais.
- **A suíte completa** (`gates:all` ou `ci`) roda em Neon **uma vez por fase, disparada por quem entrega o último PR da fase (ou pelo responsável), e antes de uma liberação** (a prova de aceite que este ADR já pedia), e também quando mudam o executor (`run-gates.ts`), o suporte comum dos gates (`sales-gate-support.ts`) ou uma migration que muda privilégios amplamente.
- O relatório do pull request diz quais gates rodaram em Neon e que o restante ficou com o CI; não afirma que a suíte inteira passou em Neon quando só parte dela rodou.

**Opções não adotadas por ora.**

- **(a) Branches filhas de `production`.** Cada branch filha herdaria o estado de `production` (migrations já aplicadas, dados que existirem ali), o que enfraquece a prova de "migrations reaplicadas do zero" e arrisca misturar dado real com fixtures. Só valeria com uma branch-base própria, vazia e sempre em dia, o que é outra decisão.
- **(b) Outro projeto Free dedicado aos gates.** Não resolve o excesso de escrita e acrescenta uma segunda conta de recursos para a política de CLI. Fica como saída se, mesmo com o item acima, o limite voltar.

**Pergunta da issue sobre falhas.** (A resposta cobre só as execuções do agente de desenvolvimento, não as de outras pessoas; o job de CI usa PostgreSQL em container e nunca toca o Neon, então não entra nessa conta.) Nas execuções feitas pelo agente de desenvolvimento desde 16/10 (dezenas de branches, com migrations e gravações em cada uma), nenhuma migration nem gravação falhou por limite de armazenamento. A única falha de limite vista foi anterior e de outra natureza: a criação de branch recusada por excesso de branches raiz, resolvida apagando branches de gate já terminadas (o runbook do Gate 4 já pede isso).
