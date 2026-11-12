export interface OutboxPolicyRow {
  cmd: string;
  name: string;
  roles: string[];
}

export interface OutboxPolicy {
  cmd: string;
  name: string;
  roles: string;
}

export const OUTBOX_POLICIES_SQL =
  "SELECT polname::text AS name, CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE polcmd::text END AS cmd, ARRAY(SELECT rolname::text FROM pg_roles WHERE oid = ANY (polroles)) AS roles FROM pg_policy WHERE polrelid = 'public.event_outbox'::regclass";

const compareText = (left: string, right: string) => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

export const sortedOutboxPolicies = (
  rows: readonly OutboxPolicyRow[]
): OutboxPolicy[] =>
  rows
    .map((row) => ({
      cmd: row.cmd,
      name: row.name,
      roles: [...row.roles].sort(compareText).join(","),
    }))
    .sort(
      (left, right) =>
        compareText(left.cmd, right.cmd) ||
        compareText(left.roles, right.roles) ||
        compareText(left.name, right.name)
    );

export const expectedOutboxPolicies = (
  runtimeRole: string
): OutboxPolicyRow[] => [
  {
    cmd: "DELETE",
    name: "event_outbox_purge_owner_delete",
    roles: ["polaris_purge_owner"],
  },
  // the notice of the billing cycle or the welcome (ADR 0104, 0101): its own policy, proved by the gate billing-notices
  {
    cmd: "INSERT",
    name: "event_outbox_billing_runtime_insert_notice",
    roles: ["polaris_billing_runtime"],
  },
  // the notice of a tip of the activation series, in the mould of the one above: proved by the gate activation-candidates
  {
    cmd: "INSERT",
    name: "event_outbox_billing_runtime_insert_activation_notice",
    roles: ["polaris_billing_runtime"],
  },
  {
    cmd: "INSERT",
    name: "event_outbox_tenant_insert",
    roles: [runtimeRole],
  },
  // the request of a closed organization's copy (ADR 0081), the cancellation of the renewal at the closure (ADR 0074)
  // and the notice of a closure milestone (ADR 0102), through the privacy owner's functions
  {
    cmd: "INSERT",
    name: "event_outbox_privacy_owner_insert_closed",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "INSERT",
    name: "event_outbox_privacy_owner_insert_renewal_cancel",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "INSERT",
    name: "event_outbox_privacy_owner_insert_closure_notice",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "SELECT",
    name: "event_outbox_outbox_owner_select",
    roles: ["polaris_outbox_owner"],
  },
  {
    cmd: "SELECT",
    name: "event_outbox_privacy_owner_select",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "SELECT",
    name: "event_outbox_privacy_owner_select_renewal_cancel",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "SELECT",
    name: "event_outbox_purge_owner_select",
    roles: ["polaris_purge_owner"],
  },
  {
    cmd: "UPDATE",
    name: "event_outbox_outbox_owner_update",
    roles: ["polaris_outbox_owner"],
  },
  {
    cmd: "UPDATE",
    name: "event_outbox_privacy_owner_rearm",
    roles: ["polaris_privacy_owner"],
  },
  {
    cmd: "UPDATE",
    name: "event_outbox_privacy_owner_rearm_renewal_cancel",
    roles: ["polaris_privacy_owner"],
  },
];
