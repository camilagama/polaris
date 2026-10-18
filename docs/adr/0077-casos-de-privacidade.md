---
status: accepted
---

# Casos de privacidade: o fluxo interno de um pedido sobre dado pessoal

## Contexto

Pessoas (e donos de organização) pedem acesso, correção, exclusão, portabilidade ou oposição sobre dado pessoal. O PR103 do plano pede um fluxo interno com etapas: pedido, verificação de identidade, determinação do papel, escopo, decisão, execução e resolução. As regras de privacidade já dizem o essencial: o Polaris é **controlador** dos dados de conta, autenticação, assinatura, segurança e suporte e, em geral, **operador** dos clientes cadastrados pelo revendedor; o pedido sobre esses clientes é, normalmente, do revendedor, e **não se apaga dado de tenant porque um terceiro sem autoridade escreveu ao Polaris** ([privacidade](../business-rules/privacy.md)). O Admin já tem casos de suporte, com um tipo `privacy` e uma capacidade `privacy_case:manage` que ainda não fazia nada (ADR 0070 e 0072).

## Decisão

- **Um caso de privacidade é um caso de suporte do tipo `privacy` mais um registro do fluxo.** Ele nasce numa só operação (`admin_open_privacy_case`), que cria os dois e audita; as funções genéricas de suporte **recusam abrir e fechar** um caso desse tipo (`privacy_case_workflow_required`), porque ele só termina pela resolução do fluxo. O caso continua a ser de uma organização (a que o pedido envolve), o que permite o acesso temporário de leitura do ADR 0072 quando for preciso conferir o escopo.
- **O registro não guarda dado pessoal.** Só códigos (tipo do pedido, quem pede, canal, método de verificação, papel, categorias de dado, decisão, motivo, ação), uma referência opaca ao titular (por exemplo, o UUID de um cliente), uma nota curta (até 500 caracteres, sem caracteres de controle) e as datas. Nome, email, documento ou valor de registro não entram; um documento, se examinado, é visto fora do Polaris e nunca guardado. A auditoria guarda só os códigos do passo, nunca a nota.
- **Etapas em ordem, uma de cada vez** (`@polaris/domain/admin/privacy-case`; a função confere e o gatilho da tabela só aceita o passo seguinte, ou a ação que mantém o caso em `executed`, ou a resolução direta de uma recusa ou de um encaminhamento): `requested` → `identity_checked` (verificada ou falhou, e o método) → `role_determined` (controlador ou operador) → `scoped` (categorias de dado, sem repetir, e a referência opaca) → `decided` (aceitar, aceitar em parte, recusar, encaminhar ao controlador, com motivo) → `executed` (uma ou mais ações registradas, só em UUID do registro alcançado) → `resolved`. Um passo fora de ordem é um conflito; um passo gravado não muda; um caso resolvido é final. Cada passo escreve a auditoria administrativa na mesma transação (`privacy_case.stage_recorded` e `privacy_case.action_recorded`).
- **O que o caso não deixa decidir** (função e CHECK da tabela, as duas coisas, e o domínio TypeScript como especificação, com um teste de paridade no gate que percorre todas as combinações): se a identidade falhou, só se pode recusar, com o motivo `identity_not_verified` (e esse motivo só vale para identidade que falhou, qualquer que seja a decisão); **o Polaris, como operador, não aceita por conta própria** um pedido de dado que só processa, a não ser que quem pede seja o dono da organização (a quem os dados pertencem); encaminhar ao controlador só faz sentido quando o Polaris é o operador; toda decisão que não seja aceitar sem ressalva (recusar, aceitar em parte, encaminhar) tem motivo. Uma recusa não tem o que executar; um encaminhamento pode ser resolvido sem execução; uma aceitação só é resolvida depois de ao menos uma ação. **O que se registra como feito combina com a decisão**: um encaminhamento é cumprido avisando o controlador (ou nada a fazer), e uma aceitação é cumprida **fazendo algo**: nem "encaminhando" nem "nada a fazer" (se o dado já tinha sido apagado antes, o caso é recusado com o motivo, ou a ação é `other`, descrita na resolução).
- **Resolver fecha o caso de suporte**, revoga o acesso temporário que foi dado a ele e registra o fechamento, na mesma transação. As ações que o Admin registra (anonimização de cliente, encerramento de organização, entrega de exportação, agendamento de purge, encaminhamento ao revendedor) são **registro** do que foi feito pelos comandos próprios (ADR 0074 e 0075; exportação e purge ainda virão), não uma segunda via de executá-los: o Admin continua sem alterar dado de tenant.
- **Prazo.** Cada caso guarda o momento em que o pedido chegou (por padrão, agora; nunca no futuro, e não mais de um ano atrás: um pedido recebido por outro canal pode ser lançado com atraso, mas não com mais de um ano) e o prazo de resposta, contado dali: **15 dias, provisório** (constante `PRIVACY_CASE_RESPONSE_DAYS`, 1 a 90 no banco). Prazos legais exigem revisão jurídica antes do go-live; o caso guarda o próprio vencimento, então mudar o número só afeta casos novos. Um caso aberto depois do vencimento aparece como atrasado.
- **API do Admin** (`privacy_case:manage`, operador sempre o do login, nunca do corpo): abrir, listar (abertos, fechados, atrasados), ler (com as ações e a trilha) e um `POST` por etapa. O banco é a autoridade; o domínio normaliza as entradas e é a especificação executável das regras.

