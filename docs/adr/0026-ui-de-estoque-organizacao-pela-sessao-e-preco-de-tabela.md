---
status: accepted
---

# UI de estoque e organização pela sessão agora; preço de tabela por variante no PR50

## Contexto

Na revisão do checkpoint Gate 4 ficou claro que, pela interface, ainda não é possível vender de ponta a ponta: nenhuma tela chama recebimento, contagem ou baixa de estoque (a tela de produtos diz que o estoque "será definido em uma etapa própria"), e sem saldo a venda é bloqueada. A organização usada por todas as telas vem de `localStorage` (`polaris.organizationId`), gravado só pelo onboarding, em vez de ser resolvida a partir da sessão. O plano não tem nenhum PR de UI de estoque, e o E2E do PR125 depende de telas que nenhum PR cria. Além disso, o operador digita o preço de tabela e o preço cobrado em cada item da venda, porque variante e produto não têm preço; o plano de offline (PR55 a PR57) pressupõe `listedUnitPrice` e `catalogVersion`.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **D-7: UI de estoque e resolução da organização pela sessão entram agora, antes do Gate 5.** São etapas de fundação de produto: telas de recebimento, contagem e baixa (consumindo os commands existentes, sem mudar o domínio), leitura de saldo, histórico por variante, e uma navegação coerente com um único shell de aplicação (ver [DESIGN.md](../../DESIGN.md)). A organização passa a ser resolvida pelo servidor a partir da sessão autenticada pela RPC `organization.listMine`, que lista as organizações das quais o usuário tem membership ativo; o identificador no navegador continua sendo apenas contexto solicitado, e o servidor reautoriza cada operação ([ADR 0004](0004-separar-autenticacao-de-tenancy.md)).
- **A interface de login continua pré-go-live**, como definido no plano. Enquanto ela não existir, a organização é resolvida pela sessão existente (Better Auth) e não por um valor digitado.
- **D-6: preço de tabela por variante não entra agora.** Ele entra no **PR50** (coleções locais e catálogo offline) como **coluna opcional na variante**, porque impacta o contrato do catálogo offline e a base do `listedUnitPrice` das vendas offline. Até lá, o formulário de venda lembra **localmente** o último preço usado por variante. Essa lembrança é conveniência de interface, escopada por usuário e organização e limpa no logout ([ADR 0015](0015-offline-persistence-tanstack-db-opfs-indexeddb.md)); nunca é fato econômico e não substitui o preço informado no comando da venda. O preço informado no comando continua sendo a única fonte do preço do item.

Estado de implementação: as telas de estoque e a RPC `organization.listMine` são trabalho de outros agentes em paralelo; verifique no código antes de tratar como vigente.

## Consequências

- A venda passa a ser exercitável de ponta a ponta pela interface, e as telas de estoque dão base ao E2E do plano.
- Um shell de aplicação único elimina a duplicação das barras de navegação copiadas por página e corrige a navegação incoerente (a rota inicial abre Categorias, e há uma tela que pede um UUID digitado).
- O catálogo continua sem preço até o PR50: o fluxo de venda segue lento para uso diário, e o preço lembrado localmente mitiga isso sem decidir o modelo de preço. A coluna opcional na variante será desenhada junto com `catalogVersion`.
- Mudar a resolução da organização exige que o servidor trate o caso de várias organizações (modelo permite), embora o onboarding V1 crie uma só.

## Alternativas consideradas

- **Introduzir a UI de estoque só dentro da Fase 5.** Adia a primeira venda real pela interface e mistura trabalho offline com trabalho de produto online.
- **Preço de tabela na variante agora.** Resolve o fluxo de venda, mas fixa um modelo de preço antes de decidir o contrato offline; o PR50 é o ponto natural.
- **Manter a organização em `localStorage`.** Funciona só para quem passou pelo onboarding neste navegador e confunde contexto solicitado com identidade.
