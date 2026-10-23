import type { OrganizationMembershipReadModel } from "@polaris/contracts";
import { isLegalAcceptanceRefusal, rpcErrorCode } from "./rpc-error";

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

/**
 * The organizations the server listed last, kept so the app can open without a
 * connection (the offline runtime is on). It is a convenience for drawing the
 * screen, never proof of access: the server authorizes every request, and the
 * list is dropped when the session ends (sign-out or an "unauthorized" answer).
 */
export const ORGANIZATIONS_CACHE_KEY = "polaris.offline.organizations";

function isOrganization(value: unknown): value is Organization {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id.length > 0 &&
    typeof row.name === "string" &&
    row.name.length > 0 &&
    typeof row.role === "string" &&
    row.role.length > 0 &&
    typeof row.timezone === "string" &&
    row.timezone.length > 0
  );
}

export function writeOrganizationsCache(
  storage: PreferenceStorage | null,
  organizations: readonly Organization[]
): void {
  try {
    storage?.setItem(
      ORGANIZATIONS_CACHE_KEY,
      JSON.stringify(
        organizations.map(({ id, name, role, timezone }) => ({
          id,
          name,
          role,
          timezone,
        }))
      )
    );
  } catch {
    // Without it the app still works online; only the offline start is lost.
  }
}

export function readOrganizationsCache(
  storage: PreferenceStorage | null
): Organization[] {
  try {
    const parsed: unknown = JSON.parse(
      storage?.getItem(ORGANIZATIONS_CACHE_KEY) ?? "[]"
    );
    return Array.isArray(parsed) ? parsed.filter(isOrganization) : [];
  } catch {
    return [];
  }
}

export function clearOrganizationsCache(
  storage: PreferenceStorage | null
): void {
  try {
    storage?.removeItem(ORGANIZATIONS_CACHE_KEY);
  } catch {
    // Nothing to clean when storage is unavailable.
  }
}

/**
 * Whether a failed read of the organizations may be answered from the cache: the
 * network or the server is down or busy (429, 5xx), not "the session is over" or
 * "not allowed" (AC-11 of the sign-in corte: only 401, 403 and "no session" end the offline open).
 */
export function canUseCachedOrganizations(error: unknown): boolean {
  const code = rpcErrorCode(error);
  return (
    code === undefined ||
    code === "SERVICE_UNAVAILABLE" ||
    code === "TOO_MANY_REQUESTS" ||
    code === "INTERNAL_SERVER_ERROR"
  );
}

export interface OrganizationLoadOutcome {
  /** Shown from the device's copy; read again once the connection is back. */
  fromCache: boolean;
  load: OrganizationLoad;
}

/**
 * What the screen shows when the read of the organizations failed: the cached
 * list when the offline runtime is on and the failure is a connection one,
 * otherwise the error.
 */
export function organizationLoadAfterFailure(input: {
  /** This is the read that opens the app (nothing was shown yet), not a read while a screen is in use. */
  atOpen: boolean;
  cached: readonly Organization[];
  error: unknown;
  offlineEnabled: boolean;
  preferredId: string | null;
}): OrganizationLoadOutcome {
  if (rpcErrorCode(input.error) === "UNAUTHORIZED") {
    return {
      fromCache: false,
      load: { atOpen: input.atOpen, status: "session_ended" },
    };
  }
  // the server answered: it is not a connection failure, so the device's copy does not stand in for it
  if (isLegalAcceptanceRefusal(input.error)) {
    return {
      fromCache: false,
      load: { atOpen: input.atOpen, status: "legal_acceptance_required" },
    };
  }
  if (
    input.offlineEnabled &&
    canUseCachedOrganizations(input.error) &&
    input.cached.length > 0
  ) {
    return {
      fromCache: true,
      load: organizationLoadFromList(input.cached, input.preferredId),
    };
  }
  return {
    fromCache: false,
    load: {
      message: organizationLoadErrorMessage(input.error),
      status: "error",
    },
  };
}

export type OrganizationLoad =
  | { status: "loading" }
  /** The server refused the session. `atOpen`: nothing was on screen yet, so the app goes to the sign-in screen by itself. */
  | { atOpen: boolean; status: "session_ended" }
  /**
   * The user has not accepted the legal documents in force (ADR 0100). `atOpen`: nothing was on screen
   * yet, so the app goes to `/aceite` by itself; later it only says so, and nothing local is dropped.
   */
  | { atOpen: boolean; status: "legal_acceptance_required" }
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
  // the session notice says the rest; here only what did not happen
  if (code === "UNAUTHORIZED") {
    return "Não foi possível carregar suas lojas.";
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O Polaris está temporariamente indisponível. Tente novamente.";
  }
  return "Não foi possível carregar suas lojas. Verifique a conexão e tente novamente.";
}
