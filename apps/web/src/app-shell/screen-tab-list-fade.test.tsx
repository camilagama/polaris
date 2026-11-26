// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs } from "@/ui/tabs";
import { ScreenTabList, ScreenTabTrigger } from "@/ui/section-tabs";

const ROOMS = { clientWidth: 100, scrollLeft: 50, scrollWidth: 400 };
const originals = new Map<string, PropertyDescriptor | undefined>();

function fakeScrolling() {
  for (const [name, value] of Object.entries(ROOMS)) {
    originals.set(
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    );
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => value,
      set: () => undefined,
    });
  }
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
  originals.clear();
});

function edgesOf(surface?: "page" | "popover") {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  fakeScrolling();
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(
      <Tabs value="a">
        <ScreenTabList
          label="Abas"
          value="a"
          {...(surface === undefined ? {} : { surface })}
        >
          <ScreenTabTrigger value="a">A</ScreenTabTrigger>
          <ScreenTabTrigger value="b">B</ScreenTabTrigger>
        </ScreenTabList>
      </Tabs>
    );
  });
  const edges = [...host.querySelectorAll("[data-tabs-edge]")].map(
    (edge) => edge.className
  );
  act(() => root.unmount());
  return edges;
}

describe("the fade at the edges of a list of tabs", () => {
  it("draws both edges when tabs are hidden on both sides", () => {
    expect(edgesOf()).toHaveLength(2);
  });

  it("starts in the color of the page by default", () => {
    for (const edge of edgesOf()) {
      expect(edge).toContain("from-background");
      expect(edge).not.toContain("from-popover");
    }
  });

  it("starts in the color of the page when the surface is the page", () => {
    for (const edge of edgesOf("page")) {
      expect(edge).toContain("from-background");
    }
  });

  it("starts in the color of the dialog when the surface is a popover", () => {
    for (const edge of edgesOf("popover")) {
      expect(edge).toContain("from-popover");
      expect(edge).not.toContain("from-background");
    }
  });
});
