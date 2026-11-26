# Atendimento: pedido de vaga

**Gatilho:** o dono de uma loja no limite do plano (no Free, 50 variantes somando a loja inteira; é o limite do plano, à parte do teto de 50 por produto de [products](../business-rules/products.md)) pede ao suporte que "libere uma vaga". A regra está em [platform-admin](../business-rules/platform-admin.md): o suporte nunca arquiva, exclui ou edita produto da loja para abrir vaga, e ninguém mexe no banco para isso.

**Por quê:** arquivar e editar mudam o catálogo sem o dono saber; excluir não tem volta e deixa o SKU reservado. Feitos pelo suporte, acontecem sem o conhecimento nem o consentimento dele.

**Acesso:** o diagnóstico da organização (`organization:diagnose`) mostra só contagens, e quem atende não precisa de acesso a dados da loja. Só a liberação temporária pede a capacidade `billing:operate` e um caso de suporte aberto da organização.

## Passo a passo

1. **O dono pede a vaga.** Confirme a loja e o plano (diagnóstico da organização: só contagens e uso contra os limites). Não peça nem aceite que ele diga qual produto sumir.
2. **No Free, a saída é do próprio dono.** Ele exclui os produtos arquivados que escolher, ou assina o Pro. O caminho no app: aba Arquivados de Produtos, menu "Mais ações" do produto, "Excluir…", e digitar o nome do produto para confirmar. Só se exclui produto **arquivado e sem estoque** (com estoque, a tela manda zerar na baixa ou na contagem, e o Estoque ajusta arquivado); produto ativo não tem Excluir, e o servidor também o recusa. Arquivado continua contando no limite até ser excluído, excluir não tem volta e o SKU fica reservado; as vendas antigas continuam no histórico. Há um teto de 50 exclusões por hora por loja; passando dele, a tela diz a hora em que tentar de novo. Oriente o dono a esse caminho e a escolher ele mesmo o que excluir (decisão do usuário de 12/11). Se isso não resolve e o caso justifica, passe ao passo 3 ou leve ao responsável pelo projeto (Escalonamento). Nunca resolva por ele.
3. **Se o caso justificar,** use a liberação temporária: abra o caso de suporte da organização e dê, no painel "Plano e cobrança", o limite maior de variantes (`variants.active.max`), com prazo curto e motivo claro (por exemplo, a conclusão de uma importação que o dono acompanha). A concessão só eleva o limite, expira sozinha, fica auditada e não muda a cobrança ([ADR 0073](../adr/0073-admin-suspensao-e-comandos-de-cobranca.md)). Feche o caso quando terminar.
4. **Nunca** arquive, exclua ou edite produto da loja por ele, nem peça a alguém que o faça no banco, mesmo com o pedido do dono por escrito. Se o dono insiste em que o suporte faça, a resposta é o passo 2.

## Verificação

- O Admin continua sem caminho que mexa em produto: `apps/admin/src/product-confinement.test.ts` reprova o contrário.
- A liberação aparece na auditoria do caso, com operador, motivo e prazo.

## Escalonamento

Pedido fora desses passos (por exemplo, ato sobre produto pedido por uma autoridade) não se resolve no atendimento: leve ao responsável pelo projeto.
