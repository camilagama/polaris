-- Hardens the SECURITY DEFINER functions of schema public (finding A2): the search_path ends in pg_temp, so the temporary-object
-- catalog is no longer a path to escalate to the owner. No function changes behavior: only its search_path (and a REVOKE from PUBLIC,
-- which was already in place).
-- The 84 functions below came from pg_proc (prosecdef) on main; the ones that already end in pg_temp (create_initial_organization,
-- record_auth_access, admin_read_auth_access_log) are left out.

-- functions owned by the migration owner (the current role)
ALTER FUNCTION public.assign_sync_change_sequence() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.bump_user_authorization_epoch(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_sync_change() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.assign_sync_change_sequence() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.bump_user_authorization_epoch(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_sync_change() FROM PUBLIC;--> statement-breakpoint

GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_audit_billing_command(uuid,uuid,text,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_cancel_organization_purge(uuid,uuid,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_close_support_case(uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_grant_tenant_access(uuid,uuid,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_list_operational_incidents(integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_list_organization_legal_holds(integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_list_privacy_cases(text,integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_list_support_cases(text,text,integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_lock_privacy_case(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_open_privacy_case(uuid,text,text,text,text,text,timestamp with time zone,text,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_open_support_case(uuid,text,text,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_organization_diagnostics(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_organizations_overview(text,integer,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_place_organization_legal_hold(uuid,uuid,text,timestamp with time zone) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_case_detail(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_action(uuid,uuid,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_decision(uuid,uuid,text,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_identity(uuid,uuid,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_role(uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_record_scope(uuid,uuid,text[],text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_privacy_resolve(uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_reactivate_organization(uuid,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_read_operational_incident(uuid,integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_record_audit(uuid,text,text,uuid,text,text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_release_organization_legal_hold(uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_require_grant(uuid,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_require_open_case(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_require_principal(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_retry_dead_letter(uuid,uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_reveal_customer_field(uuid,uuid,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_revoke_tenant_access(uuid,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_schedule_organization_purge(uuid,uuid,text,bigint) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_support_case_detail(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_suspend_organization(uuid,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.admin_tenant_customers(uuid,uuid,integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_audit_billing_command(uuid,uuid,text,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_cancel_organization_purge(uuid,uuid,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_close_support_case(uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_grant_tenant_access(uuid,uuid,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_list_operational_incidents(integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_list_organization_legal_holds(integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_list_privacy_cases(text,integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_list_support_cases(text,text,integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_lock_privacy_case(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_open_privacy_case(uuid,text,text,text,text,text,timestamp with time zone,text,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_open_support_case(uuid,text,text,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_organization_diagnostics(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_organizations_overview(text,integer,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_place_organization_legal_hold(uuid,uuid,text,timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_case_detail(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_record_action(uuid,uuid,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_record_decision(uuid,uuid,text,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_record_identity(uuid,uuid,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_record_role(uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_record_scope(uuid,uuid,text[],text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_privacy_resolve(uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_reactivate_organization(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_read_operational_incident(uuid,integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_record_audit(uuid,text,text,uuid,text,text,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_release_organization_legal_hold(uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_require_grant(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_require_open_case(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_require_principal(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_retry_dead_letter(uuid,uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_reveal_customer_field(uuid,uuid,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_revoke_tenant_access(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_schedule_organization_purge(uuid,uuid,text,bigint) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_support_case_detail(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_suspend_organization(uuid,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.admin_tenant_customers(uuid,uuid,integer,uuid) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_billing_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_billing_owner;--> statement-breakpoint
ALTER FUNCTION public.organization_exceeds_free_limits(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.organization_free_limit_excess(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.organization_exceeds_free_limits(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.organization_free_limit_excess(text) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_catalog_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_catalog_owner;--> statement-breakpoint
ALTER FUNCTION public.organization_public_catalog_enabled(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_media(text,uuid,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_product(text,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_products(text,integer,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_profile(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.public_catalog_visible_organization(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.organization_public_catalog_enabled(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.public_catalog_media(text,uuid,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.public_catalog_product(text,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.public_catalog_products(text,integer,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.public_catalog_profile(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.public_catalog_visible_organization(text) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_catalog_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_media_cleanup_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_media_cleanup_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_media_storage_key_for_cleanup(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.finalize_unlinked_media_cleanup(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.guard_media_storage_key_cleanup_claim() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.list_unlinked_media_for_cleanup(integer,interval,uuid[]) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_media_storage_key_for_cleanup(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.finalize_unlinked_media_cleanup(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.guard_media_storage_key_cleanup_claim() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.list_unlinked_media_for_cleanup(integer,interval,uuid[]) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_media_cleanup_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_outbox_events(integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.claim_queue_processing(text,text,text,uuid,integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.claim_scheduled_job(text,integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.complete_queue_processing(text,text,uuid,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.complete_scheduled_job(text,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.expire_queue_processing(integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.mark_outbox_events_dispatched(uuid[],integer[]) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_billing_reference_incident(text,text,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_dead_letter(text,text,text,uuid,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_exhausted_outbox_events(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.release_outbox_events(uuid[],integer[],integer[]) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.release_queue_processing(text,text,uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.release_scheduled_job(text,uuid,boolean) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.retry_dead_letter(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_outbox_events(integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_queue_processing(text,text,text,uuid,integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_scheduled_job(text,integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.complete_queue_processing(text,text,uuid,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.complete_scheduled_job(text,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.expire_queue_processing(integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_outbox_events_dispatched(uuid[],integer[]) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_billing_reference_incident(text,text,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_dead_letter(text,text,text,uuid,text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_exhausted_outbox_events(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.release_outbox_events(uuid[],integer[],integer[]) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.release_queue_processing(text,text,uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.release_scheduled_job(text,uuid,boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.retry_dead_letter(uuid) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_data_export(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.claim_data_export_by_id(uuid,text,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.complete_data_export(uuid,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.expire_data_exports(integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.fail_data_export(uuid,text,boolean) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.finalize_expired_closures(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.list_data_exports_to_delete(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.list_organizations_in_closure() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.mark_data_export_files_deleted(uuid) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.rearm_data_export_events(integer,integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_data_export_file(uuid,integer,text,text,bigint) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.recover_organization_closure(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.request_organization_closure(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_data_export(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_data_export_by_id(uuid,text,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.complete_data_export(uuid,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.expire_data_exports(integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.fail_data_export(uuid,text,boolean) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.finalize_expired_closures(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.list_data_exports_to_delete(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.list_organizations_in_closure() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_data_export_files_deleted(uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.rearm_data_export_events(integer,integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_data_export_file(uuid,integer,text,text,bigint) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.recover_organization_closure(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.request_organization_closure(integer) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint

GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_organization_purge(integer) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.complete_organization_purge_sweep(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.entitlement_grants_no_text_after_purge() SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.list_organization_purge_media(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.mark_organization_purge_storage_touched(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.purge_organization_data(text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
ALTER FUNCTION public.record_organization_purge_failure(text,text) SET search_path = pg_catalog, public, pg_temp;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.claim_organization_purge(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.complete_organization_purge_sweep(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.entitlement_grants_no_text_after_purge() FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.list_organization_purge_media(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.mark_organization_purge_storage_touched(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.purge_organization_data(text) FROM PUBLIC;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.record_organization_purge_failure(text,text) FROM PUBLIC;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint

-- no runtime role creates temporary objects or objects in public (the owner roles create functions through SET ROLE and are not runtime roles)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

