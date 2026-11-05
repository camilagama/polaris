import { mountAdmin, type ScreenContext } from "./app";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SCREEN_PATH =
  /^\/(?:(?:lojas|casos|incidentes|privacidade)\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/;

/** A UUID the Worker wrote, or null; anything else on the root is not taken as one. */
function uuidOf(value: string | null): string | null {
  return value !== null && UUID.test(value) ? value : null;
}

const KEY = /^[a-z][a-z._]{0,63}$/;

/** The keys the Worker wrote, space-separated; a token that is not a key is dropped. */
function keysOf(value: string | null): string[] {
  return (value ?? "").split(" ").filter((key) => KEY.test(key));
}

function contextOf(element: HTMLElement): ScreenContext | null {
  const screen = element.getAttribute("data-tela");
  if (screen === null) {
    return null;
  }
  const environment = element.getAttribute("data-ambiente");
  return {
    environment:
      environment === "production" || environment === "staging"
        ? environment
        : "unknown",
    flagKeys: keysOf(element.getAttribute("data-chaves-recurso")),
    id: uuidOf(element.getAttribute("data-id")),
    limitKeys: keysOf(element.getAttribute("data-chaves-limite")),
    listState:
      element.getAttribute("data-estado") === "fechados"
        ? "fechados"
        : "abertos",
    screen,
    store: uuidOf(element.getAttribute("data-loja")),
  };
}

const root = document.getElementById("admin");
// a page without a screen (the operator may not open it) has nothing for the script to do
const context = root === null ? null : contextOf(root);
if (root !== null && context !== null) {
  mountAdmin(
    root,
    (input, init) => fetch(input, init),
    () => new Date(),
    context,
    (path) => {
      // a screen may only send the browser to another screen of the Admin, by a fixed path or a UUID
      if (SCREEN_PATH.test(path)) {
        window.location.assign(path);
      }
    }
  );
}
