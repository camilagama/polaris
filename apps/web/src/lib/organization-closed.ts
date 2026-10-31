import { useSyncExternalStore } from "react";

const NONE: readonly string[] = [];

/**
 * The organizations the server said were closed, in answer to a call of this page (a read, the push of the queue or the
 * renewal of the lease), by id and in the order the refusals came. They live only in memory: the next opening reads the
 * organizations again, and a closed one is no longer listed.
 */
let closed: readonly string[] = NONE;
/** The closed ones whose refusal came back to a sale being confirmed: that sale was never queued on the device. */
let saleRefused: readonly string[] = NONE;
/** Of those, the ones where the command had already been sent once with no answer: the server may hold that sale. */
let saleMaybeRecorded: readonly string[] = NONE;
const listeners = new Set<() => void>();

export type SaleRefusalCause = "sale" | "sale_resent";
export type SaleRefusal = "maybe_recorded" | "not_recorded";

/** Every refusal is kept: the one of the store open now must not be lost behind one that came earlier. */
export function markOrganizationClosed(
  organizationId: string,
  cause: SaleRefusalCause | "other" = "other"
): void {
  if (organizationId === "") {
    return;
  }
  const newlyClosed = !closed.includes(organizationId);
  const newlyRefusedSale =
    cause !== "other" && !saleRefused.includes(organizationId);
  const newlyMaybeRecorded =
    cause === "sale_resent" && !saleMaybeRecorded.includes(organizationId);
  if (!(newlyClosed || newlyRefusedSale || newlyMaybeRecorded)) {
    return;
  }
  // a new list also for the cause alone: the notice already on the screen reads it again
  closed = newlyClosed ? [...closed, organizationId] : [...closed];
  if (newlyRefusedSale) {
    saleRefused = [...saleRefused, organizationId];
  }
  if (newlyMaybeRecorded) {
    saleMaybeRecorded = [...saleMaybeRecorded, organizationId];
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Null when no refusal of this store came back to a sale the person had just confirmed. */
export function closedSaleRefusal(organizationId: string): SaleRefusal | null {
  if (!saleRefused.includes(organizationId)) {
    return null;
  }
  return saleMaybeRecorded.includes(organizationId)
    ? "maybe_recorded"
    : "not_recorded";
}

/** The session is over or changed hands: no refusal of the earlier one says anything about the next. */
export function clearOrganizationsClosedHere(): void {
  if (closed.length === 0 && saleRefused.length === 0) {
    return;
  }
  closed = NONE;
  saleRefused = NONE;
  saleMaybeRecorded = NONE;
  for (const listener of listeners) {
    listener();
  }
}

export function organizationsClosedHere(): readonly string[] {
  return closed;
}

export function subscribeOrganizationsClosed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function serverSnapshot(): readonly string[] {
  return NONE;
}

export function useOrganizationsClosedHere(): readonly string[] {
  return useSyncExternalStore(
    subscribeOrganizationsClosed,
    organizationsClosedHere,
    serverSnapshot
  );
}

/**
 * The store whose notice the page shows. The one open now comes first, whether a call refused it or the runtime knows
 * it is closed; with none open yet, the first refused. Another store that was refused stays marked and gets its notice
 * when it is opened.
 */
export function closedStoreToShow(
  marked: readonly string[],
  currentId: string | null,
  runtimeClosed: boolean
): string | null {
  if (currentId === null) {
    return marked[0] ?? null;
  }
  return marked.includes(currentId) || runtimeClosed ? currentId : null;
}

/** The organization a call was made for: the requested context every tenant call carries. */
export function requestedOrganizationId(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const { organizationId } = input as { organizationId?: unknown };
  return typeof organizationId === "string" ? organizationId : null;
}
