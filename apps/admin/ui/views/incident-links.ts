import type { Dom } from "../dom";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The path of an incident's screen, or null when the server's ID is not a UUID (no link is made from it). */
function incidentPath(id: unknown): string | null {
  return typeof id === "string" && UUID.test(id)
    ? `/incidentes/${id.toLowerCase()}`
    : null;
}

export function incidentLink(
  dom: Dom,
  item: { id: string },
  label: string
): HTMLAnchorElement | null {
  const path = incidentPath(item.id);
  return path === null
    ? null
    : dom.el("a", { "aria-label": label, href: path }, "Ver falha de envio");
}

/** True for a UUID: the only thing of the server's that a path of the Admin or a retry's URL carries (AC-C6). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
