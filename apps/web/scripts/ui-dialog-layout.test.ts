import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORM_BODY_CLASS,
  FORM_CLOSE_CLASS,
  FORM_ELEMENT_CLASS,
  FORM_FOOTER_CLASS,
  FORM_HEADER_CLASS,
  FORM_POPUP_CLASS,
  followVisualViewport,
  SMALL_FOOTER_CLASS,
  SMALL_POPUP_CLASS,
} from "../src/ui/dialog-layout";

/**
 * The form layout of the Dialog, read as classes: a Base UI dialog renders in a portal, which the server renderer of
 * these tests does not draw, so what the person sees (the whole screen, the fixed header and footer, the scroll, the
 * focus, Esc, the title) is measured in the browser, in `e2e-pwa/ui-dialog-form.e2e.ts`. Here: the contract of the
 * classes, and that `dialog.tsx` keeps the small dialog as it was.
 */
const classes = (value: string) => value.split(" ");
const dialogSource = readFileSync(
  new URL("../src/ui/dialog.tsx", import.meta.url),
  "utf8"
);

describe("Dialog, layout de formulário", () => {
  it("é a tela inteira abaixo de 760 px e um diálogo central de 44 rem a partir daí", () => {
    const popup = classes(FORM_POPUP_CLASS);
    // the whole screen below `md` (760 px): both sides, from the top, as tall as the visible part
    expect(popup).toContain("max-md:inset-x-0");
    expect(popup).toContain("max-md:top-[var(--dialog-top,0px)]");
    expect(popup).toContain("max-md:h-[var(--dialog-height,100dvh)]");
    // centred and wide from `md`, never taller than the window
    expect(popup).toContain("md:max-w-[44rem]");
    expect(popup).toContain("md:max-h-[calc(100dvh-4rem)]");
    expect(popup).toContain("md:-translate-x-1/2");
    expect(popup).toContain("md:-translate-y-1/2");
    // a column that cuts what overflows: the body is the part that scrolls
    expect(popup).toContain("flex-col");
    expect(popup).toContain("overflow-hidden");
    // never `100vh` (it ignores the browser bars), never a screen height set in pixels
    expect(FORM_POPUP_CLASS).not.toContain("100vh");
    expect(FORM_POPUP_CLASS).not.toContain("h-screen");
  });

  it("só o meio rola, e o cabeçalho e o rodapé não encolhem", () => {
    expect(classes(FORM_BODY_CLASS)).toEqual(
      expect.arrayContaining([
        "min-h-0",
        "flex-1",
        "overflow-y-auto",
        "overflow-x-hidden",
        "overscroll-contain",
      ])
    );
    expect(classes(FORM_HEADER_CLASS)).toContain("shrink-0");
    expect(classes(FORM_FOOTER_CLASS)).toContain("shrink-0");
    // the form that wraps them is the column that lets the body take what is left
    expect(classes(FORM_ELEMENT_CLASS)).toEqual(
      expect.arrayContaining(["flex", "flex-col", "flex-1", "min-h-0"])
    );
  });

  it("respeita a área segura do iPhone nos quatro lados", () => {
    expect(FORM_HEADER_CLASS).toContain("env(safe-area-inset-top)");
    expect(FORM_FOOTER_CLASS).toContain("env(safe-area-inset-bottom)");
    for (const side of ["left", "right"]) {
      expect(FORM_BODY_CLASS).toContain(`env(safe-area-inset-${side})`);
      expect(FORM_FOOTER_CLASS).toContain(`env(safe-area-inset-${side})`);
    }
    // the close button keeps off the notch too
    expect(FORM_CLOSE_CLASS).toContain("env(safe-area-inset-top)");
  });

  it("empilha o rodapé no celular com o botão principal no alto, e o põe em linha a partir de 760 px", () => {
    const footer = classes(FORM_FOOTER_CLASS);
    // the main button is last in the order: reversed, it is on top, with the way out under it
    expect(footer).toContain("flex-col-reverse");
    // and side by side from `md`, the way out first and the main button at the right
    expect(footer).toContain("md:flex-row");
    expect(footer).toContain("md:justify-end");
  });

  it("os dois layouts seguem a parte visível da tela, e o diálogo pequeno fica como era", () => {
    expect(dialogSource).toContain("ref={followVisualViewport}");
    expect(dialogSource).toContain('layout = "dialog"');
    expect(dialogSource).toContain("SMALL_POPUP_CLASS");
    expect(dialogSource).toContain("SMALL_FOOTER_CLASS");
  });
});

