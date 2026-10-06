# Polaris ERP vNext

## Arquitetura, produto, regras e fundação técnica



**Status:** decisão arquitetural consolidada  

**Data de referência:** 6 de outubro de 2026  

**Natureza:** greenfield; o Polaris atual é referência histórica, não base obrigatória de implementação.



---



# 1. Visão executiva



O novo Polaris será reconstruído como um **ERP operacional enxuto para pequenos revendedores**, principalmente pessoas que hoje trabalham com planilhas, anotações e ferramentas fragmentadas.



O objetivo não é competir em quantidade de funcionalidades com Bling, Omie, Conta Azul ou ERPs completos. O produto deve entregar muito bem um conjunto menor de necessidades:



- catálogo;

- variantes;

- estoque;

- vendas;

- clientes;

- despesas;

- resultado do negócio;

- metas;

- funcionamento offline;

- posteriormente catálogo público;

- posteriormente colaboração;

- futuramente IA.



A arquitetura seguirá cinco princípios principais:



1. **simplicidade operacional para o usuário;**

2. **forte integridade econômica e de estoque;**

3. **offline real no núcleo operacional;**

4. **segurança multi-tenant em profundidade;**

5. **Cloudflare-first, mas não Cloudflare-only.**



A infraestrutura principal será baseada em Cloudflare Workers e Neon/PostgreSQL.



O sistema será um **modular monolith**, não uma coleção de microserviços.



---



# 2. Stack canônica



## Runtime e infraestrutura



- Cloudflare Workers / workerd;

- Cloudflare Vite Plugin;

- Cloudflare Static Assets;

- Cloudflare R2;

- Cloudflare Images para processamento;

- Cloudflare Queues;

- Cloudflare Workflows;

- Cloudflare Scheduled Workers;

- Cloudflare Access para Admin;

- Cloudflare Turnstile;

- Cloudflare Observability;

- Cloudflare Rate Limiting;

- Neon PostgreSQL;

- Hyperdrive;

- PostgreSQL 18 como baseline inicial;

- Drizzle ORM.



Hyperdrive será usado principalmente pelo connection pooling. **Query caching ficará desabilitado no runtime tenant/admin**, pois autenticação, billing, permissões, RLS, estoque e operações logo após writes exigem dados frescos. A própria Cloudflare prevê a configuração cache-disabled mantendo o pooling.



## Aplicação



- React;

- Vite;

- TanStack Router no ERP/Admin;

- TanStack Start no catálogo público;

- TanStack Query;

- TanStack DB;

- TanStack Form;

- TanStack Table;

- TanStack Virtual quando necessário;

- Hono;

- oRPC estável;

- Zod 4;

- Better Auth;

- Tailwind CSS 4;

- shadcn/ui;

- Base UI.



Cloudflare suporta oficialmente o modelo React SPA + API Worker + static assets no mesmo deployment, que será utilizado por `apps/web`.



## Ferramentas de engenharia



- Bun 1.4.2 como baseline inicial;

- Node 24 LTS para tooling compatível com Node;

- TypeScript 7 strict;

- Turborepo;

- Biome;

- Ultracite como preset fino sobre Biome;

- Vitest;

- `@cloudflare/vitest-plugin`;

- Playwright;

- fast-check;

- Knip;

- Renovate;

- Lefthook se continuar agregando valor.



Versões patch não serão dogma. O scaffold deve utilizar a **última versão estável compatível na data efetiva da criação**, evitando beta/RC sem POC ou ADR.



---



# 3. Estrutura do monorepo



Estrutura inicial proposta:



```text

polaris/

├─ apps/

│  ├─ web/

│  ├─ admin/

│  └─ catalog/

│

├─ packages/

│  ├─ domain/

│  ├─ contracts/

│  ├─ db/

│  ├─ billing/

│  └─ ui/

│

├─ docs/

│  ├─ adr/

│  ├─ business-rules/

│  ├─ architecture/

│  ├─ operations/

│  └─ runbooks/

│

├─ PRODUCT.md

├─ DESIGN.md

├─ CONTEXT.md

├─ AGENTS.md

├─ package.json

├─ turbo.json

└─ bun.lock

```



Não será criado um package para cada domínio.



Dentro de `packages/domain`:



```text

domain/src/

├─ organizations/

├─ catalog/

├─ inventory/

├─ sales/

├─ customers/

├─ expenses/

├─ billing/

├─ entitlements/

├─ money/

├─ time/

└─ shared/

```



A criação de novos packages precisa ser justificada por uma fronteira real, não por preferência estética.



---



# 4. Regra estrutural mais importante



`packages/domain` será TypeScript puro.



É proibido importar nele:



- React;

- Hono;

- oRPC;

- Drizzle;

- Cloudflare SDK;

- Better Auth;

- Asaas;

- Woovi;

- R2;

- Sentry;

- evlog.



O domínio deve ser executável e testável sem infraestrutura.



A direção desejada é:



```text

React

  ↓

TanStack Query / DB

  ↓

oRPC contracts

  ↓

Hono Worker

  ↓

use cases / domain

  ↓

repositories / ports

  ↓

Drizzle / PostgreSQL / providers

```



Import boundaries serão verificadas por tooling.



---



# 5. Aplicações



## `apps/web`



ERP autenticado.



Será uma SPA React/Vite com Worker integrado no mesmo deployment.



Responsabilidades do Worker:



- Better Auth;

- Hono;

- oRPC;

- webhooks relacionados ao Web quando pertinente;

- media;

- health;

- sync;

- chamadas PostgreSQL;

- R2;

- Queues.



Não haverá um `apps/api` separado na V1.



## `apps/admin`



Deployment completamente independente.



Protegido por:





- MFA obrigatório;

- JWT Access validado no Worker;

- autorização interna por capabilities.



Não compartilha sessão Better Auth com o ERP.



## `apps/catalog`



Aplicação pública separada.



Usará TanStack Start para permitir:



- HTML inicial;

- metadata;

- OpenGraph;

- compartilhamento em WhatsApp/redes;

- SEO quando desejado;

- páginas públicas rápidas.



O bucket R2 continuará privado. Publicação será realizada pela camada de aplicação.



---



# 6. Identidade do usuário



Better Auth será responsável somente por:



- usuário;

- accounts;

- credenciais;

- OAuth;

- sessões;

- verificação de email;

- recuperação de senha.



Não será fonte de verdade para:



- organização;

- membership;

- roles tenant;

- capabilities;

- billing;

- entitlements.



## Métodos de login



V1:



- Google OAuth;

- email + senha.



Email deverá estar verificado antes da criação da organização.



## Senhas



Direção:



- 15 a 128 caracteres;

- espaços/Unicode permitidos;

- nenhuma regra arbitrária do tipo “uma maiúscula + símbolo”;

- nenhuma expiração periódica;

- HIBP/breached-password blocking;

- rate limiting;

- Turnstile em signup, login por senha e recuperação.



## Account linking



Google + password poderão ser ligados automaticamente quando:



- emails forem realmente equivalentes;

- email estiver verificado;

- as garantias do provider forem adequadas.



Não será usado `trustedProviders` de forma indiscriminada para forçar linking.



---



# 7. Sessões



Sessão online:



- 7 dias de inatividade;

- máximo absoluto de 30 dias;

- múltiplos dispositivos permitidos;

- usuário pode visualizar/revogar sessões;

- logout encerra sessão atual;

- eventos críticos podem revogar todas.



Reset de senha:



- revoga todas as sessões Web;

- revoga offline leases;

- não remove automaticamente uma conta Google vinculada.



---



# 8. Organização e membership



`organization` é a unidade operacional do Polaris.



Evitar:



- `workspace` como sinônimo de produto;

- `tenant` na UI.



`tenant` pode aparecer apenas em documentação/arquitetura.



## Membership



Modelo:



```text

memberships

- id

- organization_id

- user_id

- role

- status

...

```



Unique:



```text

(organization_id, user_id)

```



A estrutura permitirá múltiplas organizações por usuário futuramente.



