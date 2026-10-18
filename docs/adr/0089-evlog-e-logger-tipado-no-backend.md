---
status: accepted
---

# evlog e um logger tipado no backend

> O número deste ADR (0089) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0088 é do PR113); pode mudar se outro entrar antes.

## Contexto

O backend registra diagnóstico com `console.*` espalhado pelos Workers, sempre com campos escolhidos à mão (o ADR 0086 definiu as linhas `scheduled_job_run` e `scheduled_job_skipped` e deixou "o evlog (PR114) pode ficar por cima"). O plano da Fase 12 manda adicionar o evlog como API de logging do backend e criar um *wrapper* tipado, antes de os eventos largos canônicos (PR115), da redação centralizada (PR116) e do tracing (PR117) precisarem de um ponto único onde ligar.

## Decisão

- **evlog é a API; o Cloudflare Observability continua sendo o destino.** O evlog (licença MIT, sem dependências obrigatórias; os adaptadores de framework são *peer* opcionais) só entrega a ergonomia e o formato. A saída segue sendo o `console` do Worker, que o Workers Logs indexa como JSON (`observability.enabled` no `wrangler.jsonc`). Nenhum *drain* para serviço externo é ligado, nenhuma conta é criada e nada é pago.
- **Um pacote, `@polaris/observability`.** Exporta `@polaris/observability/logger`: `logger.debug|info|warn|error(evento, campos)` e `configureLogging({ service })`. O evento é o nome estável (`scheduled_job_run`), os campos são valores simples, listas e objetos de valores simples (nunca `undefined`, que o wrapper descarta), e as chaves do próprio evlog (`event`, `level`, `service`, `timestamp`, `environment`, `version`, `commitHash`, `region`) são do logger: o tipo as recusa e a execução as ignora. Só este pacote importa o `evlog`; os Workers importam o wrapper.
- **Configuração fixa por ora.** `pretty` e `stringify` desligados (um objeto por chamada, com o nome no campo `event` e `level`, `service` e `timestamp` a mais) e `redact` ligado de forma explícita, para a máscara embutida do evlog (e-mail, cartão, IP, telefone, chaves com cara de segredo) valer em qualquer ambiente, não só quando o `NODE_ENV` for `production`: é rede de segurança, e a política própria é do PR116. O que mantém dado pessoal fora do evento continua sendo a lista de campos permitidos de cada ponto de chamada, como antes ([server-log](../../apps/web/src/server/observability/server-log.ts)). Cada Worker chama `configureLogging` uma vez no topo (`polaris-web`, `polaris-admin`).
- **Fronteira: o domínio não importa evlog nem o wrapper.** A regra `noRestrictedImports` do Biome para `packages/domain/**` passa a cobrir `evlog`, `evlog/**`, `@polaris/observability` (e subcaminhos) e caminhos relativos para o pacote, em qualquer profundidade; o código do navegador (`apps/web/src` fora de `server/`) também as recusa, porque a V1 não tem *client logging*. O `bun run boundaries` ganha fixtures de import proibido para as duas áreas e falha se a regra deixar passar.
- **O que migrou.** Os pontos de infraestrutura mais óbvios, sem mudar o que é registrado: `server-log` (erro e evento do servidor), o agendador (`scheduled_job_*`, `scheduler_state_unavailable`), o ponto de entrada do Worker web (crons e fila) e o relatório do Admin. O resto dos `console.*` do backend (consumidor e despachante das filas, DLQ, reconciliador de mídia, billing, auth, o `packages/db` e o catalog) migra aos poucos, no PR que tocar cada um.
- **Não é auditoria.** O audit-log do evlog não é usado como trilha oficial: a auditoria autoritativa continua no PostgreSQL (plano, seção 87).

## Consequências

- Os PRs 115 a 117 evoluem o wrapper (esquema de campos, redação, tracing) sem tocar nos pontos de chamada.
- **O formato muda para parte dos pontos migrados.** `server-log` e o relatório do Admin já emitiam um objeto com `event` e seguem iguais. O agendador e a entrada do Worker web emitiam `console.info("nome", campos)` (o nome como mensagem de texto) e agora emitem um objeto com o nome em `event`. Alerta, filtro ou busca que dependa do texto da mensagem (por exemplo, o alerta sobre `scheduled_job_claim_failed` exigido antes do passo 7 das filas) deve filtrar pelo campo `event`.
- Os testes que olhavam `console.warn("nome", campos)` passam a olhar `expect.objectContaining({ event: "nome", ...campos })`: o objeto emitido tem as chaves do evlog a mais.
- Um objeto de log novo com tipo `interface` precisa ser espalhado (`{ ...relatorio }`) para caber no tipo dos campos; é intencional, para o campo ser visto no ponto de chamada.

## Limites aceitos

- A máscara do evlog é genérica e não conhece os dados do Polaris: o risco de um campo novo trazer dado pessoal continua sendo da revisão (os relatórios espalhados com `{ ...relatorio }` hoje só têm contagens; um campo novo neles passa a ser logado), até a política do PR116.
- O campo `environment` do evento vem do `NODE_ENV` do bundle (evlog); não foi confirmado em nuvem e pode sair `development`. O PR117 o fixa.
- `packages/contracts` não tem regra própria contra o logger: não há motivo para importá-lo ali, e a regra do domínio é a que o plano exige.
- Não há medida de CPU nem de custo do evlog no Worker em nuvem; o `wrangler tail` e o Workers Logs ficam para a validação do PR117.
