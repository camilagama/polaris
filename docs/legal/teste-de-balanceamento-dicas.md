# Teste de balanceamento: dicas para começar e estatística agregada de uso

> **Estado: rascunho, a confirmar pelo jurídico antes de ligar em produção.** Os artigos da LGPD abaixo (7º, V e IX; 9º; 10; 12; 18; 20; 33; 37) foram citados de memória no estudo de ativação de 07/11/2026 e **não foram conferidos na lei**. Este registro não cria texto legal novo: repete a decisão do usuário (legítimo interesse, 07/11/2026) e o rascunho do estudo. O texto que a pessoa lê está na Política de Privacidade (seção 11) e o que o sistema grava e envia está em [privacy.md](../business-rules/privacy.md); o desenho está no [ADR 0106](../adr/0106-avisos-de-ativacao-e-medida-de-comportamento.md).

Os campos da empresa ficam abertos, e nenhum valor é inventado aqui: `[P48: razão social]`, `[P48: e-mail do encarregado]`, `[P48: caixa de suporte de produção]`, `[P48: domínio de produção]`.

## O que este teste cobre

- **As dicas para começar:** até 3 e-mails em 14 dias, só para a dona ou o dono da primeira loja, só enquanto a loja não tem venda. Não há e-mail de boas-vindas separado.
- **A estatística agregada de uso** (item 6): contar, em números somados e em grupos de pelo menos 5 lojas, quantas lojas novas voltam ao app e quantas chegam à primeira venda, para saber se as dicas ajudam.

Base legal: **legítimo interesse** (LGPD, art. 7º, IX), **sem consentimento** e sem caixa marcada. O que muda a base (Pro, preço, plano, newsletter, pesquisa, mais de 3 e-mails, outro destinatário, abertura ou clique medidos, trilha de tela por pessoa) pede teste novo e parecer novo.

## 1. Finalidade legítima e concreta

Apoiar o uso do serviço que a pessoa acabou de criar e reduzir o abandono nos primeiros dias (art. 10, I). **Não é venda:** o texto nunca fala de Pro, preço, plano nem urgência.

## 2. Necessidade e dado mínimo

| Dado | Usado | Para quê | Onde fica |
| --- | --- | --- | --- |
| E-mail verificado do dono | sim | enviar | lido da conta só na hora do envio; nunca na fila, no log nem no aviso |
| Nome da loja | sim | o corpo do e-mail (escapado, até 24 caracteres; fora do assunto) | não é gravado no aviso |
| Dia de criação da loja; dia do primeiro produto; existe venda confirmada | sim | marcar o momento de cada e-mail, escolher o texto e parar na primeira venda | calculado a cada varredura; nada é guardado |
| Loja com teste do Pro ou Pro; loja encerrada, suspensa, em purge ou com pedido de dados aberto; loja interna; primeira loja da pessoa | sim, como sim ou não | decidir se o e-mail pode sair (regras de parada) | calculado a cada varredura e no envio; nada é guardado |
| Qual e-mail saiu, quando, e o motivo de um que não saiu | sim | não repetir e provar o que foi feito | tabela de avisos, sem endereço nem texto |
| Escolha de parar de receber | sim | respeitar o pedido | por pessoa, em todas as lojas dela |
| Código derivado do endereço (HMAC) que recusou ou reclamou | sim | não escrever de novo | dado pessoal pseudônimo; não sai com a conta |
| Datas de acesso à conta (`session`: `user_id`, `created_at`, `updated_at`) | só na contagem agregada (item 6) | contar quem volta | não é copiada nem gravada por loja |
| Conteúdo da loja, valor, cliente, estoque, nome da pessoa, CPF, CNPJ, telefone | **não** | | |
| IP, navegador, token de sessão, identificador de aparelho | **não** | | |
| Abertura ou clique do e-mail | **não** (sem imagem, sem pixel, sem redirecionamento) | | |

Só entra no envio quem é **dono ativo com e-mail verificado**: nunca e-mail digitado em formulário, convite, indicação ou membro. Cadastro por senha sem verificação não recebe.

## 3. Expectativa e impacto

- Quem abriu a conta espera ajuda nos primeiros dias; o primeiro e-mail sai 24 horas depois da criação da loja, quando a pessoa já saiu do app.
- Frequência baixa: no máximo 3 e-mails em 14 dias, entre 8h e 12h no horário de São Paulo.
- Sem oferta, sem preço personalizado e sem efeito sobre plano, acesso ou cobrança: **não há decisão automatizada com efeito significativo** (art. 20).
- Quem reclama marca um e-mail como lixo eletrônico: a série inteira entra em parada até o usuário decidir, e o endereço não recebe mais.
- Quem usa o Polaris como lojista (MEI) é, em geral, a única pessoa da loja: o dado de uso da loja é dado dessa pessoa. Por isso o item 6 só sai agregado.

## 4. Salvaguardas

