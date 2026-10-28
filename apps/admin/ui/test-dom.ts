/**
 * A small DOM for the page's tests, with nothing to install: elements, text, attributes, events and focus, which is
 * all the page uses. Every way of writing HTML from a string throws, so a test that passes proves the page never
 * tried one; and every element made is recorded, so a test can say no `<script>` or `<img>` was ever created.
 */

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  defaultPrevented: boolean;
  preventDefault: () => void;
  target: FakeElement;
  type: string;
}

class FakeNode {
  parent: FakeElement | null = null;
  readonly ownerDocument: FakeDocument;

  constructor(document: FakeDocument) {
    this.ownerDocument = document;
  }

  get textContent(): string {
    return "";
  }
}

export class FakeText extends FakeNode {
  readonly data: string;

  constructor(document: FakeDocument, data: string) {
    super(document);
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }
}

function refuseHtml(): never {
  throw new Error("the page must not write HTML from a string");
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  childNodes: FakeNode[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly tagName: string;
  value = "";

  constructor(document: FakeDocument, tagName: string) {
    super(document);
    this.tagName = tagName.toLowerCase();
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (node): node is FakeElement => node instanceof FakeElement
    );
  }

  override get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  override set textContent(text: string) {
    this.replaceChildren(new FakeText(this.ownerDocument, text));
  }

  set innerHTML(_html: string) {
    refuseHtml();
  }

  set outerHTML(_html: string) {
    refuseHtml();
  }

  insertAdjacentHTML(): never {
    refuseHtml();
  }

  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) {
      const child =
        typeof node === "string"
          ? new FakeText(this.ownerDocument, node)
          : node;
      child.parent?.removeChild(child);
      child.parent = this;
      this.childNodes.push(child);
    }
  }

  prepend(...nodes: (FakeNode | string)[]) {
    const kept = this.childNodes;
    this.childNodes = [];
    this.append(...nodes);
    this.childNodes.push(...kept);
  }

  removeChild(child: FakeNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parent = null;
  }

  replaceChildren(...nodes: (FakeNode | string)[]) {
    for (const node of this.childNodes) {
      node.parent = null;
    }
    this.childNodes = [];
    this.append(...nodes);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatch(type: string): FakeEvent {
    const event: FakeEvent = {
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
      target: this,
      type,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
    return event;
  }

  /** A click as a person makes it: nothing on a disabled button; a submit button submits its form. */
  click() {
    if (this.hasAttribute("disabled")) {
      return;
    }
    this.dispatch("click");
    if (this.tagName === "button" && this.getAttribute("type") === "submit") {
      let form = this.parent;
      while (form !== null && form.tagName !== "form") {
        form = form.parent;
      }
      const submitted = form?.dispatch("submit");
      if (submitted !== undefined && !submitted.defaultPrevented) {
        throw new Error("a form was submitted natively");
      }
    }
  }

  /** The first descendant with this tag name (the only selector the page uses). */
  querySelector(tag: string): FakeElement | null {
    for (const child of this.children) {
      if (child.tagName === tag) {
        return child;
      }
      const found = child.querySelector(tag);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  readonly body: FakeElement;
  /** Every tag the page asked for, in order. */
  readonly created: string[] = [];

  constructor() {
    this.body = new FakeElement(this, "body");
  }

  createElement(tag: string): FakeElement {
    this.created.push(tag.toLowerCase());
    return new FakeElement(this, tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }

  write(): never {
    refuseHtml();
  }
}

/** Every element under (and including) `root`, in document order. */
export function allElements(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => allElements(child))];
}

export function byTag(root: FakeElement, tag: string): FakeElement[] {
  return allElements(root).filter((element) => element.tagName === tag);
}

export function byId(root: FakeElement, id: string): FakeElement {
  const found = allElements(root).find(
    (element) => element.getAttribute("id") === id
  );
  if (found === undefined) {
    throw new Error(`no element with id ${id}`);
  }
  return found;
}

/** The buttons whose text is exactly `text`. */
export function buttons(root: FakeElement, text: string): FakeElement[] {
  return byTag(root, "button").filter((button) => button.textContent === text);
}

/** The text a person would read: hidden elements are left out. */
export function visibleText(root: FakeElement): string {
  if (root.hasAttribute("hidden")) {
    return "";
  }
  return root.childNodes
    .map((node) =>
      node instanceof FakeElement ? visibleText(node) : node.textContent
    )
    .join("");
}
