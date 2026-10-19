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
- **Gate `definer-hardening`** (em `gates:ci`) reprova: função `SECURITY DEFINER` sem `search_path` terminado em `pg_temp`; papel de runtime (`polaris_*_runtime`, quem é membro desses grupos e os logins dos gates) com `TEMPORARY` no banco ou `CREATE` em `public`; função `SECURITY DEFINER` com `EXECUTE` para `PUBLIC`. O gate também prova que sabe falhar, com uma função de teste e concessões que ele desfaz.

## Consequências

- Função nova com `SECURITY DEFINER` precisa nascer com `SET search_path = pg_catalog, public, pg_temp` e sem `EXECUTE` para `PUBLIC`, ou o `gates:ci` falha.
- Quem precisar de tabela temporária num papel de runtime precisa de decisão explícita (ADR), não de um `GRANT` avulso.
- O banco de produção recebe a 0077 pela rotina normal de migrations; nada é feito à mão.

## Alternativas consideradas

- **Só `ALTER FUNCTION` sem revogar `TEMPORARY`.** Deixaria o caminho aberto para qualquer função futura.
- **Bloco `DO` que altera toda função encontrada.** Esconderia quais funções mudaram na revisão; a lista explícita sai da consulta ao catálogo e é conferida pelo gate.
