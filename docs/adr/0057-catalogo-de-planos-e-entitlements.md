---
status: accepted
---

# Catálogo de planos, entitlements e estado de assinatura

## Contexto

A Fase 7 (PR72, PR73 e PR76) cria a base de billing sem integrar nenhum provedor: um catálogo de planos Free/Pro, a regra que transforma plano, assinatura, trial e concessões temporárias no que uma organização pode fazer agora, e a máquina de estados da assinatura. As regras de negócio ([billing-and-entitlements](../business-rules/billing-and-entitlements.md)) já fixam os princípios: o provedor reporta fatos, o Polaris deriva o estado e os entitlements, e o downgrade preserva dados.

## Decisão

- **Catálogo em dados, não em código.** `billing_plans`, `billing_prices` e `plan_entitlements` são dados de referência globais (iguais para toda organização). Preços e quotas mudam por migration (uma ferramenta administrativa fica para quando houver a área de Admin), sem deploy do app. O papel de runtime só lê; as tabelas têm `FORCE ROW LEVEL SECURITY` com uma política de leitura aberta e nenhum privilégio de escrita. A semente (Free: 50 variantes, 1 imagem por produto, 50 imagens, 1 meta ativa, sem escrita offline nem catálogo público; Pro: 2.000, 10, 5.000, 3, ambos ligados; preços R$ 24,90, R$ 124,50 e R$ 249,00 para 1, 6 e 12 meses) é a hipótese comercial de PRODUCT.md. `INITIAL_PLAN_CATALOG` no domínio é a mesma hipótese como constante de teste, e o gate compara a semente com ela para que não divirjam em silêncio.
- **Chaves fechadas por constraint.** Um entitlement é uma chave conhecida com exatamente um valor do tipo certo (limite inteiro ≥ 0 ou sim/não); uma chave nova exige migration e código, de propósito. O catálogo lido do banco só vale completo (todo plano com toda chave e valor do tipo certo): uma linha faltando faria o limite desaparecer, então o servidor falha fechado em vez de conceder mais.
- **Estado de billing por organização, sem linha = Free.** `organization_billing` guarda `state` (`free`, `trial_setup`, `trialing`, `active`, `grace`, `free_over_limit`), `access_ends_at`, `trial_started_at` (o trial é oferecido uma vez; um registro `trialing` sempre diz quando começou) e `version`. Uma constraint impede o estado incoerente: acesso Pro sempre tem fim; estado gratuito nunca tem. O runtime só lê; as mudanças de estado chegam com o ciclo de vida do billing (fase seguinte), por comandos nomeados, nunca pelo caminho de requisição do tenant.
- **O plano em vigor depende do relógio do banco, não da varredura.** Um trial, período ou carência cujo fim passou conta como Free mesmo que o registro ainda não tenha sido atualizado; o que o registro diz é preservado, mas não concede acesso. Pro só vale com `access_ends_at` no futuro.
- **Concessões temporárias só elevam.** `entitlement_grants` (suporte, promoção) tem sempre prazo e motivo, e uma concessão nunca reduz um limite nem desliga uma flag; vence o maior limite. O papel de runtime não escreve concessões: uma organização não concede a si mesma.
- **A máquina de estados é pura e independente de provedor.** Eventos já validados e deduplicados (`start_trial`, `renewal_ready`, `payment_succeeded`, `payment_failed`, `grace_expired`, `period_ended` e outros) movem o estado por uma tabela de transições; um evento que não se aplica ao estado atual é recusado, não ignorado. A máquina também defende o acesso de fatos velhos, adiantados ou malformados: o fim de um período pago precisa ser uma data real no futuro, em até cerca de um ano, e um pagamento antigo ou repetido nunca recua o fim do acesso; uma falha de pagamento nunca encurta o período já pago (a carência começa no fim dele); os eventos que encerram o acesso (`trial_ended_without_payment`, `period_ended`, `grace_expired`) só valem depois do fim do acesso que encerram; e um trial já consumido não recomeça. O trial (7 dias) começa por escolha e só avança com o método de renovação pronto; a carência é de 7 dias. Sair do Pro cai em `free`, ou em `free_over_limit` quando a organização tem mais do que o Free permite (os dados ficam; só novas operações são restringidas). Propriedades testadas sobre sequências aleatórias: o registro permanece coerente, Pro só começa por método de renovação ou pagamento, e `free_over_limit` só se entra ou sai conforme o uso.
- **Leitura:** a organização ativa do pedido consulta seus entitlements efetivos (`getEffectiveEntitlements`, sem capability própria: a leitura é escopada pela organização e pela membership via RLS; o relógio é o do banco e a ausência dele é erro); a aplicação nos comandos (cotas do PR74 e PR75) é no servidor, não só na interface, e é o próximo passo.

## Consequências

- Mudar preço ou quota é uma migration, não um deploy; o gate protege a semente.
- O servidor, e não um webhook, decide o acesso; um provedor ainda por integrar não muda nada neste modelo.
- Quem registrar o trial (ciclo de vida, PR81) preenche `trial_started_at` e passa `trialConsumed` à máquina; até lá nenhum comando muda o estado.
- Sem job de varredura nesta etapa: o fim do acesso é aplicado na leitura. O ciclo de vida (PR81) atualizará o registro e o estado `free_over_limit`.

## Alternativas rejeitadas

- **Quotas como constantes no código:** exigiriam deploy para ajustar a hipótese comercial.
- **Confiar no campo de estado sem conferir o fim do acesso:** um trial vencido continuaria concedendo Pro até a próxima varredura.
- **Deixar o runtime escrever o estado de billing:** o acesso pago passaria a depender de um endpoint do próprio tenant.
- **Duas linhas de preço ativas por intervalo:** o índice único parcial impede.
- **Concessão que também reduz:** um engano de suporte poderia tirar de uma organização o que o plano lhe dá.
