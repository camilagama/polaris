# Gate 3 — catálogo, estoque e mídia privada (Fase 3)

Gatilho: fechamento da Fase 3 (PR24–PR35) e qualquer mudança posterior em catálogo, estoque, custo médio, variantes ou mídia. O plano pede que o Gate 3 prove: nenhum estoque negativo, razão consistente, custo médio correto, variantes corretas e mídia privada.

Este gate não existia como entrega formal: as provas estavam espalhadas pelos gates por PR. Ele passa a ser o conjunto nomeado `gate3` do executor de gates, com o mapa propriedade → evidência abaixo. Alvo, pré-requisitos e passos são os do [Gate 4](./gate-4-sales-core.md) (branch Neon descartável filha de `production` na prova de liberação, URL só no ambiente do processo, gates em sequência no mesmo banco; ver a seção [Prova antes de liberação em Neon](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon)); o comando é:

    bun run --filter @polaris/db gates:gate3

O conjunto roda `gate2-runtime` (catálogo sob RLS com sessão, organização e capabilities reais), `inventory` (razão, saldo, custo médio, recebimento, baixa, contagem, arquivar/excluir), `media-schema` e `media-upload` (mídia por organização) e `review-hardening` (razão × saldo, sequência do razão, chave de mídia, limites).

## O que prova cada propriedade

| Propriedade | Evidência |
| --- | --- |
| Nenhum estoque negativo | `inventory`: saldo ≥ 0 por restrição e por comando, baixa e venda acima do saldo falham sem efeito, corridas sob o lock do saldo. |
| Razão consistente | `inventory`: razão só de acréscimo (gatilho e grants), idempotência por `commandId`. `review-hardening`: o saldo é recomputado no commit (`quantidade = soma dos movimentos`, gatilhos deferidos), toda escrita direta do saldo sem movimento é recusada, e cada variante tem sequência 1…n sem lacunas nem repetições mesmo sob escritores concorrentes. |
| Custo médio correto | `inventory`: média móvel exata em 6 casas, meio-para-cima, custo desconhecido nunca vira zero, saldo vazio. Testes de propriedade em `packages/domain/src/inventory/inventory-cost.test.ts` (fast-check). |
| Variantes corretas | `gate2-runtime` e `inventory`: variante padrão, configuração única, troca atômica da variante padrão, SKU único sem distinção de caixa (`review-hardening` confirma que `lower()` dobra letras não ASCII). |
| Mídia privada | `media-schema` e `media-upload`: isolamento por organização sob FORCE RLS, ativos só de acréscimo, uma chave de armazenamento por tentativa. `review-hardening`: a chave de armazenamento precisa ser a chave v2 da própria organização, comando e impressão digital, então um ativo não aponta para o objeto de outro tenant. |

## Limites conhecidos

- **Mídia privada ponta a ponta** (rota Worker + banco real + R2 real) não é provada por um gate repetível: o isolamento no banco é provado aqui, a autorização das rotas por testes de unidade com armazenamento simulado, e o caminho Cloudflare Images/R2 real foi exercitado manualmente nos PR34 e PR35 com Worker temporário. A orientação EXIF e a remoção de metadados do upload não têm prova no provedor real.
- `inventory` e `media-upload` estão na suíte `ci` e rodam no CI e no PostgreSQL 18 local. Só o `gate2-runtime` exige um endpoint Neon: roda na prova de liberação e no fim da fase, em Neon descartável ([Gate 4](./gate-4-sales-core.md#o-que-só-roda-em-neon)).
- O gate `media-derivatives` (reconciliação com papéis de limpeza) fica fora do conjunto por exigir três URLs com logins próprios; segue como gate avulso.

## Rollback ou forward-fix

Igual ao Gate 4: nada persistente é alterado; se um gate falhar, corrija na etapa dona do mecanismo e repita o gate falho e os anteriores.