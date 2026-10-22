---
status: accepted
---

# Funções SECURITY DEFINER e privilégios padrão do banco

> O número deste ADR (0093) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0092 é o do registro de acesso, já na `main`); pode mudar se outro entrar antes

## Contexto

Uma função `SECURITY DEFINER` roda com os direitos do dono. Se o `search_path` dela não termina em `pg_temp`, quem consegue rodar SQL num papel de runtime e criar um objeto temporário pode fazer a função resolver o nome dele no lugar do objeto real e agir como o dono (achado A2 da revisão de segurança). A escalada não foi provada em banco; o custo da correção é baixo e a regra passa a valer para toda função nova.

## Decisão

- **`search_path` termina em `pg_temp`.** Toda função `SECURITY DEFINER` fixa `search_path = pg_catalog, public, pg_temp` (ou outra lista que termine em `pg_temp`). A migration 0077 alterou as 84 funções que ainda não tinham (as três que já tinham ficam como estão), com um `ALTER FUNCTION` explícito por função (o único SQL dinâmico é o nome do banco no `REVOKE TEMPORARY`); o comportamento das funções não muda.
- **Sem `TEMPORARY` e sem `CREATE` por PUBLIC.** A migration 0077 revoga `TEMPORARY` no banco e `CREATE` no schema `public` de `PUBLIC`. Os papéis dono criam funções por `SET ROLE` nas migrations e não são papéis de runtime; nenhum papel de runtime precisa de `CREATE` (a concessão de `CREATE` a `polaris_media_cleanup_owner` da migration 0026 e as demais dos papéis dono não existem mais no estado final das migrations, conferido no banco; o gate cobre os papéis de runtime).
- **`EXECUTE` só a quem chama.** Nenhuma função `SECURITY DEFINER` é executável por `PUBLIC`; o `GRANT EXECUTE` é explícito, por papel, na migration que cria a função. A 0077 repete o `REVOKE ... FROM PUBLIC` em cada uma como defesa (no banco do CI já estava feito).
- **A 0077 confere o resultado.** `REVOKE` sem privilégio para revogar só emite `WARNING` (num migrador que não é dono, como no Neon, e onde o gate não roda, a migration passaria sem ninguém perceber). Por isso o fim da 0077 tem um bloco `DO` que consulta `has_database_privilege('public', current_database(), 'TEMPORARY')` e `has_schema_privilege('public', 'public', 'CREATE')` e lança erro se algum continuar concedido a `PUBLIC`.
- **Gate `definer-hardening`** (em `gates:ci`) reprova: função `SECURITY DEFINER` sem `search_path` terminado em `pg_temp`; papel de runtime (`polaris_*_runtime`, quem é membro desses grupos, e os logins dos gates; a única aresta que não conta é a só `ADMIN OPTION` do dono do banco, que o PostgreSQL 16+ dá a quem cria os papéis e que o dono já tem o poder de dar a si) com `TEMPORARY` no banco ou `CREATE` em `public`, ou que alcance por `SET ROLE` um papel com um desses privilégios; login de runtime que seja o dono do banco (`datdba`), superusuário ou tenha `CREATEROLE`, `REPLICATION` ou `BYPASSRLS`; login de runtime que alcance (por `SET`, `INHERIT` ou `ADMIN OPTION`, direto, por grupo ou por cadeia mista) o dono do banco, `neon_superuser` (quando existir), qualquer papel com `SUPERUSER`, `BYPASSRLS` ou `CREATEROLE`, qualquer papel `*_owner` ou qualquer papel predefinido `pg_*` (só o `pg_database_owner` fica de fora, por ser implícito); `ADMIN OPTION` conta como alcance em todas as checagens, porque quem o tem concede `SET` e `INHERIT` a si mesmo, e o conjunto alcançável (que recebe os seis atributos e os direitos de `TEMPORARY` e `CREATE`) inclui os papéis em que o runtime, ou o que ele herda, tem `ADMIN OPTION`; nenhum `polaris_*_owner` é membro de outro papel (`INHERIT`, `SET` ou `ADMIN OPTION`), nem de outro owner, ainda que nenhum runtime o alcance; função `SECURITY DEFINER` com `EXECUTE` para `PUBLIC`. O gate também prova que sabe falhar, com uma função de teste, concessões e papéis descartáveis que ele desfaz (inclusive trocando o dono do banco descartável e devolvendo).
- **Fora do escopo: funções não-`SECURITY DEFINER` sem `pg_temp`.** Há 42 funções que não são `SECURITY DEFINER` e não fixam `search_path` com `pg_temp`. Elas rodam com os direitos de quem chama, então não escalam privilégio; ficam de fora como defesa em profundidade de baixa severidade e entram se alguma passar a ser `SECURITY DEFINER`.

## Consequências

- Função nova com `SECURITY DEFINER` precisa nascer com `SET search_path = pg_catalog, public, pg_temp` e sem `EXECUTE` para `PUBLIC`, ou o `gates:ci` falha.
- Um PR aberto que crie função `SECURITY DEFINER` sem `pg_temp` vai reprovar o gate `definer-hardening` depois que este ADR e a 0077 entrarem na `main`. Para corrigir, ao atualizar a branch: na migration que cria a função, acrescentar `SET search_path = pg_catalog, public, pg_temp` à definição (ou um `ALTER FUNCTION ... SET search_path = pg_catalog, public, pg_temp` logo depois) e `REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC` seguido do `GRANT EXECUTE` ao papel que chama; renumerar a migration se o número já tiver sido usado.
- Quem precisar de tabela temporária num papel de runtime precisa de decisão explícita (ADR), não de um `GRANT` avulso. O `poc.ts` do pacote de banco, que usa `TEMP TABLE`, só roda com o dono de um banco descartável, nunca com papel de runtime.
- Limite conhecido do gate: o conjunto de papéis poderosos é definido por nome e atributo (a lista acima), não derivado do catálogo; um dono de objetos com outro nome, ou outro papel predefinido, não é visto. Quem criar um papel assim precisa incluí-lo no gate.
- O banco de produção recebe a 0077 pela rotina normal de migrations; nada é feito à mão. O migrador tem de ser o dono do banco (`datdba`; no Neon, `neondb_owner`), o que o torna dono do schema `public` por `pg_database_owner`, e todo login do app tem de ser membro de um `polaris_*_runtime`; os dois pontos estão nos itens 3 e 15 do [checklist de release](../runbooks/release-checklist.md), com o que fazer se o bloco `DO` final da 0077 falhar.

## Alternativas consideradas

- **Só `ALTER FUNCTION` sem revogar `TEMPORARY`.** Deixaria o caminho aberto para qualquer função futura.
- **Bloco `DO` que altera toda função encontrada.** Esconderia quais funções mudaram na revisão; a lista explícita sai da consulta ao catálogo e é conferida pelo gate.
