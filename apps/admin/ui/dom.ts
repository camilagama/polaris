/**
 * The one way the Admin page builds its DOM: elements made by name, attributes set one by one and text written as
 * text. Nothing here takes HTML, so a store name with `<script>` in it is shown as those characters (AC-4, AC-11);
 * the page's policy (Trusted Types `'none'`) refuses an HTML string even if one slipped in. An event handler, a style
 * or a frame source is never an attribute, and a URL attribute is only a path of the Admin (`checkAttribute`).
 */

type Child = Node | string | null | undefined | false;

export interface Dom {
  document: Document;
  el: <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes?: Readonly<Record<string, string>>,
    ...children: Child[]
  ) => HTMLElementTagNameMap[K];
  /** Replaces what an element holds with the given children. */
  fill: (parent: Element, ...children: Child[]) => void;
}

/**
 * Attributes that run code, style the page or carry a document or a list of sources from a string (`on*`, `style`,
 * the frame's document and the image's source list): never set, whatever the value.
 */
const REFUSED_ATTRIBUTE = /^(on.*|style|src.+)$/;
/** Attributes the browser follows as a URL: only a path of the Admin itself, so nothing points to another origin. */
const URL_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "xlink:href",
]);
/**
 * A path of this origin: one slash, then no second slash or backslash (`//host` and `/\host` are another origin to
 * the browser), no space and no control character. No scheme is allowed: the page links nowhere else.
 */
const ADMIN_PATH = /^\/(?![/\\])[^\s\\]*$/;

/** Throws on an attribute that would run code, style the page or point outside the Admin. */
export function checkAttribute(name: string, value: string): void {
  const lower = name.toLowerCase();
  if (REFUSED_ATTRIBUTE.test(lower)) {
    throw new Error(`the page does not set the attribute ${lower}`);
  }
  if (
    URL_ATTRIBUTES.has(lower) &&
    !(ADMIN_PATH.test(value) && !hasControlCharacter(value))
  ) {
    throw new Error(`the attribute ${lower} takes only a path of the Admin`);
  }
}

export function createDom(document: Document): Dom {
  const append = (parent: Element, children: readonly Child[]) => {
    for (const child of children) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      parent.append(
        typeof child === "string" ? document.createTextNode(child) : child
      );
    }
  };
  return {
    document,
    el: (tag, attributes = {}, ...children) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) {
        checkAttribute(name, value);
        element.setAttribute(name, value);
      }
      append(element, children);
      return element;
    },
    fill: (parent, ...children) => {
      parent.replaceChildren();
      append(parent, children);
    },
  };
}

/** The longest store name shown; the whole name stays in the tooltip, cut at `TITLE_LIMIT`. */
export const NAME_LIMIT = 80;
const TITLE_LIMIT = 300;

/** C0 controls, DEL and C1 controls: never typed by a person, and invisible when shown. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    if (isControl(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/** A control character becomes the replacement character, so the operator sees that something is there. */
function visible(text: string): string {
  let shown = "";
  for (const character of text) {
    shown += isControl(character.codePointAt(0) ?? 0) ? "�" : character;
  }
  return shown;
}

function cut(text: string, limit: number): string {
  const characters = [...text];
  return characters.length > limit
    ? `${characters.slice(0, limit).join("")}…`
    : text;
}

/** Bidi controls and invisible characters: harmless inside `<bdi>`, but a tooltip or an accessible name has no isolation. */
function isInvisible(code: number): boolean {
  return (
    (code >= 0x20_0b && code <= 0x20_0f) ||
    (code >= 0x20_28 && code <= 0x20_2e) ||
    (code >= 0x20_66 && code <= 0x20_69) ||
    code === 0xfe_ff
  );
}

/** A store's name for an attribute (tooltip, accessible name): controls and invisible characters made visible, cut. */
export function labelName(name: string, limit = NAME_LIMIT): string {
  let shown = "";
  for (const character of visible(name)) {
    shown += isInvisible(character.codePointAt(0) ?? 0) ? "\uFFFD" : character;
  }
  return cut(shown, limit);
}

/** A name a store owner typed, for the line where it is shown: visible controls, cut to `NAME_LIMIT`. */
function shownName(name: string): string {
  return cut(visible(name), NAME_LIMIT);
}

/**
 * The store's name in `<bdi>` (a right-to-left override inside it cannot reorder what follows), cut, with the store's
 * ID next to it: names are not unique, the ID is (AC-4).
 */
export function storeName(dom: Dom, name: string, id: string): HTMLElement {
  return dom.el(
    "span",
    { class: "store" },
    dom.el(
      "bdi",
      { class: "store-name", title: labelName(name, TITLE_LIMIT) },
      shownName(name)
    ),
    " ",
    dom.el("code", { class: "store-id" }, id)
  );
}
