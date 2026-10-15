---
status: accepted
---

# Capabilities finas, atribuídas somente ao papel owner na V1

## Contexto

O [ADR 0004](0004-separar-autenticacao-de-tenancy.md) fez da autorização um dado do domínio Polaris, verificado por capabilities nomeadas e não pelo papel que o cliente informa. O plano previa um mapa de capabilities por papel, mas a V1 só cria o papel `owner` no onboarding. Era preciso decidir se as operações compartilhariam poucas capabilities amplas ou teriam capabilities finas desde o início, e o que acontece com papéis que ainda não existem. A lista vigente e suas operações estão em [organization-and-access.md](../business-rules/organization-and-access.md); o mapa vive em `packages/domain/src/authorization/capabilities.ts`.

## Decisão

Registro retroativo (PR21 em diante), confirmado na revisão do checkpoint Gate 4 (13/10/2026):

- **Capabilities finas, uma por operação ou grupo coeso de operações**, em vez de um papel que implica tudo. Hoje são 15 (`catalog:read`, `product:create`, `product:update`, `inventory:read`, `inventory:adjust`, `sale:create`, `sale:read`, `sale:cancel`, `sale:return`, `sale:assign_customer`, `customer:update`, `expense:create`, `organization:manage`, `category:create`, `category:manage`).
- **Somente `owner` na V1.** O papel `owner` recebe todas as capabilities. Nenhum outro papel é criado, e o banco limita os valores atuais de papel e de status até uma migration adicionar novos.
- **Falha fechada.** Papel ou capability desconhecidos não concedem acesso. O mesmo vale para a janela retroativa de vendas por papel ([ADR 0021](0021-datas-da-venda-e-janela-retroativa.md)): papel desconhecido recebe zero dias.
- **Verificação em camadas.** A capability é verificada no procedimento e repetida no repositório, usando organização e ator da identidade autorizada, nunca valores do payload.
- **Metas.** `goal:manage` governa as metas ([ADR 0055](0055-metas.md)).
- **Resultado econômico.** `report:read` governa a leitura do resultado de um período, que expõe custo e margem ([ADR 0053](0053-motor-de-resultado-economico.md)).
- **Despesas.** `expense:create` governa todas as operações de despesas e de categorias de despesa, inclusive a leitura ([ADR 0051](0051-despesas-categorias-e-lancamentos.md)); como em clientes, não há capability de leitura separada.
- **Como acrescentar um papel.** Um novo papel exige, no mesmo pull request: um ADR que o descreva, a lista de capabilities dele, ajuste dos pontos que hoje usam uma capability como substituto de leitura (por exemplo, a leitura de clientes e de perfis de pagamento exige capabilities de escrita ou de administração, o que quebraria um papel de vendedor) e testes de cada operação para o novo papel.

## Consequências

- Criar o papel de vendedor ou de estoquista é uma mudança de mapa mais ajustes pontuais, não uma reescrita de autorização.
- Hoje só `owner` foi exercido nos testes e gates; capabilities e janela retroativa por papel não foram provadas com outro papel. A UI por papel não existe.
- Existem capabilities de leitura que ainda faltam (por exemplo, `customer:read`); elas só serão criadas junto com o papel que as usa.
- Repetir a verificação no repositório duplica código de checagem; é redundância intencional de defesa, a consolidar sem reduzir a checagem.

## Alternativas consideradas

- **Poucas capabilities amplas (`read`, `write`, `admin`).** Mais simples agora, mas obrigaria a quebrar capabilities quando surgirem papéis, com risco de conceder acesso demais por herança.
- **Autorizar pelo papel, sem capabilities.** Espalharia comparações de papel pelo código e dificultaria papéis personalizados.
- **Criar já os papéis vendedor e estoquista.** Não há requisito, UI nem testes para eles; seria especulação.