class FakeViewport {
  height = 700;
  offsetTop = 0;
  readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
  count() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

const fakePopup = () => {
  const values = new Map<string, string>();
  const popup = {
    style: {
      setProperty: (name: string, value: string) => values.set(name, value),
    },
  };
  return { popup: popup as unknown as HTMLElement, values };
};

describe("Dialog, segue a janela visível (teclado aberto)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("grava altura, topo e centro da parte visível, de novo a cada resize e scroll, e solta os ouvintes", () => {
    const viewport = new FakeViewport();
    vi.stubGlobal("window", { visualViewport: viewport });
    const { popup, values } = fakePopup();
    const cleanup = followVisualViewport(popup);
    expect(values.get("--dialog-height")).toBe("700px");
    expect(values.get("--dialog-top")).toBe("0px");
    expect(values.get("--dialog-center")).toBe("350px");
    viewport.height = 300;
    viewport.fire("resize");
    expect(values.get("--dialog-height")).toBe("300px");
    expect(values.get("--dialog-center")).toBe("150px");
    viewport.offsetTop = 40;
    viewport.fire("scroll");
    expect(values.get("--dialog-top")).toBe("40px");
    expect(values.get("--dialog-center")).toBe("190px");
    expect(viewport.count()).toBe(2);
    cleanup?.();
    expect(viewport.count()).toBe(0);
  });

  it("sem visualViewport ou sem popup não faz nada", () => {
    vi.stubGlobal("window", {});
    expect(followVisualViewport(fakePopup().popup)).toBeUndefined();
    vi.stubGlobal("window", { visualViewport: new FakeViewport() });
    expect(followVisualViewport(null)).toBeUndefined();
  });
});

describe("Dialog, layout pequeno", () => {
  it("mantém a caixa de sempre: central, 24 rem, anel e sombra, rodapé em tira", () => {
    const popup = classes(SMALL_POPUP_CLASS);
    expect(popup).toEqual(
      expect.arrayContaining([
        "fixed",
        "top-[var(--dialog-center,50%)]",
        "left-1/2",
        "z-50",
        "grid",
        "w-full",
        "max-w-[calc(100%-2rem)]",
        "-translate-x-1/2",
        "-translate-y-1/2",
        "gap-4",
        "rounded-xl",
        "bg-popover",
        "p-4",
        "shadow-lg",
        "outline-none",
        "ring-1",
        "ring-foreground/[0.06]",
        "sm:max-w-sm",
      ])
    );
    expect(SMALL_FOOTER_CLASS).toBe(
      "-mx-4 -mb-4 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end"
    );
  });

  it("rola inteiro quando passa da parte visível da janela, sem passar a rolagem à página", () => {
    const popup = classes(SMALL_POPUP_CLASS);
    expect(popup).toContain("max-h-[calc(var(--dialog-height,100dvh)-2rem)]");
    expect(popup).toContain("overflow-y-auto");
    expect(popup).toContain("overflow-x-hidden");
    expect(popup).toContain("overscroll-contain");
    // no fixed footer: nothing in the small layout is a flex column that keeps a part still
    expect(popup).not.toContain("flex-col");
    expect(popup).not.toContain("overflow-hidden");
    expect(SMALL_FOOTER_CLASS).not.toContain("sticky");
    expect(SMALL_FOOTER_CLASS).not.toContain("shrink-0");
    expect(SMALL_POPUP_CLASS).not.toContain("100vh");
  });
});
