import type { PreferenceStorage } from "../lib/current-organization-model";
import type { NamespaceKey } from "./namespace";

/**
 * The link between a sale the server refused and the new sale that redoes it. It lives in `localStorage`, not in
 * the tab like the draft: a tab closed after the new sale was recorded must not bring "Refazer esta venda" back for
 * a sale that is already redone. It holds command IDs and the start of the draft, nothing about a person or a sale.
 * An entry goes away when its refused command leaves the queue. It is kept per queue namespace (the hash of user and
 * organization that names the outbox, ADR 0015): the queue that decides what is pruned is the one of that namespace,
 * so another user of the same browser and store never sees or prunes it.
 */
export const SALE_REDO_KEY_PREFIX = "polaris.sale.redo.v1:";

export interface SaleRedo {
  /** The command of the new sale, once it was confirmed or kept on the device. */
  redoneCommandId: string | null;
  /** The refused command: it is only ever discarded, never sent again. */
  refusedCommandId: string;
  /** `startedAt` of the draft Vender was opened with: how Vender knows the draft it confirms is this redo. */
  startedAt: string;
}

const key = (namespaceKey: NamespaceKey) =>
  `${SALE_REDO_KEY_PREFIX}${namespaceKey}`;

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 64;

function isRedo(value: unknown): value is SaleRedo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    isText(row.refusedCommandId) &&
    isText(row.startedAt) &&
    (row.redoneCommandId === null || isText(row.redoneCommandId))
  );
}

export function readSaleRedos(
  storage: PreferenceStorage | null,
  namespaceKey: NamespaceKey
): SaleRedo[] {
  try {
    const text = storage?.getItem(key(namespaceKey));
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed.filter(isRedo) : [];
  } catch {
    return [];
  }
}

function write(
  storage: PreferenceStorage | null,
  namespaceKey: NamespaceKey,
  redos: readonly SaleRedo[]
): void {
  try {
    if (redos.length === 0) {
      storage?.removeItem(key(namespaceKey));
    } else {
      storage?.setItem(key(namespaceKey), JSON.stringify(redos));
    }
  } catch {
    // a blocked storage only loses the link: the refused sale stays in Pendências as it was
  }
}

/** Whether the draft that began at `startedAt` is the redo of a refused sale that has no new sale yet. */
export function isOpenRedoDraft(
  redos: readonly SaleRedo[],
  startedAt: string | null
): boolean {
  return (
    startedAt !== null &&
    redos.some(
      (redo) => redo.startedAt === startedAt && redo.redoneCommandId === null
    )
  );
}

/**
 * Opens the redo of one refused sale, replacing an earlier open one of the same refused sale. Another tab may hold
 * the open redo of another sale, so those are kept: each draft is told apart by its `startedAt`. False, and nothing
 * written, when that refused sale was already redone: it is never redone twice.
 */
export function startSaleRedo(
  storage: PreferenceStorage | null,
  namespaceKey: NamespaceKey,
  refusedCommandId: string,
  startedAt: string
): boolean {
  const redos = readSaleRedos(storage, namespaceKey);
  if (
    redos.some(
      (redo) =>
        redo.refusedCommandId === refusedCommandId &&
        redo.redoneCommandId !== null
    )
  ) {
    return false;
  }
  write(storage, namespaceKey, [
    ...redos.filter((redo) => redo.refusedCommandId !== refusedCommandId),
    { redoneCommandId: null, refusedCommandId, startedAt },
  ]);
  return true;
}

/**
 * The draft that began at `startedAt` was confirmed or kept on the device as `redoneCommandId`. Does nothing, and
 * says false, when that draft was not the redo of a refused sale.
 */
export function finishSaleRedo(
  storage: PreferenceStorage | null,
  namespaceKey: NamespaceKey,
  startedAt: string | null,
  redoneCommandId: string
): boolean {
  if (startedAt === null) {
    return false;
  }
  const redos = readSaleRedos(storage, namespaceKey);
  if (!isOpenRedoDraft(redos, startedAt)) {
    return false;
  }
  write(
    storage,
    namespaceKey,
    redos.map((redo) =>
      redo.startedAt === startedAt && redo.redoneCommandId === null
        ? { ...redo, redoneCommandId }
        : redo
    )
  );
  return true;
}

/** Forgets the entries whose refused command is no longer in the queue (it was discarded). */
export function pruneSaleRedos(
  storage: PreferenceStorage | null,
  namespaceKey: NamespaceKey,
  queuedCommandIds: ReadonlySet<string>
): void {
  const redos = readSaleRedos(storage, namespaceKey);
  const kept = redos.filter((redo) =>
    queuedCommandIds.has(redo.refusedCommandId)
  );
  if (kept.length !== redos.length) {
    write(storage, namespaceKey, kept);
  }
}

/**
 * The refused sales that already have their new sale. A new sale kept on the device that the server then refused
 * does not count: the person still has no sale in its place.
 */
export function redoneCommandIds(
  redos: readonly SaleRedo[],
  queue: readonly { commandId: string; status: string }[]
): ReadonlySet<string> {
  const refused = new Set(
    queue
      .filter((command) => command.status === "rejected")
      .map((command) => command.commandId)
  );
  return new Set(
    redos
      .filter(
        (redo) =>
          redo.redoneCommandId !== null && !refused.has(redo.redoneCommandId)
      )
      .map((redo) => redo.refusedCommandId)
  );
}