## Consequências

- Um pedido de privacidade passa a ter dono, prazo, etapas e trilha, sem copiar o dado pessoal para outro lugar.
- O papel do Polaris (controlador ou operador) é uma etapa explícita, e a regra "não apagar dado de tenant por pedido de terceiro" deixa de depender de memória **depois de o operador determinar o papel**: o banco recusa a aceitação por conta própria de dado que o Polaris só processa (o papel, porém, é uma escolha do operador: ver os limites).
- Os comandos que executam (anonimizar, encerrar) continuam sendo os do produto, com a autoridade do dono da organização.

## Limites aceitos

- **O papel é escolhido pelo operador e o banco não o liga ao escopo.** Um caso com escopo só de clientes e papel "controlador", pedido por um titular, pode ser aceito: o banco impõe as consequências do papel declarado, não a verdade dele. A trilha mostra quem o declarou.
- **O motivo de abertura do caso (`support_cases.reason`) também é texto livre** (até 500 caracteres) e aparece nas listas e nos detalhes, como a nota. Os caracteres de controle são barrados na API e, para a nota e a nota de decisão, também no banco.
- **A matriz de paridade do gate passa pelas funções**: o CHECK da tabela sozinho (escrita direta) é provado pelas sondas de SQL direto, não pela matriz.
- **A referência ao titular é um identificador opaco** (letras, números, `-` e `_`, até 64; o banco recusa espaço, `@` e pontuação), mas continua texto livre dentro desse alfabeto: nada impede um nome sem espaço. O mesmo vale para a nota de decisão e para a resolução (curtas, sem caracteres de controle, nunca na auditoria nem nos logs).
- Um caso de privacidade aberto **antes** deste fluxo (sem registro do fluxo) ainda pode ser fechado pela função genérica; casos novos só fecham pela resolução.
- **Risco para o purge (PR107):** os registros de privacidade (e o caso de suporte) têm chave estrangeira restritiva para a organização e as tabelas forçam RLS sem política para o papel de purge. O purge precisa tratá-las: elas são evidência do atendimento e devem sobreviver à organização, sem dado pessoal.
- Não há tela do Admin ainda (só a API), nem aviso ao titular, nem contato guardado: o operador conversa com quem pede fora do sistema, e o que for pessoal não entra no caso.
- Um caso é sempre de uma organização. Um pedido sobre a conta de alguém que não tem organização (conta sem organização) não cabe neste fluxo hoje.
- O prazo de 15 dias é provisório e não há lembrete: só a marca de atraso e a lista de casos atrasados.
- O banco não consegue provar que a identidade foi de fato verificada, nem que a ação registrada aconteceu: é o registro do operador, com a trilha. A execução real é verificável nos comandos próprios (auditoria do tenant).
- Só o papel `platform_owner` existe, e ele tem a capacidade de privacidade; não há segunda pessoa que aprove uma recusa.
- O texto da nota é livre (curto): nada impede o operador de digitar dado pessoal nela. A regra está escrita para o operador, e a nota nunca vai para a auditoria nem para logs.

## Alternativas rejeitadas

- **Uma tabela de eventos genérica em vez de um registro com etapas:** não impede pular etapa nem decidir contra o papel, que é o ponto do fluxo.
- **Guardar os dados do solicitante para contato:** cria um novo repositório de dado pessoal só para atender o pedido sobre dado pessoal.
- **Deixar o Admin executar a anonimização ou o encerramento direto:** abriria uma segunda via de alterar dado de tenant sem a autoridade do dono; hoje o Admin só lê com acesso temporário e registra.
- **Manter o caso de privacidade aberto e fechado pelas funções genéricas:** um caso poderia ser fechado sem decisão nem trilha.
