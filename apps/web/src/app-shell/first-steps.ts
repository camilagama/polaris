/**
 * The "Primeiros passos" of a store that never sold, as the foot of the menu shows them on every screen: the same
 * three steps as the checklist of the Início (Loja criada, Cadastrar o 1º produto, Fazer a 1ª venda), which reads them
 * and tells the shell. Kept for this tab only (`sessionStorage`, or the page's memory where the browser refuses it):
 * the shell reads nothing of its own, and shows what the Início read last in this tab, until the server confirms a sale;
 * registering the first product moves it from one step to two at once, without a read.
 */

export const FIRST_STEPS_TOTAL = 3;

/** The id of the block of the steps on the Início, where the foot of the menu links. */
export const FIRST_STEPS_ANCHOR = "home-checklist";

/** What the Início knows of the steps: the product it found, or that the store sold (then there are no steps). */
export interface FirstStepsFacts {
  firstProductId: string | null;
}

/** Which of the three steps are done: the store exists; the first product once there is one; the sale never. */
export function firstStepsDone(facts: FirstStepsFacts): boolean[] {
  return [true, facts.firstProductId !== null, false];
}

/** How many of the three steps are done. */
export function firstStepsCount(facts: FirstStepsFacts): number {
  return firstStepsDone(facts).filter(Boolean).length;
}

export const FIRST_STEPS_KEY = "polaris.home.firstSteps";

interface RememberedSteps {
  /** Null for no steps to show: the store sold, or this person does not read its stock (no checklist on the Início). */
  done: number | null;
  /** A sale was kept on this device while the steps were open: the next one the server confirms is not the first. */
  deviceSale?: true;
  organizationId: string;
}

type SessionStore = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function sessionStore(): SessionStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let inMemory: string | null = null;

const listeners = new Set<() => void>();

export function subscribeFirstSteps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function tell(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** The Início read the steps of the store (`null`: none to show), and the foot of the menu follows at once. */
export function rememberFirstSteps(
  organizationId: string,
  facts: FirstStepsFacts | null,
  store: SessionStore | null = sessionStore()
): void {
  const value: RememberedSteps = {
    done: facts === null ? null : firstStepsCount(facts),
    organizationId,
    ...(facts !== null && keptOnDevice(organizationId, store)
      ? { deviceSale: true }
      : {}),
  };
  inMemory = JSON.stringify(value);
  try {
    store?.setItem(FIRST_STEPS_KEY, inMemory);
  } catch {
    // the page's memory still has it
  }
  tell();
}

function storedText(store: SessionStore | null): string | null {
  try {
    return store?.getItem(FIRST_STEPS_KEY) ?? inMemory;
  } catch {
    return inMemory;
  }
}

/**
 * The steps done in this store, as the Início read them in this tab: null when the store sold, for another store, when
 * the Início did not read them yet, or for a value that is not one.
 */
export function rememberedFirstSteps(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): number | null {
  try {
    const value = JSON.parse(
      storedText(store) ?? "null"
    ) as Partial<RememberedSteps> | null;
    if (
      value === null ||
      typeof value !== "object" ||
      value.organizationId !== organizationId ||
      typeof value.done !== "number" ||
      !Number.isInteger(value.done) ||
      value.done < 1 ||
      value.done >= FIRST_STEPS_TOTAL
    ) {
      return null;
    }
    return value.done;
  } catch {
    return null;
  }
}

function keptOnDevice(
  organizationId: string,
  store: SessionStore | null
): boolean {
  try {
    const value = JSON.parse(
      storedText(store) ?? "null"
    ) as Partial<RememberedSteps> | null;
    return (
      value?.organizationId === organizationId && value.deviceSale === true
    );
  } catch {
    return false;
  }
}

/**
 * A sale was kept on this device (no connection): it is not an official sale yet, so the steps stay as they are, but the
 * store may have sold by the time the server confirms the next one, which then is not the first. The Início reading the
 * steps again keeps that mark: the server has not seen the sale kept here, so its word does not undo it. Only the store
 * selling (no steps) drops it.
 */
export function deviceSaleKept(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): void {
  const done = rememberedFirstSteps(organizationId, store);
  if (done === null) {
    return;
  }
  const value: RememberedSteps = { deviceSale: true, done, organizationId };
  inMemory = JSON.stringify(value);
  try {
    store?.setItem(FIRST_STEPS_KEY, inMemory);
  } catch {
    // the page's memory still has it
  }
}

/**
 * The server confirmed a sale of this store: its steps are over at once, on every screen. A sale kept on the device is
 * not one yet (it is not an official sale until the server confirms it); the Início reads the steps again anyway.
 * True only for the sale that ended them, the one this tab knew to be the first: the confirmation panel says so once.
 */
export function firstSaleConfirmed(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): boolean {
  if (rememberedFirstSteps(organizationId, store) === null) {
    return false;
  }
  const kept = keptOnDevice(organizationId, store);
  rememberFirstSteps(organizationId, null, store);
  return !kept;
}

/** The sale the server just confirmed ended the steps and is the first of the store; one it already had (replayed) is not new. */
export function confirmedSaleWasFirst(
  organizationId: string,
  replayed: boolean,
  store: SessionStore | null = sessionStore()
): boolean {
  return firstSaleConfirmed(organizationId, store) && !replayed;
}

/**
 * The server created the first product of this store: the second step is done
 * at once, on every screen, without reading anything. Only a store whose steps the Início already read as not over
 * changes: one that sold shows none, and one the Início never read in this tab is not known to have steps to show.
 */
export function firstProductRegistered(
  organizationId: string,
  productId: string,
  store: SessionStore | null = sessionStore()
): void {
  if (rememberedFirstSteps(organizationId, store) !== null) {
    rememberFirstSteps(organizationId, { firstProductId: productId }, store);
  }
}

/** The session is over: what the menu kept of the steps goes with it. */
export function clearFirstSteps(
  store: SessionStore | null = sessionStore()
): void {
  inMemory = null;
  try {
    store?.removeItem(FIRST_STEPS_KEY);
  } catch {
    // nothing kept, nothing to drop
  }
  tell();
}
