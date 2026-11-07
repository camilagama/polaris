const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Test teardown for a disposable database: deletes organizations that have audit rows. The audit of the tenant is
 * immutable and its foreign key restricts (ADR 0081, amended), so the throwaway organizations only go
 * if the audit goes first, and that takes the owner of the table turning its trigger off for the statement. Everything
 * runs in one implicit transaction (a simple query with several statements): a failure puts the trigger back.
 * Only a gate may call this, on a database it created.
 */
export async function deleteOrganizationsWithAudit(
  database: { query: (text: string) => Promise<unknown> },
  organizationIds: readonly string[]
): Promise<void> {
  if (organizationIds.length === 0) {
    return;
  }
  for (const id of organizationIds) {
    if (!OPAQUE_ID.test(id)) {
      throw new Error("teardown refuses an organization ID that is not opaque");
    }
  }
  const list = organizationIds.map((id) => `'${id}'`).join(", ");
  await database.query(
    `ALTER TABLE public.tenant_audit_event DISABLE TRIGGER tenant_audit_event_no_change;
     DELETE FROM public.tenant_audit_event WHERE organization_id IN (${list});
     DELETE FROM public.organizations WHERE id IN (${list});
     ALTER TABLE public.tenant_audit_event ENABLE ALWAYS TRIGGER tenant_audit_event_no_change;`
  );
}
