# Tempo e datas

- Cada organização tem um timezone IANA próprio, confirmado durante o onboarding.
- Instantes técnicos usam UTC. Datas de negócio são interpretadas no timezone da organização.
- Uma venda distingue momento comercial, registro local e confirmação do servidor; o relógio do servidor é a autoridade da confirmação.
- Venda retroativa é limitada a 30 dias de calendário para o owner na V1 (a data local de 30 dias atrás ainda vale), contados no timezone da organização; papel desconhecido recebe 0 dias. Data futura além de 5 minutos do relógio do servidor é rejeitada (tolerância para diferença de relógio do dispositivo). A data comercial (`occurred_on`) é a data do momento comercial no calendário da organização e é a data dos movimentos de estoque da venda. A evidência local (`recorded_at`) não decide nenhuma regra.
