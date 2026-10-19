# Polaris — visão do produto

## Propósito

O Polaris é um ERP operacional enxuto para pequenos revendedores que hoje dependem de planilhas, anotações e ferramentas fragmentadas. A primeira prioridade é registrar catálogo, estoque, vendas, clientes, despesas e resultado estimado com confiança.

## Escopo planejado

A V1 está organizada em etapas:

1. **Operação online:** catálogo e variantes, estoque, clientes, vendas, cancelamentos e devoluções parciais.
2. **Núcleo offline:** consulta e comandos selecionados de catálogo, estoque, clientes e vendas, com sincronização explícita.
3. **Inteligência do negócio:** despesas, recorrências, métricas e metas.
4. **Lançamento comercial:** ofertas Free/Pro, billing e entitlements, catálogo público, Admin e fluxos de privacidade.

Ter uma aplicação ou pacote previsto na arquitetura não significa que sua funcionalidade esteja pronta.

## Princípios do produto

- Tornar as tarefas diárias simples e rápidas.
- Preservar o histórico econômico e de estoque.
- Permitir trabalho offline nas operações escolhidas.
- Proteger os dados de cada organização e coletar apenas dados necessários.
- Apresentar resultados como estimativas quando taxas ou custos estiverem incompletos.

## Fora do escopo inicial

O Polaris não é um ERP contábil ou fiscal completo. A V1 não inclui gestão estruturada de fornecedores, contas a pagar/receber, conciliação bancária, estoque fracionário, multi-moeda, código de barras, aplicativo nativo, API pública, marketplace, CRM completo ou automações de IA.

## Hipóteses comerciais iniciais

Os itens abaixo são hipóteses ajustáveis, não invariantes arquiteturais:

- ofertas Free e Pro;
- trial Pro de sete dias, iniciado somente por escolha do usuário e após o método de renovação estar pronto;
- preços iniciais Pro de R$ 24,90 por mês, R$ 124,50 por semestre (temporariamente não ofertado: desativado no banco, volta por decisão e migration) e R$ 249,00 por ano;
- limites iniciais Free: 50 variantes ativas, uma imagem por produto, 50 imagens ativas, uma meta ativa e sem escrita offline ou catálogo público;
- limites iniciais Pro: 2.000 variantes ativas, dez imagens por produto, 5.000 imagens ativas, três metas ativas, escrita offline e catálogo público.

As regras de downgrade e enforcement ficam em [billing-and-entitlements.md](docs/business-rules/billing-and-entitlements.md).

## Autoridade

Este documento é a fonte de verdade para público, objetivos, escopo, não-objetivos e hipóteses comerciais. Terminologia está em CONTEXT.md, direção visual em DESIGN.md e invariantes em docs/business-rules/.