- **Parar de receber** em um clique, sem entrar na conta, e nas configurações da conta. O link só mostra a página; quem grava é o envio do formulário. A resposta é a mesma exista ou não a pessoa. Vale para todas as lojas e para qualquer e-mail futuro baseado em legítimo interesse; os avisos da conta e da cobrança continuam, porque fazem parte do serviço.
- **Teto:** 3 e-mails em 14 dias; teto diário de envio; janela de validade de cada aviso.
- **Para sozinha:** a primeira venda, o pedido para parar, 14 dias, o terceiro e-mail, loja com teste do Pro ou Pro, loja encerrada, suspensa, em purge ou com pedido de dados aberto, loja interna, e-mail não verificado ou suprimido, loja que não é a primeira da pessoa, flag desligada, série em parada. A regra vale na varredura e de novo no envio.
- **Flag desligada em todos os ambientes.** Ligar depois não manda o acumulado.
- **Uma reclamação desliga a série**, e só o usuário a religa, por decisão explícita e registrada.
- **Sem rastreio de abertura nem de clique**, sem imagem, sem pixel; texto fixo; a fila leva só o ID do aviso.
- **Texto na Política**, com como parar, retenção e que a resposta ao e-mail chega à caixa de suporte (quem lê: `[P48/U7: quem lê as respostas]`).
- **Direitos do titular:** acesso (o estado das dicas aparece nas configurações da conta), oposição (o próprio parar de receber; art. 18, § 2º, de memória) e a tabela fora da exportação da loja.

## 5. Conclusão

Conclusão proposta: aprovável **para as dicas descritas acima**, a confirmar pelo jurídico antes de ligar em produção. **Reavaliar** se mudar qualquer item do resumo (mais e-mails, outro destinatário, outro dado, Pro ou preço, rastreio, retenção) ou se o jurídico preferir consentimento, caso em que a série vira opt-in e o alcance cai (decisão do usuário).

## 6. Estatística agregada de uso por legítimo interesse

- **Finalidade:** saber se as dicas ajudam a ativar, comparando coortes de lojas novas: quantas voltam ao app em até 14 dias e quantas chegam à primeira venda. A decisão que depende disto: ligar ou não a série em produção, e se o problema é o e-mail ou a tela de produto.
- **Necessidade e dado mínimo:** as datas de acesso à conta (`user_id`, `created_at` e `updated_at` da sessão), lidas por um papel próprio do banco e por função que devolve só contagens por semana de coorte. Nada de IP, navegador, token, registro de acesso do Marco Civil nem aparelho.
- **Saída só agregada, com k = 5:** célula com menos de 5 lojas não sai (nem pela soma complementar); a coorte pequena é "inconclusiva". Sem ID de pessoa nem de loja e nenhuma lista de lojas com marcos. Cinco lojas não garantem anonimato (uma célula em que as 5 voltaram diz o que cada uma fez, e o dono costuma ser a única pessoa da loja): a saída só vale como agregada enquanto a supressão valer, e a Política não promete mais que isso. **Retenção dos contadores:** 12 meses, contados do congelamento da semana (a mesma classe operacional de 12 meses já aprovada em 19/10/2026; cobre a comparação com a mesma semana do ano anterior); decisão do Arrascaeta; o usuário pode preferir mais (U3).
- **Expectativa e impacto:** a pessoa não vê nem sofre nada; ninguém é tratado de modo diferente por causa do resultado. A Política diz que as datas de acesso são usadas só em contagem somada.
- **Salvaguardas:** só agregado congelado por semana, em tabela só de acrescentar; o Admin lê só essa tabela; o gate de banco prova cada coluna proibida; nada é gravado por loja nem por pessoa; a leitura de `session` segue a retenção da sessão.
- **Limite honesto:** a contagem é um piso de "voltou" (sessão apagada ao sair e renovação de um dia subcontam), então "nunca voltou" aparece maior do que é. Por isso a série não liga só porque "nunca voltou" está alto: exige também a ativação em até 14 dias baixa.
- **Conclusão proposta:** aprovável como estatística agregada, a confirmar pelo jurídico. Se alguma saída passar a identificar uma pessoa ou uma loja, o item deixa de valer e pede teste novo.

## Pré-requisitos para ligar em produção

O jurídico confirma o legítimo interesse e os artigos citados; `[P48: razão social]`, `[P48: caixa de suporte de produção]` e `[P48: e-mail do encarregado]` preenchidos; subdomínio de envio no lugar de `[P48: domínio de produção]`; região e DPA do Resend (art. 33); rastreio de abertura e de clique desligado no domínio de envio, conferido no painel; a seção da Política publicada antes de ligar (art. 9º); o prazo de guarda das respostas na caixa de suporte (`[P48: prazo de guarda da caixa de suporte]`); quem lê as respostas (`[P48/U7: quem lê as respostas]`); o prazo de 12 meses do código de quem reclamou e dos contadores agregados (decisão do Arrascaeta, dentro dos 12 meses aprovados em 19/10/2026; o usuário decide só se quiser mais (U3)); depois do primeiro aceite real da Política, qualquer mudança nela é a versão 2, não edição da v1; e a decisão do usuário depois de 4 a 6 coortes de lojas reais.
