/**
 * How the Histórico was when a sale was opened from it: the filters and the scroll, kept in `sessionStorage` (the
 * detail is another page load, and the tab's own storage ends with it) and handed back only when the person leaves
 * the detail by its "Voltar". A snapshot nobody armed is one the person walked away from: the Histórico opens as the menu
 * opens it. The customer's name can be in the filters, so `leave-browser.ts` clears it with the session.
 */
export const HISTORY_RETURN_KEY = "polaris.sales.historyReturn";

type Store = Pick<Storage, "getItem" | "removeItem" | "setItem">;

/**
 * The filters as the Histórico keeps them, `status` still a string: this module is imported by the sign-out, which must
 * not pull the model of the list into every screen; the page reads the situation through `statusFromState`.
 */
interface StoredFilters {
  customer: string;
  from: string;
  query: string;
  status: string;
  to: string;
}

export interface HistoryReturn {
  filters: StoredFilters;
  scrollY: number;
}

interface Stored extends HistoryReturn {
  armed: boolean;
  organizationId: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parse(raw: string | null): Stored | null {
  if (raw === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // storage blocked or full
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const organizationId: unknown = Reflect.get(value, "organizationId");
  const filters: unknown = Reflect.get(value, "filters");
  const scrollY: unknown = Reflect.get(value, "scrollY");
  if (
    typeof organizationId !== "string" ||
    typeof filters !== "object" ||
    filters === null
  ) {
    return null;
  }
  return {
    armed: Reflect.get(value, "armed") === true,
    filters: {
      customer: text(Reflect.get(filters, "customer")),
      from: text(Reflect.get(filters, "from")),
      query: text(Reflect.get(filters, "query")),
      status: text(Reflect.get(filters, "status")),
      to: text(Reflect.get(filters, "to")),
    },
    organizationId,
    scrollY:
      typeof scrollY === "number" && Number.isFinite(scrollY) && scrollY > 0
        ? Math.round(scrollY)
        : 0,
  };
}

function read(store: Store | null): Stored | null {
  try {
    return parse(store?.getItem(HISTORY_RETURN_KEY) ?? null);
  } catch {
    // storage blocked or full
    return null;
  }
}

export function rememberHistoryReturn(
  store: Store | null,
  organizationId: string,
  state: HistoryReturn
): void {
  const stored: Stored = { ...state, armed: false, organizationId };
  try {
    store?.setItem(HISTORY_RETURN_KEY, JSON.stringify(stored));
  } catch {
    // storage blocked or full
  }
}

export function armHistoryReturn(store: Store | null): void {
  const stored = read(store);
  if (stored === null) {
    return;
  }
  try {
    store?.setItem(
      HISTORY_RETURN_KEY,
      JSON.stringify({ ...stored, armed: true })
    );
  } catch {
    // storage blocked or full
  }
}

export function readHistoryReturn(
  store: Store | null,
  organizationId: string
): HistoryReturn | null {
  const stored = read(store);
  if (
    stored === null ||
    !stored.armed ||
    stored.organizationId !== organizationId
  ) {
    return null;
  }
  return { filters: stored.filters, scrollY: stored.scrollY };
}

export function clearHistoryReturn(store: Store | null): void {
  try {
    store?.removeItem(HISTORY_RETURN_KEY);
  } catch {
    // storage blocked or full
  }
}
