import type { OrganizationMembershipReadModel } from "@polaris/contracts";
import { rpcErrorCode } from "./rpc-error";

export type Organization = OrganizationMembershipReadModel;

/**
 * The only thing kept in the browser is which organization was chosen last.
 * It is a preference: it is validated against the list the server returns and
 * is never proof of access (the server authorizes every request).
 */
export const PREFERRED_ORGANIZATION_KEY = "polaris.preferredOrganizationId";

/** The key older versions wrote as if it were the source of truth. */
export const LEGACY_ORGANIZATION_KEY = "polaris.organizationId";

export type PreferenceStorage = Pick<
  Storage,
  "getItem" | "removeItem" | "setItem"
>;

export function readPreferredOrganizationId(
  storage: PreferenceStorage | null
): string | null {
  try {
    return storage?.getItem(PREFERRED_ORGANIZATION_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to save; the app keeps working. */
export function writePreferredOrganizationId(
  storage: PreferenceStorage | null,
  organizationId: string
): boolean {
  try {
    storage?.setItem(PREFERRED_ORGANIZATION_KEY, organizationId);
    return storage !== null;
  } catch {
    return false;
  }
}

/** Drops the pre-session key so a stale ID can no longer be picked up. */
export function clearLegacyOrganizationId(
  storage: PreferenceStorage | null
): void {
  try {
    storage?.removeItem(LEGACY_ORGANIZATION_KEY);
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}

/** The browser storage, or null where it is blocked (private mode, policies). */
export function browserStorage(): PreferenceStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Picks the organization to work in: the preferred one when the server still
 * lists it, otherwise the first the server returned. No organizations means
 * the user still has to open or create one.
 */
export function resolveCurrentOrganization(
  organizations: readonly Organization[],
  preferredId: string | null
): Organization | null {
  return (
    organizations.find((organization) => organization.id === preferredId) ??
    organizations[0] ??
    null
  );
}

export type OrganizationLoad =
  | { status: "loading" }
  | { message: string; status: "error" }
  | { status: "empty" }
  | {
      current: Organization;
      organizations: readonly Organization[];
      status: "ready";
    };

export function organizationLoadFromList(
  organizations: readonly Organization[],
  preferredId: string | null
): OrganizationLoad {
  const current = resolveCurrentOrganization(organizations, preferredId);
  return current === null
    ? { status: "empty" }
    : { current, organizations, status: "ready" };
}

/** Switches to another organization, only if the server listed it. */
export function selectOrganization(
  load: OrganizationLoad,
  organizationId: string
): OrganizationLoad {
  if (load.status !== "ready") {
    return load;
  }
  const next = load.organizations.find(
    (organization) => organization.id === organizationId
  );
  return next ? { ...load, current: next } : load;
}

export function organizationLoadErrorMessage(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para acessar a organização.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O Polaris está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível carregar suas organizações. Verifique a conexão e tente novamente.";
}
