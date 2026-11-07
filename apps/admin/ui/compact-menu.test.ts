import { describe, expect, it } from "vitest";
import { closeCompactMenuOnEscapeAndOutsideTap } from "./compact-menu";

type Listener = (event: {
  defaultPrevented?: boolean;
  key?: string;
  target: unknown;
}) => void;

class FakeSummary {
  focused = 0;

  focus() {
    this.focused += 1;
  }
}

const COMPACT = "details.compact-menu";
const ACCOUNT = "details[data-conta]";

class FakeMenu {
  open: boolean;
  readonly kind: string;
  readonly inside = new Set<unknown>();
  readonly summary = new FakeSummary();

  constructor(open: boolean, kind = COMPACT) {
    this.open = open;
    this.kind = kind;
    this.inside.add(this.summary);
  }

  contains(node: unknown) {
    return this.inside.has(node);
  }

  querySelector(selector: string) {
    return selector === "summary" ? this.summary : null;
  }
}

class FakePage {
  readonly listeners = new Map<string, Listener>();
  readonly selectors: string[] = [];
  readonly menus: FakeMenu[];
  readonly body = {};
  activeElement: unknown = this.body;

  constructor(menus: FakeMenu[]) {
    this.menus = menus;
  }

  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, listener);
  }

  querySelectorAll(selector: string) {
    this.selectors.push(selector);
    const wanted = selector.split(",").map((part) => part.trim());
    return this.menus.filter((menu) => wanted.includes(menu.kind));
  }

  press(key: string, defaultPrevented = false) {
    this.listeners.get("keydown")?.({ defaultPrevented, key, target: this });
  }

  touch(target: unknown) {
    this.listeners.get("pointerdown")?.({ target });
  }
}

function mount(...menus: FakeMenu[]) {
  const page = new FakePage(menus);
  closeCompactMenuOnEscapeAndOutsideTap(page as unknown as Document);
  return page;
}

describe("the compact menu closes with Esc", () => {
  it("closes the open menu and gives the focus to its ☰", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.press("Escape");
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(1);
  });

  it("looks only at the compact menu and the account menu", () => {
    const page = mount(new FakeMenu(true));
    page.press("Escape");
    expect(page.selectors).toEqual([
      "details.compact-menu, details[data-conta]",
    ]);
  });

  it("closes the account menu with Esc, giving the focus back to its summary, and leaves the compact menu closed alone", () => {
    const account = new FakeMenu(true, ACCOUNT);
    const compact = new FakeMenu(false);
    const page = mount(account, compact);
    page.press("Escape");
    expect(account.open).toBe(false);
    expect(account.summary.focused).toBe(1);
    expect(compact.open).toBe(false);
    expect(compact.summary.focused).toBe(0);
  });

  it("gives the focus back from a link inside the panel, and from the page body", () => {
    const menu = new FakeMenu(true);
    const link = {};
    menu.inside.add(link);
    const page = mount(menu);
    page.activeElement = link;
    page.press("Escape");
    expect(menu.summary.focused).toBe(1);
    menu.open = true;
    page.activeElement = page.body;
    page.press("Escape");
    expect(menu.summary.focused).toBe(2);
  });

  it("with both menus open, the focus stays in the one that holds it and the other closes without taking it", () => {
    const account = new FakeMenu(true, ACCOUNT);
    const compact = new FakeMenu(true);
    const page = mount(account, compact);
    const link = {};
    account.inside.add(link);
    page.activeElement = link;
    page.press("Escape");
    expect(account.open).toBe(false);
    expect(compact.open).toBe(false);
    expect(account.summary.focused).toBe(1);
    expect(compact.summary.focused).toBe(0);
  });

  it("closes the menu but leaves the focus on a control outside it (the account menu, a field)", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.activeElement = {};
    page.press("Escape");
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(0);
  });

  it("leaves alone an Esc that something else already handled", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.press("Escape", true);
    expect(menu.open).toBe(true);
  });

  it("does nothing for another key", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.press("Enter");
    page.press("Tab");
    expect(menu.open).toBe(true);
    expect(menu.summary.focused).toBe(0);
  });

  it("takes no focus from the page when the menu is already closed", () => {
    const menu = new FakeMenu(false);
    const page = mount(menu);
    page.press("Escape");
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(0);
  });
});

describe("the compact menu closes with a tap outside", () => {
  it("closes the open menu and leaves the focus where the person tapped", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.touch({});
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(0);
  });

  it("keeps it open for a tap on the ☰ or inside the panel, which the browser handles", () => {
    const menu = new FakeMenu(true);
    const link = {};
    menu.inside.add(link);
    const page = mount(menu);
    page.touch(menu.summary);
    page.touch(link);
    expect(menu.open).toBe(true);
  });

  it("closes it for a tap with no target", () => {
    const menu = new FakeMenu(true);
    const page = mount(menu);
    page.touch(null);
    expect(menu.open).toBe(false);
  });

  it("leaves a closed menu closed", () => {
    const menu = new FakeMenu(false);
    const page = mount(menu);
    page.touch({});
    expect(menu.open).toBe(false);
  });
});

describe("the account menu closes with a tap outside", () => {
  it("closes it for a tap outside and keeps it open for a tap on its summary or inside the panel", () => {
    const account = new FakeMenu(true, ACCOUNT);
    const item = {};
    account.inside.add(item);
    const page = mount(account);
    page.touch(account.summary);
    page.touch(item);
    expect(account.open).toBe(true);
    page.touch({});
    expect(account.open).toBe(false);
  });
});
