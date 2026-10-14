---
status: accepted
---

# Perfil de pagamento na venda sem conexão

## Contexto

O ADR 0046 fez a venda funcionar sem conexão, mas sem perfil de pagamento: o comando de venda do aparelho não o carregava, então toda venda de cartão feita sem rede ficava com taxas e prazo "desconhecidos" no registro, e a venda é um retrato econômico que não se corrige depois (só por cancelamento ou devolução). Para uma loja que vende muito no cartão, isso é perda permanente de informação.

## Decisão

- **O comando carrega o perfil, por id e pela versão que a pessoa viu.** O `sale.confirm` do aparelho ganhou `paymentProfile` opcional (`{ id, expectedVersion }`); ausente ou nulo é o que sempre foi (método de pagamento puro). O contrato só cresce, o servidor sobe antes do app (ADR 0042), e o arquivo dourado dos payloads só ganhou um caso novo: os payloads antigos seguem aceitos sem mudança.
- **O servidor continua a autoridade.** Ele confirma a venda com a mesma `confirmSale` e o mesmo instantâneo do perfil de sempre. Se a versão informada não é a atual, ou o perfil foi arquivado ou não existe, recusa a venda inteira (`payment_profile_changed` ou `payment_profile_unavailable`), sem venda, pagamento nem movimento de estoque: as taxas e o prazo que a pessoa viu não seriam os registrados.
- **Os perfis são os da última vez com conexão.** A tela de venda guarda no navegador a lista de perfis ativos que leu com conexão (só com o runtime ligado) e a oferece sem rede, com a versão de cada um. É conforto de tela, não prova de nada (o servidor confere a versão), validada pelo contrato ao ler e apagada junto com a cópia das organizações quando a sessão termina (sair ou "não autenticado", ADR 0047). A escolha de perfil da pessoa fica a mesma nos dois modos; o "sem perfil" forçado do ADR 0046 deixou de existir.
- **Recusa por perfil tem saída própria em Pendências.** O que a recusa diz é "o perfil mudou/sumiu", nada mais está errado na venda: o painel oferece **Reenviar sem perfil de pagamento** (novo comando com o mesmo conteúdo, instante e evidência, sem perfil; taxas e prazo ficam desconhecidos, nunca zero) ou descartar. Reenviar sem perfil só é aceito para essas duas recusas.
- **A venda travada pode ir ao aparelho também com perfil.** O comando do aparelho agora carrega o perfil, então a condição de elegibilidade do ADR 0046 ficou só "sem data digitada e com um instante único"; o servidor reconhece o mesmo ID, conteúdo **e seleção de perfil**.
- **Provas.** Testes de unidade do contrato do manipulador (aceita e recusa formas do perfil, repassa à `confirmSale`, nomeia as duas recusas), da venda guardada com perfil e sem ele (a forma antiga não muda), do reenvio sem perfil, do painel de atenção, do cache; o arquivo dourado; cenários de navegador (perfil oferecido sem rede, venda guardada com ele e aceita pelo servidor; perfil mudado no servidor, venda recusada à vista); e no banco real (gate `offline-sale`, passos 1c a 1e, e `offline-e2e`): a venda com perfil é confirmada e registra o perfil e a versão; versão antiga, perfil arquivado ou inexistente são recusados sem rastro e a mesma venda sem perfil como comando novo é confirmada; a venda enviada direto e depois pelo aparelho com o mesmo perfil é a mesma venda.

## Consequências

- Vendas de cartão feitas sem rede passam a ter taxas e prazo registrados quando o perfil não mudou entre a última conexão e a sincronização; quando mudou, a recusa é visível e o custo é uma ação da pessoa em Pendências, nunca um dado errado gravado em silêncio.
- A lista de perfis no navegador contém taxas do negócio (não dado pessoal); fica no mesmo armazenamento e com a mesma regra de limpeza das organizações guardadas.
- A lista guardada não tem validade: a tela diz que é a da última vez com conexão, mas não a data. Uma lista antiga só produz, no pior caso, uma recusa visível por versão no servidor.
- Só a leitura mais recente dos perfis vale (uma resposta atrasada de antes de a conexão cair não troca a lista do aparelho nem a reescreve), e nada é gravado no navegador depois de o "Sair" começar.
- A versão do perfil no contrato tem o limite da coluna do banco (inteiro): um valor maior seria um erro de banco repetido para sempre, e passa a ser recusado como payload inválido, assim como dados de taxa corrompidos no banco.
- Quem fica muito tempo sem conexão e vende com um perfil que mudou terá a venda recusada ao sincronizar; a tela avisa antes de guardar que o perfil é o da última conexão.

## Alternativas rejeitadas

- **Tornar os perfis uma coleção local sincronizada pelo log de mudanças:** exige migration e gatilhos de banco novos; a leitura já existente com conexão serve, e a versão enviada protege o servidor.
- **O servidor aplicar a versão atual do perfil em vez de recusar:** a pessoa fecharia a venda com um preço de cartão e o registro diria outro; recusar e deixar a pessoa decidir é mais honesto.
- **Reenviar com o perfil atual automaticamente:** o aparelho não tem o perfil atual; sem perfil é a única opção que ele pode oferecer sem inventar dados.