Na V1, o produto restringirá o usuário a uma única organização por regra de domínio/onboarding, **sem desenhar o banco como se usuário e organização fossem a mesma entidade**.



Na V1 haverá apenas um papel tenant efetivamente usado:



```text

owner

```



A autorização, entretanto, será baseada em capabilities para permitir colaboradores futuramente.



---



# 9. Estados de organização



Estados canônicos:



```text

active

suspended

closed

```



Billing não será estado da organização.



Portanto:



- `past_due` não é estado de organization;

- `trialing` não é estado de organization;

- `free` não é estado de organization.



`suspended` é usado para:



- segurança;

- abuso;

- fraude;

- decisão operacional.



Suspensão invalida offline authorization imediatamente.



---



# 10. Onboarding



Depois do login verificado:



```text

authenticated user

→ no organization

→ onboarding

→ create organization

→ create owner membership

→ create defaults

```



Tudo em uma transação idempotente.



O onboarding não será executado em hook do Better Auth.



Uma resposta perdida depois do commit não pode gerar uma segunda organização no retry.



---



# 11. Multi-tenancy e RLS



RLS continua sendo obrigatória.



Camadas:



```text

request authentication

→ membership/capability check

→ RLS context

→ database policy

```



RLS é defesa contra bug da aplicação, não sistema completo de autorização.



## Contexto explícito



Toda operação tenant recebe `organizationId` explicitamente.



O servidor:



1. autentica usuário;

2. verifica membership;

3. verifica capability;

4. inicia transação;

5. executa `set_config`;

6. executa use case.



Contextos:



```text

app.organization_id

app.user_id

```



O `organizationId` enviado pelo cliente é **contexto solicitado**, nunca autoridade.



## Roles PostgreSQL



Pelo menos:



```text

polaris_runtime

polaris_migrator

```



`polaris_runtime`:



- não é table owner;

- não possui BYPASSRLS;

- recebe apenas privilégios necessários.



Tabelas tenant críticas:



```sql

ENABLE ROW LEVEL SECURITY;

FORCE ROW LEVEL SECURITY;

```



---



# 12. Hyperdrive



Todo runtime tenant/admin usa Hyperdrive com SQL cache desabilitado.



Queries tenant-scoped passam por:



```text

withTenantTransaction(...)

```



Inclusive reads.



É obrigatório um POC remoto real para validar:



- transaction pooling;
- o caminho Worker → Hyperdrive → Neon usando PostgreSQL 18;
- todas as queries tenant-scoped dentro de uma transação explícita;
- vários statements do mesmo use case compartilhando a transação contextualizada;

- `set_config(..., true)`;

- RLS;

- concorrência;

- rollback;

- connection reuse;
- falha/interrupção e retry da operação inteira em uma nova transação, reaplicando o contexto;
- ausência de contexto, que deve negar reads tenant ou retornar zero linhas;
- query caching desabilitado sem perder pooling.



Esse POC é gate de arquitetura.



---



# 13. Migrations



Drizzle continua sendo o ORM/schema toolkit.



Production:



```text

schema change

→ drizzle migration SQL

→ revisão humana

→ commit

→ replay PostgreSQL limpo

→ staging

→ migration operacional production

```



Proibido:



```text

drizzle-kit push → production

```



Mudanças destrutivas seguirão:



```text

expand

→ deploy compatible

→ backfill

→ contract later

```



Rollback de aplicação nunca significa rollback automático de schema.



---



# 14. IDs



Entidades first-party usarão UUIDv7:



- organization;

- membership;

- product;

- variant;

- customer;

- sale;

- stock movement;

- expense;

- command;

- device;

- etc.



Offline e servidor conseguem gerar IDs equivalentes.



Better Auth e providers mantêm seus IDs próprios.



UUID não substitui timestamps de domínio.



---



# 15. Tempo



Fim da antiga regra global `America/Sao_Paulo`.



Cada organização possui:



```text

organization.timezone

```



Timezone IANA.



Exemplos:



```text

America/Sao_Paulo

America/Manaus

America/Belem

```



No onboarding:



- detectar timezone do browser;

- pedir confirmação.



Instantes técnicos:



```text

UTC / timestamptz

```



Datas de negócio:



- interpretadas no timezone da organização.



Uso de datas será abstraído semanticamente, preferencialmente via conceitos Temporal com polyfill, não `new Date()` espalhado.



---



# 16. Moeda



V1 é BRL-only.



Porém `Money` não será `number`.



API:



```text

decimal como string

```



Banco:



```text

numeric

```



Domínio:



- biblioteca decimal exata;

- nunca IEEE-754 `number` para cálculo financeiro autoritativo.



---



# 17. Catálogo



Separar:



```text

produto

variante vendável

inventário

asset

```



## Produto



Contém:



- nome;

- descrição;

- categoria opcional;

- estado;

- informações comerciais gerais.



Não contém:



- estoque;

- custo médio;

- `purchasedOn`.



## Variantes



Todo produto possui pelo menos uma variante.



Produto simples:



```text

product

└─ default variant

```



A variante padrão pode ficar invisível na UI.



Opções suportadas inicialmente:



- Modelo;

- Cor;

- Tamanho.



Todas opcionais.



Máximo técnico inicial:



```text

50 variantes vendáveis por produto

```



Somente combinações realmente criadas existem.



Não gerar produto cartesiano desnecessariamente.



## SKU



SKU fica na variante.



- opcional;

- único dentro da organização.



Código de barras não entra na V1.



## Categoria



Opcional.



Nenhum usuário será impedido de cadastrar produto por ainda não possuir categoria.



---



# 18. Arquivamento e exclusão de produto



`archive`:



- reversível;

- remove de operações normais;

- produto não é vendido enquanto arquivado.



`delete`:



- tombstone definitivo;

- somente elegível quando regras de estoque permitirem;

- nunca hard-delete operacional.



Histórico econômico permanece.



Autorização será por capability, não por `if owner`.



---



# 19. Imagens



Arquitetura:



```text

browser escolhe imagem

→ crop 1:1

→ envia original + coordenadas

→ Worker valida

→ Cloudflare Images reproduz crop

→ normaliza orientação/metadados

→ gera master WebP

→ R2 privado

```



Master:



```text

máximo 1200 × 1200

sem upscale

WebP

```



Original bruto não será mantido indefinidamente.



Derivados padrão:



- aproximadamente 320px;

- aproximadamente 640px;



podem ser gerados e persistidos no R2 como cache regenerável.



Cloudflare Images será pipeline de processamento, não necessariamente hot path infinito para toda visualização.



## Relação variante/imagem



`product_media` guarda assets.



`variant_media` associa opcionalmente assets a variantes.



Uma imagem não é duplicada apenas por estar associada a várias variantes.



---



# 20. Privacidade das imagens e catálogo público



R2 permanece privado.



Existirão duas políticas lógicas:



```text

private media

public catalog media

```



Uma imagem pública continua vindo de bucket privado, mas Worker/catalog autoriza sua exposição.



Retirar produto do catálogo:



- remove publicação;

- invalida cache;

- origem privada permanece protegida.



Nunca tornar o bucket inteiro público.



---



# 21. Inventário



Estoque não mora em `products`.



Estrutura conceitual:



```text

inventory_balances

- variant_id

- quantity

- moving_average_cost

- version

```



e:



```text

stock_movements

```



O balance é projeção materializada.



O ledger é histórico imutável.



Ambos mudam na mesma transação.



## Quantidade



`integer`.



Sem suporte inicial a:



- kg fracionado;

- metro;

- litro.



## Custo



Custo médio ponderado móvel.



Cada venda captura snapshot do custo aplicável.



## Comandos



- `receiveStock`;

- `writeOffStock`;

- `inventoryCount`;

- movimentos gerados por venda;

- movimentos compensatórios de cancelamento/devolução.



Nunca:



```sql

UPDATE inventory_balances SET quantity = ...

```



sem movimento correspondente.



## Estoque negativo



Servidor nunca aceita operação que leve estoque abaixo de zero.



Conflito offline:



