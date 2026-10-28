---
name: maintain-verify-polaris
description: "Passada periódica que mantém honestos a skill verify-polaris e o mapa de telas dela (.claude/skills/verify-polaris/features/): um leitor de código por destino em paralelo, uma sessão ao vivo que dirige todos os destinos, e no máximo um PR de correções provadas. Use para \"auditar a verify-polaris\", no dreaming semanal, ou quando uma tarefa achou o mapa desatualizado."
---

# maintain-verify-polaris

O mapa de telas apodrece no momento em que o app muda. Esta skill é o ciclo de manutenção da [verify-polaris](../verify-polaris/SKILL.md). A unidade de rigor é o destino (um arquivo de `features/`), não cada frase: todo arquivo do mapa ganha leitura do código e todo destino é dirigido ao vivo, sem transformar cada linha em comando.

O teste `apps/web/scripts/verify-feature-map.test.ts` já reprova rota, aba ou endereço sem mapa a cada PR. Esta passada pega o resto: seletor que mudou de nome, receita que não chega mais ao estado, Gotcha que deixou de valer, tela nova sem receita.

## Resultados

Escolha um e diga qual:

- **limpo**: todo destino teve leitura do código e passada ao vivo; nada vale um PR. Sem branch, sem PR.
- **mudou**: um PR com correções provadas do mapa, dos drives ou dos scripts da skill.
- **bloqueado**: a cobertura não terminou ou uma correção provada não pôde ir com segurança. Diga exatamente o que bloqueou.

## Escopo de edição

Só a pasta da skill de verificação (`.claude/skills/verify-polaris/`: `SKILL.md`, `features/`, `drives/`, `drive/`, `scripts/`, `playwright.verify.config.ts`) e, quando a mudança é de rota mapeada, o teste `apps/web/scripts/verify-feature-map.test.ts`. Nunca mexa em código do produto numa passada: um comportamento que o mapa descreve e o app não faz mais é deriva do mapa (corrija o mapa) ou regressão do produto (relate, não esconda no texto).

## Passada

0. **Alvo.** A skill é `.claude/skills/verify-polaris/`. Se ela não existir, pare e aponte para a criação dela, em vez de inventar um alvo.

1. **Higiene do índice.** Leia `features/README.md` e liste os arquivos irmãos. Corrija entrada faltando, sobrando, duplicada ou morta. É leve: nada de inventário gerado.

2. **Onda de leitura.** Um subagente só de leitura por arquivo de `features/`, todos lançados juntos (tipo `explorer`). Cada um explica, a partir do código (`apps/web/src/`, e os specs em `apps/web/e2e/`, `apps/web/e2e-pwa/` e `apps/web/e2e-real/`), como o destino funciona para a pessoa, aponta deriva provável com arquivo e linha, e devolve uma receita de verificação ao vivo. Os subagentes nunca dirigem o app nem editam arquivo. Formato da volta: resumo do destino / pontos de entrada no código / deriva provável ou nenhuma / uma receita.

3. **Reconciliar.** Todo arquivo do mapa tem um resumo de volta. Junte as receitas que se sobrepõem no menor número de estados (loja `vazia`, `vendas`, `limite`; build com ou sem `--runtime` e `--assinatura`). Confira por amostra a deriva citada; não reprove de novo o que veio limpo. Varra a mudança recente (`git log --since` em `apps/web/src/`) atrás de tela, Dialog ou aba que falta no mapa; exija um caminho concreto no código antes de chamar algo de faltante.

4. **Passada ao vivo.** Obrigatória mesmo com o código limpo. Só você (o coordenador) dirige, pelo modelo de launch da skill: uma instância de longa duração (`verify.sh launch`), dirigida em série. Exercite cada destino ao menos uma vez e mantenha três invariantes a passada inteira, qualquer que seja a falha:
   1. nunca dirija uma instância sem `verify.sh doctor` desde a última surpresa: doctor antes do primeiro drive e de novo depois de qualquer drive que falhou; quando o doctor não enxerga a falha (tela travada num processo saudável), volte a um estado conhecido (`cleanup` + `launch`) em vez de torcer;
   2. a evidência juntada até ali sobrevive a todo cleanup, conferida em `~/tasks/<id>-telas/` (`verify.sh evidence`), não suposta;
   3. nada que um drive iniciou dura mais que a utilidade dele: resíduo de tentativa que falhou se limpa (`verify.sh cleanup`), esteja a instância travada, morta ou viva.

   Um doctor que reprova por deriva da skill é deriva: corrija dentro do escopo e tente uma vez de novo (reinicie só o que a correção invalidou) antes de chamar a passada de bloqueada. Um destino que não se alcança só é `verificado-inalcançável` com a condição concreta (Assinatura sem `--assinatura`, Pendências sem registro recusado, Senha atrás da flag, Google e cobrança sem provedor) e o endereço tentado; se o mapa não cita essa condição, isso é deriva. Toda correção de harness vinda da triagem é dirigida ao vivo de novo antes de ir. O cleanup final vem depois do último drive da passada, inclusive dessas reprovas, para nada sobrar do run (a evidência fica, como a skill diz).

5. **Triagem.** Descrição errada ou faltando do ponto de vista da pessoa → deriva do mapa, corrija. Comportamento que funciona e o harness não consegue dirigir → lacuna do harness, corrija; a correção segue a regra dos helpers (script executável, invocação escrita no `SKILL.md`). Comportamento do app que está quebrado de fato → lacuna do produto; registre para o Arrascaeta e deixe fora deste PR.

6. **Entregar ou parar.** Para **mudou**: um PR só, de correções provadas, seguindo o `AGENTS.md` (branch `chore/`, revisão do diff pelo `reviewer` antes do push, `bun run check`, a tabela critério → onde está → prova, capturas da passada listadas, nunca commitadas). Releia cada arquivo mudado antes. Para **limpo** ou **bloqueado**: sem PR; relate o resultado e a cobertura com honestidade.

Guarde notas curtas da passada (destinos cobertos, condições inalcançáveis, deriva confirmada, resultado) num lugar de rascunho, como `~/tasks/<id>-notas.md`; não as commite.

## Origem

Adaptada de `pstack-maintain-verification-skill` (pstack, de Lauren Tan, licença MIT; ver `LICENSE` e `NOTICE.md` nesta pasta). Mudanças: o alvo é a `verify-polaris` em `.claude/skills/` (não `.cursor/skills/`), os subagentes são os do Claude Code, o escopo inclui o teste do mapa, a entrega segue o `AGENTS.md` do Polaris, e a seção "pstack in OpenBot" saiu.
