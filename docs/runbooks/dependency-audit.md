# Auditoria de dependências

Procedimento e registro de exceções do job "Dependency audit" do CI, que roda `bun audit --audit-level=high` quando uma dependência muda (e sob demanda). O job é consultivo (`continue-on-error`), mas não deve ter aviso sem destino: cada aviso é corrigido ou entra na tabela de exceções abaixo, com justificativa e prazo.

## Gatilho

- O job falhou no CI, ou alguém mudou `package.json`/`bun.lock`.
- Passou o prazo de revisão de uma exceção.

## Procedimento

1. `bun install --frozen-lockfile`.
2. `bun audit --audit-level=high` e anotar pacote, severidade e caminho (`bun pm why <pacote>` mostra quem depende).
3. Se existe versão corrigida: atualizar a dependência direta; se a dependência transitiva fixa a versão vulnerável com versão exata, usar `overrides` no `package.json` raiz, rodar `bun install` e conferir no `bun.lock` que só mudaram o pacote esperado (e os pacotes que ele traz, como `@img/*` no caso do `sharp`) e o bloco `overrides`. Rodar `bun run check`, `bun run build` e os gates do pacote afetado.
4. Se não existe versão corrigida e o pacote só roda em ferramenta de desenvolvimento ou build (nada no bundle dos Workers nem no navegador; conferir com `bun pm why <pacote>`, que deve mostrar só ancestrais `dev`, e com uma busca de import do pacote em `apps/`, `packages/` e `scripts/`), registrar a exceção na tabela abaixo. Se o pacote chega ao runtime, não há exceção: tratar como bloqueio e escalar ao responsável.
5. Conferir com `bun audit --audit-level=high --ignore=<GHSA>` (repetível) que as exceções documentadas são os únicos avisos restantes.

O `bun audit` não lê arquivo de exceções; o `--ignore` só vale na linha de comando. Por isso o workflow `.github/workflows/ci.yml` passa um `--ignore` para cada exceção vigente da tabela abaixo, com a data de revisão em comentário, e o job volta a ficar vermelho só com aviso novo. Ao remover uma exceção, remover também o `--ignore` correspondente.

## Rollback ou forward-fix

Se um override ou atualização quebrar `bun run build`, `bun run check` ou um gate, reverter o `package.json` e o `bun.lock` do commit e registrar o aviso como exceção (só se for de ferramenta de desenvolvimento) até haver versão compatível. Não há dado nem recurso de produção envolvido.

## Escalonamento

O responsável pelo CI decide passar `--ignore` no workflow, aceitar uma exceção que dure além do prazo e tratar qualquer aviso que chegue ao runtime.

## Exceções vigentes

| Aviso | Pacote | Caminho | Runtime? | Por que não há correção | Revisar até |
| --- | --- | --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high, DoS por esgotamento de pilha com padrões aninhados em excesso, afeta `<=3.0.3`) | `braces@3.0.3` | `ultracite > find-workspaces > fast-glob > micromatch > braces` | Não: só ferramenta de desenvolvimento (`ultracite`, usada por `bun run fix`) | A 3.0.3 é a última versão publicada de `braces`; não há versão corrigida para o `override` ou para `bun audit fix`. | 2026-11-18 |

Justificativa do risco: `braces` só expande os padrões de glob que o `ultracite` monta a partir de arquivos do próprio repositório, na máquina de quem desenvolve; não há entrada de rede ou de usuário, e o pacote não entra em nenhum Worker nem no navegador. O pior efeito é a ferramenta local travar.

Na revisão: rodar `bun pm view braces versions`; reavaliar também o override do `sharp` (tabela seguinte); se houver versão acima da 3.0.3, aplicar o passo 3 e remover a linha da tabela. Se o `ultracite` deixar de depender de `braces`, remover também.

## Overrides vigentes

| Override | Motivo | Remover quando |
| --- | --- | --- |
| `sharp: 0.35.5` | `miniflare` (via `wrangler` e `@cloudflare/vite-plugin`) fixa `sharp@0.35.4`, afetado por [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (falha na dependência `librsvg`, corrigida na 0.35.5). `sharp` só roda no emulador local (`miniflare`), não no Worker implantado. | O `miniflare` instalado depender de `sharp >= 0.35.5`. |