- primeira operação confirmada vence;

- segunda fica `needs_attention`;

- dado local não é apagado;

- usuário corrige e cria novo comando.



---



# 22. Criação offline de produto



Produto pode nascer offline com UUIDv7.



Pode conter:



- produto;

- variante padrão/variantes;

- estoque inicial;

- custo inicial.



No servidor, sincronização cria tudo atomicamente.



Se SKU conflitar:



- comando inteiro falha;

- não há criação parcial.



Imagens ficam online-only inicialmente.



---



# 23. Vendas



Venda confirmada é economicamente imutável.



Depois de confirmada não alterar:



- itens;

- variantes;

- quantidades;

- preço;

- custo;

- desconto;

- acréscimo;

- payment snapshot;

- data econômica.



Erros econômicos são corrigidos por operações compensatórias.



---



# 24. Venda offline



Estados:



```text

pending

syncing

rejected

needs_attention

```



existem **somente na camada local/outbox**.



No PostgreSQL não existe “meia venda”.



Fluxo:



```text

offline local command

→ sync

→ server validates

→ transaction

→ official sale

```



Se rejeitada:



```text

local command → needs_attention

```



---



# 25. Preço offline



Venda offline preserva o preço legitimamente conhecido no momento.



Item carrega aproximadamente:



```text

variantId

quantity

catalogVersion

listedUnitPrice

chargedUnitPrice

```



Servidor distingue:



- preço que estava sincronizado;

- alteração comercial deliberada.



Não repricing automático no sync.



---



# 26. Ajustes da venda



Não usar `additionalAmount` sem semântica.



Modelo lógico:



```text

sale_adjustments

```



Tipos iniciais:



- desconto;

- acréscimo comercial;

- frete cobrado;

- surcharge de pagamento.



Também é permitido alterar preço de item individualmente.



Exemplo:



```text

catálogo: R$100

cliente oferece: R$110

```



Pode ser representado como:



- item vendido por R$110;

- ou acréscimo global, dependendo da negociação.



Ambos ficam explicitamente distinguíveis.



---



# 27. Frete



Separar:



```text

freight_revenue

delivery_cost

```



Exemplos:



Cliente não paga, vendedor paga R$20:



```text

freight_revenue = 0

delivery_cost = 20

```



Cliente paga R$30, vendedor gasta R$20:



```text

freight_revenue = 30

delivery_cost = 20

```



O custo da entrega entra em margem/contribuição.



---



# 28. Pagamentos das vendas operacionais



Métodos iniciais:



```text

pix

cash

credit_card

debit_card

bank_transfer

other

```



V1 permite uma forma de pagamento por venda.



Mesmo assim haverá entidade:



```text

sale_payment

```



para não acoplar pagamento diretamente às colunas de `sales`.



Isso prepara pagamento misto futuro.



---



# 29. Cartão, parcelas e antecipação



Crédito:



- 1–12 parcelas.



Registrar também tipo:



```text

merchant installment

issuer installment

```



O Polaris não cria Contas a Receber na V1.



## Payment profiles



Usuário poderá criar perfis:



```text

Stone

Mercado Pago

PagBank

...

```



Com regras por:



- modalidade;

- número de parcelas;

- processing fee;

- antecipação;

- prazo esperado.



Venda guarda snapshots das regras utilizadas.



## Custos



Separar:



```text

processing_fee

anticipation_fee

payment_surcharge

```



`processing_fee` e `anticipation_fee` são custo do negócio.



`payment_surcharge` é acréscimo cobrado do comprador.



---



# 30. Contas a Receber



Deliberadamente fora da V1.



Não teremos:



- conta bancária;

- settlement real;

- conciliação;

- baixa financeira;

- saldo bancário;

- fluxo de caixa completo;

- parcela recebida/não recebida.



O Polaris calcula **economia esperada** da venda, não afirma que o dinheiro caiu no banco.



---



# 31. Cancelamento



Cancelamento total é operação compensatória.



A venda permanece com snapshots originais.



Adicionar:



- `cancelled_at`;

- `cancelled_by`;

- motivo estruturado/opcional;

- movimentos inversos no ledger.



Nunca apagar movimentos originais.



---



# 32. Devoluções



Devolução parcial entra na V1.



Estrutura:



```text

sale_return

sale_return_items

```



Cada item possui:



- quantidade devolvida;

- quantidade que volta ao estoque.



Assim:



```text

returned = 2

restocked = 1

```



é válido quando um item voltou danificado.



Troca não ganha workflow específico inicialmente.



Troca = devolução + nova venda.



---



# 33. Refund da venda do lojista



Polaris não processa automaticamente o dinheiro devolvido ao cliente final.



Pode registrar:



```text

refund status

refunded amount

```



mas não executar estorno no cartão/Pix da venda operacional.



Esse domínio é diferente do billing da assinatura do Polaris.



---



# 34. Datas da venda



Guardar pelo menos:



```text

occurred_at

recorded_at

confirmed_at

```



`occurred_at`:



- tempo comercial.



`recorded_at`:



- evidência local.



`confirmed_at`:



- relógio autoritativo do servidor.



Venda retroativa:



```text

até aproximadamente 30 dias

```



para owner na V1.



Datas futuras além de pequena tolerância são rejeitadas.



---



# 35. Clientes



Clientes são domínio próprio já na V1.



Uma venda pode ser:



- sem cliente;

- cliente avulso;

- cliente cadastrado.



Nenhum cliente obrigatório.



## Cadastro mínimo



Campos iniciais:



- nome;

- telefone/WhatsApp;

- email;

- observações.



Para cadastro fazer sentido:



- pelo menos nome, telefone ou email.



Não incluir inicialmente:



- CPF;

- CNPJ;

- endereço;

- nascimento;

- gênero.



---



# 36. Cliente e imutabilidade da venda



A economia da venda continua imutável.



A associação com cliente é **reconciliável**.



Usar entidade/conceito separado:



```text

sale_customer_link

```



Com:



- sale;

- customer atual;

- version;

- linked_at;

- linked_by;

- source.



Comandos:



```text

sale.assignCustomer

sale.reassignCustomer

sale.unassignCustomer

```



Tudo auditado.



Isso permite:



```text

venda avulsa em janeiro

→ cliente volta em fevereiro

→ cadastro criado

→ venda antiga associada

```



sem transformar `sales` em CRUD editável.



---



# 37. Snapshot de cliente



Venda pode preservar um pequeno:



```text

buyer_label_snapshot

```



por exemplo:



```text

"Maria"

```



Se o cadastro depois virar “Maria Souza”, o histórico continua sabendo como a venda foi originalmente registrada.



Evitar duplicar telefone/email em toda venda desnecessariamente.



---



# 38. Deduplicação de clientes



Não fazer merge automático agressivo.



Não assumir que:



- nome igual;

- telefone igual;

- email igual



representam necessariamente a mesma pessoa.



UI pode mostrar:



```text

Possível cliente existente

```



e permitir decisão humana.



Merge explícito pode ser criado posteriormente.



---



# 39. Offline de clientes



Clientes entram no núcleo offline.



Permitir:



- consulta;

- criação offline;

- associação a vendas offline.



Novo cliente recebe UUIDv7 no browser.



Outbox conhece dependências entre:



```text

customer.create

sale.create

```



---



# 40. Despesas



Adicionar módulo **Despesas** na V1.



Não é módulo financeiro completo.



Objetivo:



```text

quanto a operação custou?

```



Não teremos inicialmente:



- fornecedor estruturado;

- conta financeira;

- boleto;

- contas a pagar;

- conciliação;

- centro de custo;

- rateio.



---



# 41. Categorias de despesa



Grupos principais:



- Comercial;

- Operacional/Administrativa;

- Financeira;

- Impostos;

- Outras.



Usuário pode criar categorias como:



- Marketing;

- Aluguel;

- Contador;

- Energia;

- Software;

- Entrega.



Uma despesa → uma categoria na V1.



---



# 42. Recorrência de despesas



Entra na V1.



Exemplo:



