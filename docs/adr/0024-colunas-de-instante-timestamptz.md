---
status: accepted
---

# Colunas de instante em `timestamptz`, com leitura e escrita em UTC

## Contexto

O doc inicial manda guardar instantes em UTC com `timestamptz`. As migrations criadas até o checkpoint do Gate 4 usam `timestamp` **sem fuso** em todas as colunas de instante (cerca de cinquenta definições no schema), com `DEFAULT now()` ou `clock_timestamp()` e valores gravados em UTC pela aplicação. Com `timestamp` sem fuso, o significado do valor depende do `TimeZone` da sessão: `now()` e `clock_timestamp()` convertem para o fuso da sessão antes de gravar, e a leitura direta (por exemplo, com o driver `pg`) interpreta o valor no fuso da máquina. Se o fuso da sessão ou da role mudar (Hyperdrive, nova role, nova região), os instantes defasam em silêncio. Isso já apareceu na prática, num gate, e foi contornado lendo com `AT TIME ZONE 'UTC'`. O ledger de estoque e as vendas são evidência imutável, então o erro não pode ser corrigido depois sem reescrever evidência. A revisão do checkpoint Gate 4 notou que migrar agora é barato, porque ainda não há dados reais.

## Decisão

Decidido na revisão do checkpoint Gate 4 (13/10/2026):

- **Todas as colunas de instante migram para `timestamptz`** numa nova migration (decisão D-3), convertendo os valores existentes com `AT TIME ZONE 'UTC'`, já que foram gravados em UTC.
- **Leitura e escrita sempre em UTC.** A aplicação trata e serializa instantes em UTC; o fuso da organização é usado apenas para interpretar datas de negócio ([time-and-dates.md](../business-rules/time-and-dates.md)), nunca para armazenar instantes. Datas de negócio continuam em colunas `date` (por exemplo, `occurred_on`), sem relação com este tipo.
- **Defesa em profundidade.** O fuso da sessão das roles da aplicação é fixado em UTC (`TimeZone`), e o gate de banco exercita uma sessão com fuso diferente de UTC para provar que os instantes não mudam.
- **Mapeamento no código.** As definições do schema usam o tipo com fuso, e o contrato de transporte continua serializando instantes ISO 8601 em UTC.

Estado de implementação: a migration e as mudanças de schema são feitas por outros agentes em paralelo e devem ser verificadas no código antes de serem tratadas como vigentes.

## Consequências

- Os instantes deixam de depender do fuso da sessão, o que remove uma classe inteira de defasagem silenciosa.
- A conversão reescreve tabelas e exige bloqueio exclusivo enquanto roda; como não há dados reais, o custo é desprezível agora e seria alto depois. As tabelas imutáveis (ledger, vendas) são convertidas pelo dono da tabela, sem passar pelas permissões do runtime.
- O gate de banco ganha um cenário de fuso e as migrations são reaplicadas do zero; o `db:generate` não pode mostrar drift depois da mudança.
- Qualquer coluna futura de instante usa `timestamptz`; a revisão de migrations deve recusar `timestamp` sem fuso.

## Alternativas consideradas

- **Manter `timestamp` e fixar `TimeZone = 'UTC'` por role.** Resolve o sintoma, mas deixa o significado do valor fora do tipo; uma sessão sem a configuração volta a defasar.
- **Migrar mais tarde.** Mais caro: reescrita de tabelas com dados reais e evidência imutável.
- **Guardar o instante como texto ou inteiro.** Perde comparação, intervalos e funções de tempo do PostgreSQL.
