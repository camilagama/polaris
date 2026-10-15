---
status: accepted
---

# Cotas do plano aplicadas no servidor

## Contexto

O plano (PR74 e PR75) pede que os limites do Free e do Pro valham no servidor, "sem esconder apenas a interface": 50 variantes, 1 imagem por produto, 50 imagens, 1 meta ativa, escrita offline e catálogo público desligados no Free; 2.000 variantes, 10 imagens por produto, 5.000 imagens, 3 metas, escrita offline e catálogo público no Pro. A base (ADR 0057) já dá o entitlement efetivo da organização; falta aplicá-lo onde os dados são escritos.

## Decisão

- **A verificação mora no repositório que escreve, dentro da transação do pedido.** `assertRoomFor` (módulo `entitlement-enforcement`) lê o entitlement efetivo e a contagem atual e recusa a adição que passaria do limite com `EntitlementLimitReachedError` (código `entitlement_limit_reached`, com a chave do limite atingido no próprio erro). Todo caminho de escrita (RPC, upload de mídia, comando offline) passa pelo mesmo repositório, então nenhum precisa lembrar de verificar.
- **Sem corrida.** Cada limite de cada organização tem um lock consultivo de transação: duas adições simultâneas não contam o mesmo total e passam juntas do limite (o gate prova que oito criações concorrentes nas quatro últimas vagas commitam exatamente quatro).
- **O que conta.**
  - *Variantes:* toda variante de produto não excluído, inclusive a variante padrão e as de produto arquivado (arquivar não libera vaga; excluir libera). Configurar variantes conta a adição líquida (a variante padrão é substituída pelas configuradas).
  - *Imagens:* as imagens de produto não excluído, por produto e na organização; o teto técnico de 20 por produto continua valendo antes do limite do plano.
  - *Metas ativas:* as metas em andamento (cancelar libera na hora; concluir ou encerrar o período libera quando a meta é liquidada, o que o servidor faz antes de criar uma nova); o teto técnico de 20 continua valendo atrás do limite do plano, mesmo com uma concessão que o eleve.
- **Escrita offline é um recurso do plano, aplicado em dois pontos.** Sem `offline.write` o servidor não emite lease (`EntitlementDeniedError`, "entitlement_denied"); com ele, o lease nunca vai além do fim do acesso Pro (ou fica nas 72 horas usuais quando o acesso é mais longo). Um comando que chega depois de um downgrade é rejeitado antes de rodar, com o código guardado `entitlement_changed` que o aparelho já sabe explicar ("o que está na fila será enviado depois; nada foi perdido"); um limite do plano atingido durante o comando tem o mesmo desfecho. A recusa por plano **não é guardada**: o mesmo comando (mesmo ID) pode ser enviado de novo e passa quando o plano voltar a permitir, e a tela de atenção oferece "Tentar de novo" (o aparelho recoloca o comando como pendente); recusas por dados continuam guardadas. O aparelho que recebe "sem plano" ao pedir o lease continua online, sem registrar de novo o dispositivo. O trabalho guardado no aparelho nunca se perde.
- **Downgrade restringe sem apagar.** Quem passou do limite (um Pro que volta ao Free com 300 variantes) mantém tudo; só as adições novas são recusadas, inclusive enquanto estiver acima do limite.
- **Para o cliente:** `entitlement_limit_reached` e `entitlement_denied` chegam como conflito (RPC) com o código em `data.reason`, ou 409 (upload) com o código e o limite atingido (`limit`), para a interface explicar o plano sem depender de texto. A chave do limite ainda não viaja na resposta de RPC (o contrato só cresce; quando a interface precisar distinguir os limites, ela entra).
- **`public_catalog` ainda não tem onde ser aplicado:** o catálogo público não existe. A flag já existe no catálogo de planos e será aplicada no PR que criar a página pública.
- **Nos gates, a organização de teste é paga por padrão** (`createTenantFixture` dá um plano ativo) para que eles continuem provando o comportamento de domínio; o gate `entitlements` cria organizações Free explicitamente.

## Consequências

- Um Free que cria o 51º produto, a 2ª imagem de um produto ou a 2ª meta recebe uma recusa clara; a interface ainda precisa mostrar o convite ao Pro (PR80, experiência do trial).
- Arquivar produtos não libera quota; para um lojista no Free isso significa excluir o que não usa mais.
- Cada criação de produto, imagem ou meta passa a ler o plano e contar (uma consulta por limite, sobre índices por organização); a contagem de variantes cresce com o catálogo, até 2.000 no Pro.

## Alternativas rejeitadas

- **Verificar só na interface ou só no handler:** o comando offline e o upload entram por outros caminhos.
- **Contar sem lock:** duas requisições simultâneas passariam juntas do limite.
- **Liberar quota ao arquivar:** restaurar um produto arquivado precisaria de uma segunda verificação e abriria um jeito de ficar acima do limite.
- **Emitir lease para o Free e só recusar o envio:** o aparelho acumularia trabalho que o servidor sabidamente rejeitaria.