```text

Aluguel

R$1.500

mensal

```



Modelo:



```text

expense_recurring_rule

→ gera expense occurrences

```



Editar recorrência futura não reescreve ocorrências históricas.



---



# 43. Competência



Resultados usam competência, não simplesmente pagamento.



Uma despesa referente a outubro pertence a outubro mesmo que paga em novembro.



Isso é visão gerencial, não contabilidade oficial.



---



# 44. Compra de estoque



Compra de estoque **não é despesa operacional**.



Fluxo:



```text

compra → inventário

venda → CMV

```



Evitar dupla contagem.



---



# 45. Custos automáticos



Taxas de cartão e antecipação já conhecidas pela venda:



- não podem ser digitadas novamente como despesa.



Uma única fonte por fato econômico.



---



# 46. Despesa vinculada a venda



Uma despesa pode opcionalmente apontar para uma venda.



Exemplos:



- entrega;

- embalagem;

- comissão;

- personalização.



Se vinculada:



- entra na margem de contribuição daquela venda.



Se não vinculada:



- entra apenas no resultado do período.



---



# 47. Resultado econômico



Vocabulário formal:



```text

Vendas brutas

- descontos

- devoluções

= Vendas líquidas

```



```text

Vendas líquidas

- CMV

= Lucro bruto

```



```text

Lucro bruto

+ acréscimos comerciais

- custos variáveis

= Margem de contribuição

```



```text

Margem de contribuição

- despesas operacionais

= Resultado operacional estimado

```



Não chamar isso simplesmente de “lucro líquido”.



---



# 48. Dashboard



Cards principais:



- vendas líquidas;

- resultado operacional estimado;

- margem estimada;

- quantidade de vendas;

- ticket médio;

- itens vendidos.



Blocos complementares:



- produtos mais vendidos;

- produtos mais rentáveis;

- estoque;

- novos × recorrentes;

- metas.



O dashboard não deve virar parede de KPIs.



---



# 49. Qualidade do resultado



O sistema deve indicar quando a qualidade dos dados reduz a confiança.



Exemplo conceitual:



```text

Resultado operacional estimado: R$ 4.853



Custos de produtos: completos

Taxas: 96% identificadas

Despesas recorrentes: cadastradas

```



Não apresentar precisão falsa.



---



# 50. Metas



Métricas V1:



- vendas líquidas;

- resultado operacional estimado;

- quantidade de vendas.



Períodos:



- semanal;

- mensal;

- personalizado.



Mensal é default de UX.



Lifecycle:



```text

active

completed

expired

archived

```



Alteração de target durante período:



- permitida;

- auditada.



Meta completada não reabre automaticamente.



---



# 51. Offline do dashboard



Offline:



- mostrar último estado confirmado;

- indicar horário de atualização.



Não recalcular localmente um “resultado oficial” usando comandos ainda pendentes.



---



# 52. Offline — filosofia



PWA realmente funcional offline.



Browsers obrigatórios:



- Safari/iOS atual;

- Chromium Android;

- Chrome desktop;

- Edge desktop.



Firefox é best effort inicialmente.



Núcleo offline:



- catálogo;

- variantes;

- estoque;

- clientes;

- venda;

- movimentos operacionais essenciais.



Online-only inicialmente:



- billing;

- conta;

- segurança;

- Admin;

- despesas write;

- reports pesados;

- permissões;

- imagens.



---



# 53. Tecnologia offline



Primeira candidata:



```text

TanStack DB

+ SQLite persistence

+ @tanstack/offline-transactions

```



TanStack documenta offline transactions e persistência local, mas isso continua sujeito a POC real no nosso cenário.



Gate obrigatório em:



- iPhone/Safari;

- Android Chrome;

- Chrome desktop;

- Edge desktop.



Testar:



- kill/reopen;

- multiple tabs;

- storage eviction;

- migration de schema local;

- crash;

- restore de pending mutations;

- BFCache.



Se reprovar:



```text

Dexie 4 / IndexedDB

```



substitui persistência local.



Servidor/protocolo não muda.



---



# 54. Protocolo de sync



Protocolo Polaris próprio e versionado.



Primitivas:



```text

sync.push(commands[])

sync.pull(cursor)

```



## Command



Aproximadamente:



```text

commandId

organizationId

deviceId

type

baseVersion

offlineGrant

payload

createdAt

```



Todo command é idempotente.



## Pull



Servidor possui change log ordenado.



Exemplo:



```text

15291 customer upsert ...

15292 variant update ...

15293 sale create ...

```



Device mantém cursor.



Se cursor expirar:



```text

REBOOTSTRAP_REQUIRED

```



e recebe novo snapshot.



Change log pode ter retenção inicial aproximada de 30 dias.



---



# 55. Conflitos offline



Não existirão merges genéricos automáticos.



Por domínio:



## Estoque/vendas



Commands append-only.



Sem saldo negativo.



## Produto



Optimistic concurrency / base version.



Conflito V1:



```text

reject → needs_attention

```



Não last-write-wins silencioso.



## Entidades imutáveis



Não merge.



---



# 56. Offline authorization lease



Máximo:



```text

72 horas

```



desde última validação online.



Dentro da janela:



- core Pro offline pode funcionar.



Depois:



- bloquear novas mutações offline;

- preservar pending.



No sync servidor revalida:



- sessão;

- membership;

- organization;

- capabilities;

- suspensão;

- entitlement.



`authorization_epoch` invalida grants anteriores em eventos de segurança.



Suspensão administrativa:



- invalidação imediata.



Reset de senha:



- invalidação imediata.



Downgrade normal:



- não renovar lease;

- lease já válida pode terminar normalmente.



Trial:



```text

lease expiry =

min(now + 72h, trial_ends_at)

```



---



# 57. Device



Cada instalação/browser:



```text

device

- id aleatório

- user

- created_at

- last_seen

- revoked_at

- metadata mínima

```



Sem fingerprinting invasivo.



Device não é fator de autenticação.



Serve para:



- offline;

- diagnóstico;

- outbox;

- lease;

- revogação.



---



# 58. Logout e pending commands



Não fazer logout silencioso destruindo operações pendentes.



Mostrar:



- sincronizar antes de sair, quando possível;

- ou descartar explicitamente.



Após logout concluído:



- dados locais tenant são limpos.



---



# 59. Service Worker



Responsável por:



- app shell;

- assets;

- navegação offline;

- update lifecycle.



Não será:



- banco;

- sync engine autoritativo;

- armazenamento indiscriminado de API privada.



Background Sync é otimização, não requisito de correção.



---



# 60. Atualização PWA



Se outbox vazio:



- update pode acontecer normalmente.



Se pending commands:



- não recarregar automaticamente;

- informar atualização;

- sincronizar antes quando possível.



Protocolos críticos mantêm compatibilidade N−1.



---



# 61. Plano Free e Pro



Comercialmente V1:



```text

Free

Pro

```



Arquiteturalmente:



- catálogo de planos arbitrário;

- futuras ofertas/add-ons;

- sem checks `plan === "pro"` espalhados.



Free forever é a estratégia inicial, mas deve permanecer configurável comercialmente.



---



# 62. Pro Trial



Usuário cadastra e pode usar Free sem método de pagamento.



Trial começa apenas quando ele escolhe:



```text

Testar Pro

```



Trial:



```text

7 dias

```



Método de renovação obrigatório.



Opções:



- cartão recorrente;

- Pix Automático.



O trial só inicia quando o método está efetivamente pronto/autorizado.



---



# 63. Trial com cartão



Provider:



```text

Asaas

```



Fluxo:



```text

cartão validado

→ assinatura recorrente criada

→ primeira cobrança futura

→ 7 dias Pro

→ cobrança automática

```



A assinatura não é compra única nem parcelamento.



Cada ciclo cobra integralmente o valor do ciclo.



---



# 64. Trial com Pix Automático



Provider:



```text

Woovi

```



Fluxo:



```text

QR inicial

→ usuário autoriza Pix Automático no banco

→ trial começa

→ primeira cobrança futura em 7 dias

→ cobranças seguintes automáticas

```



