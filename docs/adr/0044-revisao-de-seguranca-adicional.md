---
status: accepted
---

# Revisão de segurança adicional antes do merge: achados, correções e riscos aceitos

## Contexto

Antes de mesclar os seis PRs de revisão na `main`, foi feita uma camada extra de segurança: duas leituras independentes e somente de leitura do código e do SQL (uma da superfície offline, outra do núcleo de autenticação e multi-tenant), mais verificações mecânicas (segredos na árvore e em todo o histórico, auditoria de dependências, RLS e papéis no banco real, conteúdo do bundle de produção). Cada achado foi conferido no código antes de ser aceito; um deles (laboratórios com segredo fixo no bundle de produção) foi descartado por não se confirmar.

Sem achados críticos ou altos. O que foi encontrado e confirmado está corrigido neste mesmo conjunto, com teste que falha sem a correção.

## Corrigido

- **Redefinição de senha podia deixar as sessões vivas** (médio). O Better Auth chama `onPasswordReset` e só depois revoga as sessões; se a troca de época dos leases falhasse (erro de banco, espera no lock), a exceção pulava a revogação, com a senha já trocada e o token consumido. Agora a falha é registrada e nunca escapa do gancho: as sessões são sempre revogadas (e são elas que autorizam um sync, então os leases ficam inúteis de qualquer forma). Teste novo: falha na troca de época e ainda assim todas as sessões revogadas.
- **A CSP de produção quebrava o armazenamento offline** (confirmado em navegador real). O SQLite compilado para WebAssembly precisa de `'wasm-unsafe-eval'` em `script-src` e, como a biblioteca embute o módulo como URL `data:`, de `data:` em `connect-src`. Nenhum dos dois reabre JavaScript eval (`'unsafe-eval'` continua proibido, e o teste agora confere o token exato) nem permite rede. Os laboratórios e os servidores de teste não enviavam CSP, por isso nada tinha pego isso. Novo cenário de navegador (`e2e/offline-csp.e2e.ts`) abre o armazenamento sob a CSP exata de `public/_headers`.
- **Um usuário herdava o aparelho, o lease e os dados do anterior no mesmo navegador** (médio), quando a sessão do anterior acabava sem sair. O runtime agora pergunta ao servidor, a cada início com rede, se o aparelho lembrado é do usuário atual e não foi revogado; se não for, esquece o aparelho e o lease e registra um novo. O namespace do usuário anterior não é aberto nem apagado (o trabalho dele continua intacto no disco). Testes: segundo usuário recebe aparelho, lease e namespace próprios.
- **O rótulo do aparelho era um User-Agent** (mais de 80 caracteres, recusado pelo servidor, e dado pessoal). Agora o app não envia rótulo, e o runtime limita qualquer rótulo a 80 caracteres sem caracteres de controle.
- **O bootstrap de variantes podia truncar em silêncio.** Com 200 produtos por leitura e até 50 variantes por produto, a leitura de 2.000 linhas ficava curta sem próxima página, e o aparelho acreditava estar completo. O servidor agora recusa mais de 40 produtos por leitura de variantes e o cliente lê em lotes de 40 (testes no cliente e no gate de banco).
- **Sair não apagava as outras organizações do navegador.** O runtime guarda um registro dos namespaces abertos e o fluxo de saída cobre todos: os que não estão abertos são inspecionados, trabalho na fila de outra organização bloqueia a saída (a pessoa precisa trocar para ela e enviar) e, ao sair, os dados, os leases e o registro de todos são apagados.
- **Carga útil sem limite no servidor.** O `sync.push` agora recusa, antes de interpretar, calcular o hash ou gravar, uma carga maior que 256 KB (o mesmo limite do outbox no aparelho).

## Riscos aceitos, com a razão

- **Janela de criação do comando contra o relógio do aparelho** (baixo). Um aparelho com lease vencido e não revogado ainda sincroniza comandos antigos, datando-os dentro da janela. As verificações de sessão, papel, aparelho e época continuam valendo; o ponto só importa quando existir cobrança (`isEntitled` ainda é só um ponto de extensão), e deve ganhar um teto de atraso nessa hora.
- **Recusas de pré-verificação gravadas como definitivas** (`lease_invalid`, `unsupported_command_type`) (baixo, operacional). Rotacionar `OFFLINE_LEASE_SECRET` sem manter o anterior, ou publicar uma versão sem um manipulador, rejeitaria em definitivo comandos legítimos já na fila. Regra de operação (já no checklist de go-live): nunca rotacionar sem `OFFLINE_LEASE_PREVIOUS_*` e nunca retirar um tipo de comando; a ordem de publicação é servidor primeiro.
- **Troca de senha (não redefinição) não troca a época dos leases nem revoga as outras sessões por conta própria** (baixo). A troca autenticada de senha só existe com e-mail e senha ligados, e isso está desligado e sem tela de entrada; fica para o PR que ligar a entrada por senha.
- **Amplificação do `sync.push`** (baixo). Cada comando abre sua própria transação de tenant e o limite de requisições conta o lote como uma. O lote é limitado a 50 (20 no cliente) e a carga a 256 KB; ponderar o limite pelo tamanho do lote fica para quando houver telemetria de uso. Também sem retenção da tabela `sync_commands` (já no backlog).
- **Pré-cadastro com e-mail de terceiro** (baixo) e **tabela de PoC `rls_poc_operations` com política para PUBLIC** (higiene): ambos só têm efeito com e-mail e senha ligados ou com SQL arbitrário; a tabela entra no checklist de go-live para ser removida junto das demais PoCs.
- **Sem tela de revogação de aparelho** (resolvido depois: ver o [ADR 0048](0048-tela-de-aparelhos.md)) e uma janela teórica entre a validação da época e uma troca concorrente: registrados, sem correção agora.

## Verificação feita

Nenhum segredo, chave ou connection string com credencial na árvore nem em todo o histórico do branch (somente as credenciais locais de desenvolvimento do `wrangler.jsonc`). Os dois avisos de severidade alta do `bun audit` são dependências transitivas de ferramentas de desenvolvimento (`braces` via ultracite e `sharp` via miniflare/wrangler). No banco real: todas as tabelas de tenant com RLS forçada; as tabelas de autenticação e a de PoC sem nenhum acesso do papel de tenant; o papel de tenant sem TRUNCATE, REFERENCES ou TRIGGER; nenhum papel da aplicação superusuário, com BYPASSRLS ou membro de `neon_superuser`; todas as funções SECURITY DEFINER com `search_path` fixo e sem EXECUTE para PUBLIC. O bundle de produção não contém laboratórios, ganchos de teste, mapas de código nem a chave do runtime.

## Alternativas rejeitadas

- **Adicionar `'unsafe-eval'` à CSP:** abriria eval de JavaScript; `'wasm-unsafe-eval'` cobre só o WebAssembly.
- **Apagar o namespace do usuário anterior ao detectar outro usuário:** destruiria trabalho não enviado que pertence a quem ainda pode voltar.
- **Deixar a falha da troca de época derrubar a redefinição de senha:** a pessoa ficaria com a senha trocada e sessões antigas vivas.
