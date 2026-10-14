# Tempo e datas

- Cada organização tem um timezone IANA próprio, confirmado durante o onboarding.
- Instantes técnicos usam UTC. Datas de negócio são interpretadas no timezone da organização.
- Uma venda distingue momento comercial, registro local e confirmação do servidor; o relógio do servidor é a autoridade da confirmação.
- Venda retroativa é limitada a aproximadamente 30 dias para owner na V1. Data futura além de uma tolerância pequena é rejeitada; a tolerância precisa ser concretizada no PR que implementar a regra.