O usuário **não lê QR novamente após sete dias**.



Na jornada `ONLY_RECURRENCY`, Woovi permite criar o mandato agora e iniciar cobrança em uma data futura.



---



# 65. Trial — regras



Uma vez por organização/identidade conforme política antifraude.



`trial_consumed_at` somente após método efetivamente confirmado.



Cancelar durante trial:



- continua Pro até `trial_ends_at`;

- primeira cobrança é cancelada;

- depois vira Free.



Primeira cobrança falhou:



```text

trialing → Free

```



Sem grace adicional.



Se retry posterior efetivamente pagar:



```text

Free → Pro active

```



---



# 66. Pro — preço inicial



Hipótese comercial inicial:



```text

Mensal      R$ 24,90

Semestral   R$ 124,50

Anual       R$ 249,00

```



Semestral ≈ cinco mensalidades.



Anual ≈ dez mensalidades.



Não hardcode.



Preço é versão comercial no banco.



---



# 67. Ciclos e troca



Ciclos:



- monthly;

- semiannual;

- annual.



Troca ocorre no próximo renewal.



Sem proration V1.



Exemplo:



```text

anual → mensal

```



fica anual até terminar período contratado.



---



# 68. Pro — quotas iniciais



## Free



```text

50 variantes ativas

1 imagem por produto

50 imagens ativas totais

1 meta ativa

offline write: não

public catalog: não

```



## Pro



```text

2.000 variantes ativas

10 imagens por produto

5.000 imagens ativas totais

3 metas ativas

offline write: sim

public catalog: sim

```



Esses limites são hipóteses comerciais iniciais e devem gerar telemetria.



Não limitar:



- número de vendas;

- clientes;

- movimentos históricos;

- despesas;

- histórico.



---



# 69. Futuro plano de IA



Arquitetura aceita futuro:



```text

Pro AI

```



ou equivalente.



Não mostrar sistema de créditos ao usuário.



IA comercialmente deve parecer capacidade incluída.



Internamente, porém, medir:



- tokens;

- custo;

- frequência;

- abuso;

- organização.



Aplicar:



- fair use;

- rate limits;

- proteção econômica.



Possíveis funções futuras:



- cadastrar venda por chat;

- cadastrar cliente;

- consultar estoque;

- pedir resumos;

- perguntar sobre o negócio;

- análises.



Não implementar na V1.



---



# 70. Entitlements



Capabilities comerciais tipadas e centralizadas.



Exemplos:



```text

catalog.activeVariantsLimit

product.imagesPerProductLimit

media.totalImagesLimit

goals.activeLimit

offline.write

publicCatalog.enabled

```



Não:



```ts

if (plan === "pro")

```



em features.



Todos os enforcement críticos acontecem no servidor.



---



# 71. Downgrade



Não apagar dados.



Também não permitir usar indefinidamente recursos acima do plano.



Estado:



```text

Free Over Limit

```



Quando Pro termina:



- curto período de adequação inicial de 7 dias para limites quantitativos;

- usuário seleciona recursos que permanecerão dentro da quota Free.



Depois:



- até 50 variantes permanecem operacionais;

- excedentes ficam bloqueados por entitlement;

- continuam visíveis;

- exportáveis quando aplicável;

- histórico permanece;

- não podem receber nova atividade comercial.



Não armazenar `plan_locked` como propriedade intrínseca da variante.



Guardar seleção/estado de entitlement separadamente.



---



# 72. Anti-rotação de quota



Usuário acima do limite não pode:



```text

unlock A

sell

lock A

unlock B

sell

...

```



para contornar Free.



Enquanto acima da quota:



- conjunto operacional fica congelado;

- para trocar, precisa voltar ao limite real ou assinar Pro.



---



# 73. Downgrade de outros recursos



Após Pro:



- catálogo público deixa de estar publicado;

- novas offline leases não são emitidas;

- imagens excedentes são preservadas mas restritas;

- metas excedentes são pausadas/locked.



Operações necessárias para preservar integridade histórica continuam permitidas.



Exemplo:



- cancelar venda antiga;

- devolução;

- movimento compensatório.



---



# 74. Renewal e grace



Cliente pagante:



```text

renewal fails

→ grace 7 dias

→ pagamento recuperado → active

→ grace termina → Free/Over Limit

```



Trial failure não recebe grace.



---



# 75. Refund e chargeback da assinatura Polaris



Refund integral do período corrente:



- encerra entitlement Pro;

- cai para Free/Over Limit.



Refund parcial comercial:



- pode manter entitlement.



Chargeback:



- mais severo;

- Pro removido imediatamente;

- nenhuma nova offline lease;

- sem grace.



Se disputa for revertida, entitlement pode ser restaurado auditadamente.



---



# 76. Billing providers



V1 deliberadamente multi-provider.



## Cartão



```text

Asaas

```



Somente assinatura recorrente.



## Pix



```text

Woovi Pix Automático

```



Somente recorrência automática.



Não tentar modelar ambos como uma API artificialmente idêntica.



Interfaces por rail:



```text

CardRecurringProvider

PixAutomaticProvider

```



Implementações:



```text

AsaasCardAdapter

WooviPixAdapter

```



Futuramente:



```text

MercadoPagoCardAdapter

AsaasPixAdapter

...

```



---



# 77. Troca de provider



Alterar provider default afeta novas assinaturas.



Assinaturas antigas continuam vinculadas ao provider que possui:



- autorização;

- tokenização;

- mandate;

- resource externo.



Migration de provider é workflow deliberado, nunca mágica.



---



# 78. Troca cartão ↔ Pix



Nunca cancelar pagamento funcional antes do substituto estar pronto.



Exemplo:



```text

Asaas card active

→ criar Woovi authorization

→ user approves

→ schedule new rail

→ cancelar renovação antiga

```



Se autorização nova falhar, método atual continua.



---



# 79. Billing customer



Lazy.



Free puro não cria customer no provider.



Criar somente no primeiro upgrade/trial necessário.



Idempotente.



Guardar:



```text

provider

provider_customer_id

organization_id

```



---



# 80. Webhooks de billing



Webhook nunca concede acesso diretamente.



Fluxo:



```text

provider

→ validate

→ durable inbox/dedup

→ ack rápido

→ Queue

→ adapter/reconciliation

→ canonical billing state

→ entitlement

```



Eventos fora de ordem não podem retroceder estado indevidamente.



---



# 81. Outbox + Queues + Workflows



Arquitetura assíncrona:



## Transactional outbox



Resolve:



```text

DB state + intent assíncrona

```



na mesma transação.



## Cloudflare Queues



Resolve:



- entrega;

- retry;

- processamento curto/repetível.



Assumir at-least-once.



## Workflows



Usar apenas para processos:



- longos;

- multi-step;

- com waits;

- retomáveis.



Nunca usar todos os três automaticamente para todo job.



---



# 82. Filas



Inicialmente:



```text

critical

default

media

```



## Critical



- billing;

- privacy;

- security.



## Default



- email;

- reconciliações;

- efeitos gerais.



## Media



- processamento;

- cópia;

- cleanup.



Mensagens têm envelope versionado e tipado.



---



# 83. DLQ



Toda Queue crítica possui DLQ.



DLQ > 0 vira incidente operacional.



Admin mostra:



- tipo;

- entidade;

- tentativas;

- erro sanitizado;

- retry.



Retry preserva a idempotency identity.



---



# 84. Workflows iniciais



Candidatos:



- exportação sob solicitação;

- purge de organização;

- DSR;

- processos longos de mídia quando necessário.



Não usar Workflow como única fonte da verdade de:



- trial;

- subscription;

- expense recurrence;

- grace.



PostgreSQL permanece fonte de estado.



---



# 85. Scheduled jobs



Scheduled Workers + estado DB.



Exemplos:



- trial/grace expirados;

- recurring expenses;

- outbox sweeper;

- reconciliation;

- staging cleanup;

- sync log retention;

- privacy purge.



