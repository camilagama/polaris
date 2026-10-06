# Runbooks

Runbooks descrevem procedimentos operacionais repetíveis, não decisões de produto ou arquitetura.

A fundação atual ainda não provisionou recursos de produção nem dados de clientes reais. Adicione um runbook junto da primeira implementação de uma operação repetível, como deploy de staging, migration, backup, restore, purge de privacidade ou resposta a incidente.

Cada runbook deve registrar gatilho, pré-requisitos de acesso, alvo seguro, passos, verificação, rollback ou forward-fix e responsável por escalonamento. Não documente ação de produção como comando executável antes de testá-la em ambiente descartável ou staging.
