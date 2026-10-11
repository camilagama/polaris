# Clientes

- Cliente é uma pessoa ou organização cadastrada pela organização revendedora. O registro pertence a uma única organização; uma venda pode existir sem cliente e este PR ainda não associa clientes a vendas.
- Nome é obrigatório e aparado. O cadastro exige pelo menos um contato: telefone ou email. Cada contato pode ficar ausente, mas não ambos; observações não contam como identificador.
- Telefone é armazenado como texto aparado, sem formato nacional obrigatório. Email é aparado e validado quando informado. Nome, telefone e email não têm unicidade rígida; registros repetidos são permitidos e não são mesclados automaticamente. A busca de possíveis duplicados fica para PR37.
- Observações são opcionais e podem conter dados pessoais. Não incluir nome, contatos ou observações em auditoria nem em logs estruturados.
- Estado é `active` ou `archived`, derivado de `archived_at`. Arquivar é reversível por restauração; listas normais mostram ativos por padrão. PR36 não oferece hard-delete.
- Atualizações e transições de estado exigem `expectedVersion`; versões antigas conflitam. Criação, alteração, archive e restore gravam auditoria na mesma transação, contendo apenas o tipo e o UUID do cliente.
- Na V1, todas as operações de leitura e escrita de clientes exigem `customer:update`: o mapa atual tem somente `owner` e ainda não define `customer:read`. Criar uma função somente leitura para outros papéis exige uma capability dedicada antes de habilitar esses papéis.
- Os campos nome, telefone, email e observações são PII fornecida pelo revendedor. Coletar apenas o necessário ao relacionamento comercial; o fluxo de anonimização por privacidade permanece fora de PR36.