Jobs devem ser:



- idempotentes;

- catch-up safe.



Nunca depender de executar exatamente às 00:00.



---



# 86. Observabilidade



## Backend



Cloudflare Observability.



## Logging API



evlog.



## Frontend



Sentry Browser SDK.



## Filosofia



Logging Sucks / wide events.



Cada unidade de trabalho produz evento estruturado rico em vez de uma sequência caótica de strings.



Cloudflare permanece datastore/plataforma de observabilidade; evlog é API/ergonomia, não backend de observabilidade.



---



# 87. evlog



Usar no:



- Hono;

- oRPC;

- Queue consumers;

- jobs;

- billing integrations.



Não importar em `packages/domain`.



Não usar seu audit-log como auditoria oficial.



Não usar client logging na V1.



Audit trail autoritativo continua no PostgreSQL.



---



# 88. Campos canônicos de logging



Schema consistente, por exemplo:



```text

event

requestId

correlationId

organizationId

actorId

deviceId

operation

commandId

entityType

entityId

outcome

durationMs

errorCode

provider

queue

attempt

workerVersion

```



PII não entra por default.



Proibido:



- senha;

- cookies;

- tokens;

- card data;

- webhook secrets;

- OAuth payload;

- body completo de venda;

- telefone/email desnecessário.



---



# 89. Structured errors



Domínio possui códigos próprios:



```text

INSUFFICIENT_STOCK

VERSION_CONFLICT

ENTITLEMENT_REQUIRED

OFFLINE_LEASE_EXPIRED

...

```



oRPC traduz para transporte.



evlog registra contexto.



Mensagens `why/fix` podem existir para operação interna, mas não devem vazar detalhes sensíveis ao cliente.



---



# 90. Tracing



Cloudflare tracing como baseline.



Production:



- erros/importantes: 100%;

- traces normais: ~5% inicialmente.



Staging:



- tracing mais alto/100% quando economicamente viável.



Amostragem pode ser revisada com uso real.



---



# 91. Sentry



Sentry fica focado no browser:



- React crashes;

- source maps;

- erros client-side;

- navegador/device;

- versão;

- performance front-end quando útil.



Não instalar automaticamente SDK Sentry em todos os Workers.



Se futuramente necessário, Cloudflare pode exportar OTel para backend externo.



---



# 92. Rate limiting



Upstash sai da fundação.



Usar:



- Cloudflare Rate Limiting para burst/abuso;

- storage/database de auth para limites determinísticos quando necessário.



Rate Limiting do edge não deve ser tratado como contador financeiro ou quota exata.



---



# 93. Segurança Web



Turnstile em:



- signup password;

- signin password;

- password reset.



Security headers centralizados:



- CSP;

- HSTS;

- X-Content-Type-Options;

- Referrer-Policy;

- Permissions-Policy;

- anti-framing.



Pouquíssimos scripts terceiros dentro do ERP.



Sem session replay na V1.



---



# 94. Admin



V1 possui apenas:



```text

platform_owner

```



Não criar `support` e `operator` fictícios antes de existir equipe.



Authorization interna continua baseada em capabilities para introduzi-los futuramente.



Admin protegido por:



- deployment separado;



- MFA;

- sessão curta (~4h);

- purpose justification;

- capability checks;

- RLS.



---



# 95. Impersonation



Proibido.



Nenhum:



- “Entrar como cliente”;

- cookie do usuário;

- sessão owner;

- backdoor;

- master token.



Diagnóstico deve acontecer através do Admin.



---



# 96. Acesso tenant pelo Admin



Mesmo `platform_owner` não deve navegar casualmente por todos os dados.



Fluxo V1:



```text

abrir caso/motivo

→ emitir grant JIT read-only temporário

→ acessar tenant

→ expiração automática

```



Como só haverá uma pessoa inicialmente, não há aprovação por segundo operador.



Quando equipe crescer:



- grants podem exigir aprovação por capability diferente.



Prazo inicial sugerido:



```text

60 minutos

```



---



# 97. PII no Admin



Tenant read access não revela toda PII automaticamente.



Default:



- mascarado.



Reveal:



- ação explícita;

- contexto/caso;

- auditado.



Nunca revelável:



- password;

- auth token;

- OAuth token;

- card secrets;

- webhook secret;

- API secret.



---



# 98. RLS no Admin



Admin não usa BYPASSRLS como solução padrão.



Transação administrativa contextualiza:



```text

platform_principal_id

support_case_id

organization_id

```



Policies validam escopo/capability/JIT.



Isso exige POC com Hyperdrive/PostgreSQL antes da implementação definitiva.



---



# 99. Auditoria administrativa



Mais rígida que logging observacional.



Registrar:



- grants;

- PII reveal;

- tenant sensitive read;

- subscription actions;

- refund;

- entitlement grant;

- suspension;

- reconciliation;

- DSR/privacy;

- configuration change.



Audit event não contém o dado sensível em si.



---



# 100. Grants comerciais



Nunca falsificar assinatura.



Compensação/parceria:



```text

entitlement_grant

```



Campos:



- organization;

- entitlement/offer;

- starts_at;

- expires_at;

- reason;

- actor.



Sempre expira.



---



# 101. Estado de assinatura



Nunca haverá dropdown:



```text

Status: active ▼

```



Admin executa comandos semânticos:



- reconcile;

- cancel renewal;

- refund;

- retry;

- grant temporary entitlement.



Estado emerge dos fatos.



---



# 102. Privacidade/LGPD



Polaris pode atuar como:



## Controlador



Nos dados ligados à própria prestação do Polaris:



- conta;

- autenticação;

- subscription;

- segurança;

- antifraude;

- suporte.



## Operador



Principalmente nos dados dos clientes cadastrados pelo lojista.



Essa definição deve ser refinada por atividade de tratamento e formalizada juridicamente.



---



# 103. Encerramento



Fluxo conceitual:



```text

active

→ closing

→ closed/purge_pending

→ purged

```



Ao encerrar:



- bloquear novas operações;

- revogar sessões;

- revogar offline leases;

- despublicar catálogo;

- cancelar renovação futura.



Janela de recuperação normal:



```text

30 dias

```



Depois purge dos dados elegíveis.



DSR formal pode exigir tratamento diferente.



---



# 104. Exportação



Não oferecer exportação automaticamente como etapa obrigatória do encerramento.



Export existe **sob solicitação**:



- owner;

- portability/access request;

- DSR.



Pacote pode incluir:



- CSV;

- JSON;

- imagens normalizadas.



Export temporário:



- privado;

- signed/authorized;

- TTL curto;

- apagado automaticamente.



---



# 105. Cliente final e privacidade



Operação:



```text

customer.anonymizeForPrivacy

```



Remove/anonymiza PII:



- nome;

- telefone;

- email;

- notes;

- snapshots pessoais elegíveis.



Preserva fatos econômicos:



- venda;

- valores;

- itens;

- estoque;

- margem.



Pedido normalmente parte:



```text

titular → lojista controlador → Polaris operador

```



Polaris não apaga unilateralmente dados do tenant por simples email de terceiro.



---



# 106. Retention matrix



Não usar “5 anos para tudo”.



Classes possuem retenção diferente:



- tenant business data;

- subscription/billing Polaris;

- access logs;

- security incidents;

- audit;

- backups;

- exports;

- staging;

- media.



Prazos jurídicos de billing/fiscal devem ser validados por jurídico/contador antes do go-live.



---



# 107. Access logs



Quando aplicável ao Marco Civil:



- registros mínimos necessários;

- seis meses;

- ambiente controlado.



Não guardar conteúdo da aplicação apenas para satisfazer essa finalidade.



---



# 108. Security incidents



Registros de incidentes:



- mínimo regulatório aplicável;

- atualmente considerar pelo menos cinco anos conforme regra pertinente;

- separados dos logs operacionais.



Não guardar dumps desnecessários de PII dentro do incidente.



---



# 109. Backups e privacidade



Delete em Production não significa apagar instantaneamente PITR antigo.



Estratégia:



