import type { Dom } from "../dom";
import { brasiliaMomentText } from "../format";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** True for a UUID: the only thing of the server's that a path of the Admin carries (AC-C6). */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The path of a case's screen, or null when the server's ID is not a UUID (no link is made from it). */
export function casePath(id: unknown): string | null {
  return isUuid(id) ? `/casos/${id.toLowerCase()}` : null;
}

export function storePath(id: unknown): string | null {
  return isUuid(id) ? `/lojas/${id.toLowerCase()}` : null;
}

/** The link to a case, named by when it was opened (a reason is not unique and may be long). */
export function caseLink(
  dom: Dom,
  item: { id: string; openedAt: string }
): HTMLAnchorElement | null {
  const path = casePath(item.id);
  return path === null
    ? null
    : dom.el(
        "a",
        {
          "aria-label": `Ver atendimento aberto em ${brasiliaMomentText(item.openedAt)}`,
          href: path,
        },
        "Ver atendimento"
      );
}

/** The link to the closed cases of a store, or null when the ID is not a UUID. */
export function closedCasesLink(dom: Dom, store: string): HTMLElement | null {
  return isUuid(store)
    ? dom.el(
        "p",
        {},
        dom.el(
          "a",
          { href: `/casos?estado=fechados&loja=${store.toLowerCase()}` },
          "Ver os atendimentos fechados desta loja"
        )
      )
    : null;
}

/** The link that opens a case, with the store chosen when there is one. */
export function newCaseLink(dom: Dom, store: string | null): HTMLElement {
  const path = isUuid(store)
    ? `/casos/novo?loja=${store.toLowerCase()}`
    : "/casos/novo";
  return dom.el(
    "p",
    { class: "action-link" },
    dom.el(
      "a",
      { class: "button-link", href: path },
      "Abrir atendimento de suporte"
    )
  );
}
