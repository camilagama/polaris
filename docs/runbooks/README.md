# Runbooks

Runbooks descrevem procedimentos operacionais repetíveis, não decisões de produto ou arquitetura.

A fundação atual não provisiona recursos de produção nem dados de clientes reais. Os recursos descartáveis do gate RLS/Hyperdrive estão documentados em [RLS and Hyperdrive gate](./rls-hyperdrive-gate.md). Adicione um runbook junto da primeira implementação de outras operações repetíveis, como deploy de staging, backup, restore, purge de privacidade ou resposta a incidente.

Cada runbook deve registrar gatilho, pré-requisitos de acesso, alvo seguro, passos, verificação, rollback ou forward-fix e responsável por escalonamento. Não documente ação de produção como comando executável antes de testá-la em ambiente descartável ou staging.
