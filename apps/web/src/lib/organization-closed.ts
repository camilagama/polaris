import { useSyncExternalStore } from "react";

/**
 * The organization the server said was closed, in answer to a call of this page (a read, the push of the queue or the
 * renewal of the lease). It lives only in memory: the next opening reads the organizations again, and the closed one
 * is no longer listed.
 */
export interface OrganizationClosedHere {
  organizationId: string;
}

let closed: OrganizationClosedHere | null = null;
const listeners = new Set<() => void>();

/** The first refusal wins: the notice is about the store this page was working in. */
export function markOrganizationClosed(organizationId: string): void {
  if (closed !== null || organizationId === "") {
    return;
  }
  closed = { organizationId };
  for (const listener of listeners) {
    listener();
  }
}

function organizationClosedHere(): OrganizationClosedHere | null {
  return closed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function serverSnapshot(): OrganizationClosedHere | null {
  return null;
}

export function useOrganizationClosedHere(): OrganizationClosedHere | null {
  return useSyncExternalStore(
    subscribe,
    organizationClosedHere,
    serverSnapshot
  );
}

/** The organization a call was made for: the requested context every tenant call carries. */
export function requestedOrganizationId(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const { organizationId } = input as { organizationId?: unknown };
  return typeof organizationId === "string" ? organizationId : null;
}
