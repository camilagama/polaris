/**
 * The "Primeiros passos" of a store that never sold, as the foot of the menu shows them on every screen: the same
 * three steps as the checklist of the Início (Loja criada, Cadastrar o 1º produto, Fazer a 1ª venda), which reads them
 * and tells the shell. Kept for this tab only (`sessionStorage`, or the page's memory where the browser refuses it):
 * the shell reads nothing of its own, and shows what the Início read last in this tab, until the server confirms a sale.
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

/**
 * The server confirmed a sale of this store: its steps are over at once, on every screen. A sale kept on the device is
 * not one yet (it is not an official sale until the server confirms it); the Início reads the steps again anyway.
 */
export function firstSaleConfirmed(
  organizationId: string,
  store: SessionStore | null = sessionStore()
): void {
  if (rememberedFirstSteps(organizationId, store) !== null) {
    rememberFirstSteps(organizationId, null, store);
  }
}

/**
 * The server holds a product of this store: the second step is done at once, on every screen, when the Início had read
 * the store with none. A product kept on the device is not one yet (the Início reads the server's list), so the
 * callers tell this only once the server has it; with no steps remembered (the store sold, or the Início did not read
 * them) there is nothing to move.
 */
export function firstProductRegistered(
  organizationId: string,
  productId: string,
  store: SessionStore | null = sessionStore()
): void {
  if (rememberedFirstSteps(organizationId, store) === 1) {
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
