# Runbooks

Runbooks descrevem procedimentos operacionais repetíveis, não decisões de produto ou arquitetura.

A fundação atual não provisiona recursos de produção nem dados de clientes reais. Os recursos descartáveis do gate RLS/Hyperdrive estão documentados em [RLS and Hyperdrive gate](./rls-hyperdrive-gate.md). Adicione um runbook junto da primeira implementação de outras operações repetíveis, como deploy de staging, backup, restore, purge de privacidade ou resposta a incidente.

Para configurar a proteção das rotas de autenticação, consulte [Auth abuse protection](./auth-abuse-protection.md).

Para operar o staging e a reconciliação de mídia privada, consulte [Media storage reconciliation](./media-storage-reconciliation.md).

Antes de qualquer comando Cloudflare ou Neon, siga [CLI profile policy](./cli-profile-policy.md) para confirmar a identidade autorizada.

Cada runbook deve registrar gatilho, pré-requisitos de acesso, alvo seguro, passos, verificação, rollback ou forward-fix e responsável por escalonamento. Não documente ação de produção como comando executável antes de testá-la em ambiente descartável ou staging.
