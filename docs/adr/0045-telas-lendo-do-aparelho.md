---
status: accepted
---

# Telas que leem do aparelho: clientes e produtos

## Contexto

O runtime offline (ADR 0043) está montado no app, sincroniza e mostra o chip de estado, mas nenhuma tela lia as coleções locais nem enfileirava comandos. Este é o primeiro passo de converter as telas, na ordem do risco: clientes e produtos (cadastro simples, sem dinheiro nem estoque) aqui; venda e estoque no [ADR 0046](0046-venda-e-estoque-sem-conexao.md).

## Decisão

- **Uma tela só muda de fonte quando o runtime está pronto e com cópia completa da organização** (`useLocalWorkspace`). Sem isso (e a chave `VITE_OFFLINE_RUNTIME_ENABLED` está desligada por padrão) a tela segue exatamente como antes, falando com o servidor. Não há modo misto dentro de uma mesma tela: ou lê tudo do aparelho ou tudo do servidor.
- **Ler:** `LocalWriter.rows(coleção)` devolve as linhas locais; o runtime ganhou `dataVersion` no estado, que sobe quando as coleções podem ter mudado (abertura, fim de cada sincronização, mesmo a que falhou no meio, e `localDataChanged()` chamado por quem escreveu). A tela lê de novo quando a versão muda. As linhas locais são reconstruídas no formato que a tela já desenha (`customers/local-customers.ts`, `catalog/local-products.ts`), com a mesma ordenação do servidor (nome e depois ID) e, para clientes, a mesma regra de possíveis repetidos (e-mail sem diferenciar caixa, telefone exato, arquivados também). O aparelho não guarda a data de criação: a última alteração faz as vezes dela na lista.
- **Escrever offline só o que já tem comando:** cadastrar cliente (`customer.create`) e cadastrar produto (`product.create`, que cria também a variante padrão, como o servidor). O cadastro entra na fila, aparece na hora com o selo "Aguardando envio" (ou "Enviando…", ou "Recusado pelo servidor" com link para Pendências) e, havendo rede, é enviado em seguida. O texto diz a verdade: "Cliente salvo neste aparelho. Ele será enviado quando a conexão voltar."
- **O resto continua online:** editar, arquivar, restaurar, variantes e imagens. Sem rede, ou enquanto o servidor não confirmou o cadastro (ele ainda não conhece o registro), os botões ficam desabilitados com a razão escrita no cartão. Com rede, a mudança vai ao servidor como antes e a linha devolvida é gravada na coleção local, para a lista não esperar o próximo pull (o pull grava a mesma versão de novo, sem efeito).
- **Prova em navegador:** `/offline-screens-lab` monta a tela real sobre o runtime real (IndexedDB e OPFS reais) com servidor e rede simulados (`e2e/offline-screens.e2e.ts`): com rede, cadastra e o selo some quando o servidor confirma; sem rede, cadastra, lista do aparelho, bloqueia o resto e, numa segunda visita sem rede, o registro continua lá; cliente repetido é avisado só com os dados do aparelho; ao voltar a rede, o envio confirma e libera as ações. Chromium desktop e Pixel 5 emulado. O laboratório não vai para a build de produção (verificado).

## Consequências

- Com a chave ligada, duas telas passam a depender da cópia local; a decisão de ligar continua condicionada ao checklist em aparelho físico (Gate 5).
- Estoque e venda seguem uma política diferente (servidor quando alcançável, aparelho só sem conexão) e têm seu próprio ADR, porque movem dinheiro e saldo e a confirmação imediata traz o que o aparelho não tem. O custo médio **não** vai ao aparelho (ADR 0031), então a tela de estoque offline trabalha sem ele.
- Editar offline fica fora de propósito: não há comando de edição, e inventar um exigiria resolução de conflitos que ainda não foi decidida.

## Alternativas rejeitadas

- **Escrever na coleção local e deixar o pull reconciliar edições feitas online:** um conflito de versão ficaria escondido; a tela só mostra o que o servidor aceitou.
- **Modo misto na tela (lista do servidor, cadastro local):** a pessoa cadastraria algo que não aparece na lista até a próxima leitura.
- **Mostrar a lista do servidor quando há rede e a local só sem rede:** a tela mudaria de conteúdo ao perder o sinal; com a cópia local sincronizada o conteúdo é o mesmo nos dois casos.
