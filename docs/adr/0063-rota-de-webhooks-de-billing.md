---
status: accepted
---

# Rota de webhooks de billing, porta de adaptador e manutenção horária

## Contexto

O ADR 0062 deu ao billing um caminho de escrita (o papel `polaris_billing_runtime`), uma caixa de entrada de eventos e a reconciliação de fatos. Faltava como os fatos chegam: uma rota onde os provedores entregam webhooks (PR79), a interface que cada provedor implementa (PR77 e PR78) e quem aplica o que o tempo causa e reprocessa o que falhou (PR81). O ADR de segurança de origem (`originCheckMiddleware`) já previa que webhooks ficam fora de `/api` e `/rpc` e se autenticam por assinatura.

## Decisão

- **Rota `POST /webhooks/billing/:provider`, fora de `/api` e `/rpc`.** Esses caminhos protegem contra requisições entre sites de navegadores; um provedor não é um navegador e não manda `Origin`. A rota se protege pela assinatura ou pelo token que o adaptador do provedor verifica. O nome do provedor segue `^[a-z][a-z0-9_]{1,31}$`; um nome sem adaptador (ou inválido) é 404.
- **Porta de adaptador pequena e sem acesso a banco.** Um adaptador implementa `parse({ bindings, headers, rawBody })`: verifica a autenticidade primeiro (`WebhookRejectedError`) e depois reduz o payload a eventos (`providerEventId`, `providerRef` e um dos cinco fatos do domínio); um payload de outro tipo devolve lista vazia. O corpo chega exatamente como recebido, porque uma assinatura se calcula sobre esses bytes. Nenhum dado pessoal sai do adaptador. O registro de provedores (`billingProviderAdapters`) começa **vazio**: PR77 (Asaas) e PR78 (Woovi) acrescentam o seu, e isso é tudo o que precisam mudar.
- **O mínimo durável e responder.** A rota guarda cada evento uma vez (a redundância do provedor vira linha repetida, não efeito repetido) e responde 200 com a contagem; o processamento roda depois da resposta (`waitUntil`) e a conexão só é fechada quando ele termina. O processamento recebe também os eventos reentregues, na ordem: aplicar um evento já aplicado não faz nada, e um evento guardado por uma entrega anterior que nunca foi aplicado (o isolate morreu, ou um evento seguinte não pôde ser guardado) é aplicado agora em vez de esperar a manutenção horária. Um evento que não pôde ser guardado responde **503** (o provedor reenvia tudo); um evento guardado cujo processamento falhou fica marcado como falho e é retomado pela manutenção.
- **Só se recusa o que não é do provedor ou não cabe.** Uma assinatura inválida responde 401 sem dizer por quê; um provedor sem adaptador, 404; um corpo acima de 64 KiB, 413, contado em bytes enquanto o fluxo é lido e abandonado no limite (uma entrega em partes, sem tamanho declarado, custa o mesmo que uma com tamanho declarado). Uma entrega **autêntica** que o ciclo de vida não consegue usar (payload ilegível, ou mais de 50 eventos, que não é uma notificação de provedor) responde **200** e registra `billing_webhook_malformed` ou `billing_webhook_too_many_events` para alguém olhar: reenviar mandaria os mesmos bytes e provedores pausam o webhook que recebe erros em sequência. Uma falha inesperada do adaptador responde 503. O adaptador recebe o corpo decodificado sem perder a marca de ordem de bytes.
- **Binding próprio.** `BILLING_HYPERDRIVE` aponta para o login do papel de billing, nunca para o do tenant, o do dono ou o da limpeza de mídia; sem ele a rota responde 503 e o cron registra que billing não está provisionado e segue.
- **Manutenção horária no cron que já existe.** `runBillingMaintenance` primeiro reprocessa os eventos recebidos e não aplicados (com espera crescente nos que falharam) e só depois varre o acesso vencido: uma renovação já confirmada precisa estar no registro antes de a varredura ler o fim do período. Cada parte roda mesmo que a outra lance uma exceção; falhas são registradas pelo repositório e a execução termina com erro para o cron mostrar. O cron roda mídia e billing como trabalhos independentes: uma exceção em qualquer ponto de um (inclusive abrir ou fechar a conexão, que é feito sem substituir o que o trabalho encontrou) nunca esconde o outro, e se os dois falharem os dois erros são relançados.

## Consequências

- Acrescentar um provedor é escrever um adaptador testável com payloads de exemplo e listá-lo; reconciliação, deduplicação, ordem e carência não mudam.
- Com o registro vazio a rota não aceita nenhum webhook: até os adaptadores existirem (e serem provados em sandbox, Gate 7) o comportamento do produto não muda.
- A rota não tem limite de taxa próprio; um corpo falso custa uma leitura limitada a 64 KiB e uma verificação de assinatura. Um limite por IP ou por provedor pode ser acrescentado com o namespace de rate limit do go-live se o abuso aparecer.
- O segredo de cada provedor (token ou chave de assinatura) é um segredo do Worker lido pelo adaptador de `bindings`; o nome e o procedimento de rotação entram com cada adaptador.

## Alternativas rejeitadas

- **Processar o evento antes de responder:** um processamento lento ou uma indisponibilidade do banco faria o provedor esgotar o tempo e reenviar; guardar e responder é o que torna o reenvio seguro.
- **Montar a rota em `/api`:** exigiria isentar o webhook da checagem de origem, enfraquecendo a defesa que vale para todo o resto do caminho.
- **Um endpoint genérico que aceita qualquer provedor sem adaptador registrado:** aceitaria eventos sem verificação de autenticidade.
- **Guardar o corpo bruto para reprocessar depois:** traria dados pessoais do provedor para um registro de longa retenção; o fato normalizado basta.
