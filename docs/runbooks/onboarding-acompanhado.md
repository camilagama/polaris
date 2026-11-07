# Onboarding acompanhado dos lojistas da validação

Procedimento da primeira importação de produtos de um lojista da validação, enquanto o app roda no plano Free dos Workers ([ADR 0043](../adr/0043-runtime-offline-no-app.md), emenda de 28/10/2026 sobre o regime do plano Free).

## Por que existe

No Free, CPU somada sustentada liga um regime em que **todas** as chamadas do Worker morrem por 4 a 26 minutos, para todas as lojas. A importação é a maior fonte dessa CPU. O app já vai devagar (uma linha a cada 7 s) e sai do caminho quando o regime liga, mas o risco de uma importação derrubar o caixa de outra loja só some com a regra abaixo, que é de operação, não de código.

## Gatilho

Um lojista da validação vai cadastrar os produtos pela planilha (Produtos → "Importar planilha").

## Pré-requisitos

- Conta e loja do lojista criadas; a pessoa acompanha a importação junto com ele (chamada ou presencial).
- Planilha em CSV, com até 500 linhas.

## Passos

1. **Importe fora do horário de vendas** das outras lojas da validação, e **uma loja por vez**: nunca duas importações ao mesmo tempo.
2. Acima de 200 linhas, divida a planilha em arquivos menores (a tela recomenda) e importe um de cada vez.
3. **Deixe a tela da importação aberta e em primeiro plano** até o resultado. No computador, uma aba escondida desacelera; no celular, o navegador suspende a página. A tela diz o tempo antes de começar (100 produtos: 15 a 30 minutos; 500: 1 a 2 horas).
4. Se a tela disser "O servidor está ocupado. A importação continua sozinha às HH:MM.", não faça nada: ela continua sozinha. Não recarregue nem tente de novo antes (tentar antes prolonga o regime).
5. **Para continuar depois de fechar a tela, abra a mesma planilha de novo.** O app não guarda a importação no aparelho: a prévia marca como "já existe" o que entrou antes, e só as linhas restantes são enviadas. O resultado diz quantas já estavam na loja.

## Verificação

- O resultado diz "Importamos N produtos." e a lista de Produtos mostra os produtos.
- Linhas "não confirmadas" no resultado: confira na lista antes de enviar de novo (reenviar é seguro: nome que existe é pulado).

## Se algo der errado

- O caixa de outra loja mostra "Ocupado" no chip durante a importação: as vendas ficam guardadas no aparelho e vão sozinhas quando o servidor volta. Pare a importação ("Parar a importação") e retome depois do horário de vendas, abrindo a mesma planilha.
- Escalonamento: avise o Arrascaeta com a hora, a loja e quantas linhas faltavam.