```text

delete production

→ deletion tombstone

→ backup expires normalmente

→ restore reaplica deletion ledger

→ só então ambiente pode ser usado

```



Não tentar editar backup histórico por linha individual.



---



# 110. Purge de imagens



Purge cobre:



- master;

- derivados;

- staging;

- cache público;

- cache privado quando necessário.



Lifecycle:



- staging ≈ 24h.



Não usar R2 Bucket Lock em conteúdo tenant normal.



---



# 111. Public catalog privacy



Criar:



```text

public_catalog_profile

```



Somente dados explicitamente escolhidos tornam-se públicos.



Nunca publicar automaticamente:



- email de login;

- telefone de billing;

- endereço cadastral;

- dados privados do owner.



---



# 112. Backup de PostgreSQL



Duas camadas:



1. Neon PITR;

2. logical backup independente cifrado.



Logical backup pode ir para R2 privado.



Restore não acontece diretamente sobre Production.



Primeiro:



```text

restore disposable

→ verify

→ deletion ledger

→ migrations if needed

→ smoke

```



---



# 113. Backup de imagens



Master:



- backup curto separado;

- retenção inicial ~7 dias.



Não backup:



- staging;

- derivados regeneráveis.



Objetivo:



- proteger contra DELETE acidental;

- sem criar retenção eterna incompatível com privacidade.



---



# 114. Restore drill



Trimestral inicialmente e antes de mudanças críticas.



Drill real:



- restaurar banco;

- restaurar masters;

- aplicar deletion ledger;

- validar RLS;

- smoke;

- medir RPO;

- medir RTO.



Não prometer RTO/RPO antes de medi-los.



---



# 115. Testing



## Domain unit



Para regras puras.



## Worker integration



Vitest dentro do runtime Workers.



## PostgreSQL behavior



PostgreSQL 18 real.



Testar:



- RLS;

- constraints;

- concurrency;

- locks;

- transactions;

- idempotency;

- migrations.



## Property-based



fast-check para:



- estoque;

- returns;

- money;

- billing state;

- entitlements;

- idempotency.



## E2E



Playwright para journeys críticas.



---



# 116. Offline browser matrix



CI:



- Chromium desktop;

- mobile Chromium;

- Playwright WebKit.



Release gate periódico:



- Safari real em iPhone.



Testar:



- install PWA;

- offline open;

- create sale;

- force kill;

- reopen;

- reconnect;

- conflict;

- logout pending;

- service worker update;

- multi-tab.



---



# 117. Providers em testes



PR CI:



- fixtures/mocks;

- contract tests.



Staging:



- Asaas sandbox real;

- Woovi sandbox real.



Testar:



- trial;

- renewal;

- failure;

- refund;

- duplicate webhook;

- out-of-order webhook;

- cancel;

- Pix authorization.



---



# 118. Ambientes



## Local



- Vite/workerd;

- PostgreSQL 18 local;

- fake/sandbox providers.



## Preview/PR



- Cloudflare Worker Preview;

- Neon branch descartável;

- synthetic data.



Nunca Production data.



## Staging



Ambiente persistente completo:



- Workers próprios;

- Neon;

- R2;

- Queues;

- Workflows;

- Cron;

- provider sandbox.



## Production



Tudo separado.



---



# 119. Deploy



Merge em `main`:



```text

CI

→ automatic Staging deploy

→ staging smoke

```



Production:



```text

workflow_dispatch explícito

```



Não publicar automaticamente Production apenas porque houve merge.



---



# 120. Workers Versions



Fluxo:



```text

approved SHA

→ versions upload

→ version smoke

→ compatible migration

→ deploy 100%

→ production smoke

```



Inicialmente evitar gradual rollout por causa de version skew SPA/PWA.



Rollback rápido de Worker continua disponível.



---



# 121. Compatibility date



Cada Worker possui `compatibility_date` pinada.



Atualização de compatibility date:



- mudança deliberada;

- Preview;

- Staging;

- tests.



Nunca atualizar automaticamente para “hoje”.



---



# 122. CI



Required checks devem cobrir, proporcionalmente:



- format/lint;

- typecheck;

- unit tests;

- domain tests;

- Worker integration;

- migration replay;

- PostgreSQL behavior/RLS;

- builds afetados;

- Knip;

- dependency audit;

- E2E críticos.



Jobs caros externos ficam fora de todo PR:



- sandbox providers;

- restore drill;

- physical Safari.



---



# 123. Dependency management



Renovate.



Políticas:



- agrupar TanStack;

- agrupar Cloudflare;

- agrupar tooling relacionado;

- patches/minors controláveis;

- majors deliberados.



Nenhum auto-merge cego de major.



---



# 124. UI/design



Preservar a direção visual do Polaris:



**Minimalismo Essencial.**



Características:



- interface operacional;

- densa sem ser sufocante;

- hierarquia clara;

- data-first;

- superfícies simples;

- semantic tokens;

- dark/light;

- acessibilidade;

- pouca decoração gratuita.



Base UI/shadcn fornece comportamento, não identidade visual.



---



# 125. React state



Não instalar Redux/Zustand inicialmente.



Responsabilidades:



```text

TanStack Query → server state

TanStack DB → local/offline collections

TanStack Form → form state

React → local presentation state

```



Nova state library só entra com problema concreto.



---



# 126. Forms



TanStack Form + Zod.



Zod valida fronteiras.



Domínio valida regras de negócio.



Não transformar Zod schema em substituto do domínio.



---



# 127. Tabelas



TanStack Table.



TanStack Virtual somente quando dataset/renderização justificar.



Busca, filtro e paginação continuam server-side quando necessário.



---



# 128. Email



Resend + React Email.



Envio assíncrono por outbox/Queue.



Webhooks de delivery tratados como eventos duráveis.



Templates podem ganhar package próprio apenas quando houver compartilhamento real entre apps.



---



# 129. Documentação



Manter:



```text

PRODUCT.md

CONTEXT.md

DESIGN.md

AGENTS.md

```



Cada um com autoridade clara.



## PRODUCT



Produto, público, objetivos, escopo.



## CONTEXT



Terminologia.



## DESIGN



Sistema visual/UX.



## AGENTS



Práticas de engenharia/agentes.



## ADR



Decisões arquiteturais duráveis.



## Business Rules



Normas de domínio.



Evitar duplicação normativa.



---



# 130. ADRs iniciais recomendados



Pelo menos:



1. Cloudflare-native modular monolith;

2. PostgreSQL + RLS + Hyperdrive;

3. Hono + oRPC;

4. offline protocol + local persistence;

5. transactional outbox + Queues + Workflows;

6. billing multi-provider por rail;

7. private R2 + selective public media;

8. immutable economic sales;

9. privacy purge/deletion ledger;

10. Cloudflare Observability + evlog wide events.



---



# 131. Decisões explicitamente rejeitadas na V1



Não usar como base:



- Next.js;

- vinext;

- D1 como database principal;

- Inngest;

- Upstash Redis;

- PowerSync;

- Zero;

- Electric como requisito;

- microservices;

- public R2 bucket;

- hard delete de vendas;

- negative stock;

- generic last-write-wins;

- customer obrigatório;

- supplier domain;

- Accounts Payable;

- Accounts Receivable;

- bank reconciliation;

- CRM completo;

- public API;

- native app;

- session replay;

- arbitrary feature-flag SaaS;

- billing status editable manually;

- support impersonation.



Essas soluções podem ser reavaliadas futuramente se o problema mudar.



---



# 132. POCs/gates obrigatórios antes da implementação ampla



## Gate A — Hyperdrive + RLS



Provar em ambiente Cloudflare remoto real, no caminho Worker → Hyperdrive → Neon e usando PostgreSQL 18:



- transaction scoped config;

- pooling;

- RLS;

- FORCE RLS;

- no cross-tenant leak;

- cache disabled;

- concorrência A/B com reuso de conexões;
- contexto limpo após commit e rollback;
- falha/interrupção com retry integral em nova transação;
- reads sem contexto negados ou sem linhas.



**Falhou → não construir features tenant em cima da suposição.**



## Gate B — Offline persistence



Provar TanStack DB:



- Safari/iPhone;

- Android;

- desktop;

- crash;

- reopen;

- multiple tabs;

- schema update;

- durable outbox.



**Falhou → Dexie fallback.**



## Gate C — Auth



Provar:



- Better Auth no Worker;

- Google;

- password;

- verification;

- linking;

- HIBP;

- sessions;

- Turnstile.



## Gate D — Pix Automático



Woovi sandbox:



```text

authorize once

→ trial

→ automatic first charge

→ recurrence

→ retry

→ cancel

```



## Gate E — Asaas card



Sandbox:



```text

card setup

→ trial

→ automatic recurring payment

→ renewal fail

→ refund

→ cancel

```



## Gate F — Media



Provar:



- crop coordinates;

- WebP master 1200;

- 320/640 derivatives;

- R2;

- private access;

- public catalog exposure;

- cache invalidation.



## Gate G — Safari PWA



Physical device release proof.



## Gate H — Admin/RLS



Cloudflare Access + platform capability + JIT + tenant RLS.



## Gate I — Restore



Real restore drill antes de dados importantes.



---



# 133. Ordem recomendada de implementação



## Fase 0 — Repository foundation



Criar:



- monorepo;

- tooling;

- CI;

- documentation hierarchy;

- dependency baseline;

- apps vazios;

- package boundaries.



Nenhuma feature.



## Fase 1 — Infrastructure POCs



Executar primeiro:



- Hyperdrive/RLS;

- TanStack offline;





- oRPC/Hono integration.



Não começar catálogo antes de os riscos fundacionais estarem validados.



## Fase 2 — Identity and tenancy



Implementar:



- auth;

- organization;

- membership;

- onboarding;

- sessions;

- capabilities;

- RLS;

- audit.

O PR13 deve provar primeiro a integração base do Better Auth no Worker. Um Gate Auth após esse PR bloqueia Google, senha e features tenant até a criação, leitura e revogação de sessão estarem comprovadas. Cloudflare Access será provado junto da fase Admin, não no Gate Foundation.

## Fase 3 — Catalog and inventory



Implementar:



- categories;

- products;

- variants;

- SKU;

- inventory balance;

- movement ledger;

- weighted average;

- archive/delete;

- images.



## Fase 4 — Customers and sales



Implementar:



- customers;

- sale;

- items;

- payment snapshot;

- adjustments;

- cancel;

- return;

- customer reconciliation.



Primeiro online.



## Fase 5 — Offline



Adicionar:



- devices;

- offline grants;

- local collections;

- command outbox;

- sync push/pull;

- change log;

- conflict UX.



## Fase 6 — Expenses and analytics



Implementar:



- expenses;

- categories;

- recurrence;

- sale-linked costs;

- results;

- dashboard;

- metrics quality;

- goals.



## Fase 7 — Billing and entitlements



Implementar:



- Free/Pro;

- trial;

- Asaas;

- Woovi;

- entitlements;

- downgrade;

- over-limit;

- grace;

- refund/chargeback;

- cycles.



## Fase 8 — Public catalog



Implementar:



- catalog profile;

- publishing;

- selective public media;

- TanStack Start app;

- Pro entitlement.



## Fase 9 — Admin



Implementar:





- platform_owner;

- diagnostics;

- JIT;

- billing commands;

- grants;

- privacy cases;

- incidents.



## Fase 10 — Operational hardening



Implementar/provar:



- queues;

- DLQ;

- Workflows;

- scheduled jobs;

- evlog;

- alerts;

- backups;

- restore;

- staging;

- production release process.



---



# 134. Invariantes não negociáveis



Durante implementação, qualquer PR que viole uma destas regras deve ser tratado como regressão arquitetural:



1. nenhum saldo de estoque negativo;

2. venda econômica confirmada não é editável;

3. cancelamentos/devoluções são compensatórios;

4. money autoritativo não usa JS `number`;

5. runtime tenant não usa BYPASSRLS;

6. `organizationId` do cliente nunca é autoridade;

7. todo command offline é idempotente;

8. pending offline não equivale a venda confirmada;

9. senha/reset/suspensão conseguem invalidar offline authorization;

10. domínio não importa infraestrutura;

11. Better Auth não é tenancy;

12. billing provider não é fonte de entitlement;

13. webhook não muda entitlement sem reconciliação;

14. admin não impersona cliente;

15. R2 tenant permanece privado por padrão;

16. dados não são apagados apenas da DB deixando assets órfãos;

17. restore reaplica deletion ledger;

18. downgrade não apaga dados nem concede capacidade paga ilimitada;

19. logs não carregam secrets/PII desnecessária;

20. migrations Production são SQL versionado e deliberado;

21. PWA antiga deve conseguir terminar trabalho válido;

22. Queue duplicate é comportamento esperado;

23. Workflows não substituem estado PostgreSQL;

24. dashboards não fingem precisão que os dados não permitem.



---



# 135. Hipóteses comerciais — não invariantes arquiteturais



Estas decisões são apropriadas para lançamento, mas devem ser tratadas como parâmetros revisáveis:



```text

Free forever

7-day Pro trial

R$24,90 mensal

R$124,50 semestral

R$249 anual

50 variantes Free

2.000 variantes Pro

1 imagem/produto Free

10 imagens/produto Pro

50 imagens totais Free

5.000 imagens totais Pro

1 meta Free

3 metas Pro

30 dias de recuperação de organização

7 dias de adequação Free Over Limit

30 dias de retroatividade de venda

50 variantes por produto

```



Modificar esses números **não deve exigir refatoração do domínio**.



---



# 136. Pontos deliberadamente adiados



Depois da V1:



- colaboradores;

- múltiplas organizations por usuário na UX;

- mais tenant roles;

- IA;

- plano IA;

- APIs externas;

- native mobile;

- barcode;

- payment split;

- customer merge avançado;

- suppliers;

- contas a pagar;

- contas a receber;

- reconciliation;

- multi-currency;

- fractional inventory;

- complex exchanges;

- marketplace;

- fiscal ERP;

- automated tax;

- public APIs;

- PowerSync/Electric/Zero se colaboração justificar;

- observability backend externo se Cloudflare se tornar insuficiente;

- mais platform roles quando houver equipe.



---



# 137. Arquitetura resultante em uma frase



O novo Polaris será um **modular monolith TypeScript, React/Vite e Cloudflare-native, com PostgreSQL/Neon protegido por RLS, domínio independente de infraestrutura, API Hono + oRPC, operação offline baseada em comandos idempotentes e change-log próprio, economia de vendas imutável, billing normalizado multi-provider e forte separação entre dados tenant, plataforma, observabilidade e privacidade**.



---



# 138. Critério para começar a desenvolver features

O scaffold não deve saltar diretamente para telas de produto. Os gates agora têm fronteiras explícitas:

## Gate Foundation — fim da Fase 1

Antes de declarar a fundação técnica comprovada:

- CI e boundaries do monorepo;
- React/Vite + Worker + Hono/oRPC;
- PostgreSQL 18 + Drizzle + Hyperdrive + RLS comprovados remotamente;
- migrations replayáveis e testes PostgreSQL/Worker;
- POC de persistência offline aprovado ou alternativa escolhida.

## Gate Auth — após PR13

Antes de Google, senha e fluxos tenant, provar a integração base do Better Auth no Worker, incluindo criação, leitura e revogação de sessão.

## Gate 2 — fim da Fase 2

Antes de catálogo, inventário, clientes e vendas, provar organization context, capabilities, RLS e uma procedure tenant real.

Preview/PR, Staging e logging operacional completo são gates de release/hardening nas fases correspondentes; não são critérios para declarar a fundação técnica local comprovada.

Essa ordem mantém os riscos de RLS via Hyperdrive e persistência offline como gates de infraestrutura, sem misturá-los com as decisões de identidade. Os módulos de produto começam depois que a autenticação e o isolamento tenant também estiverem comprovados.