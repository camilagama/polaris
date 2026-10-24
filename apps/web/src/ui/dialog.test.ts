import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORM_BODY_CLASS,
  FORM_CLOSE_CLASS,
  FORM_ELEMENT_CLASS,
  FORM_FOOTER_CLASS,
  FORM_HEADER_CLASS,
  FORM_POPUP_CLASS,
} from "@/ui/dialog-layout";

/**
 * The form layout of the Dialog, read as classes: a Base UI dialog renders in a portal, which the server renderer of
 * these tests does not draw, so what the person sees (the whole screen, the fixed header and footer, the scroll, the
 * focus, Esc, the title) is measured in the browser, in `e2e-pwa/ui-dialog-form.e2e.ts`. Here: the contract of the
 * classes, and that `dialog.tsx` keeps the small dialog as it was.
 */
const classes = (value: string) => value.split(" ");
const dialogSource = readFileSync(
  new URL("dialog.tsx", import.meta.url),
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

  it("segue a parte visível da tela com o teclado aberto, e o diálogo pequeno fica como era", () => {
    expect(dialogSource).toContain("window.visualViewport");
    expect(dialogSource).toContain('"--dialog-height"');
    expect(dialogSource).toContain('"--dialog-top"');
    // the question and the confirmation keep their box (`sm:max-w-sm`) and their footer
    expect(dialogSource).toContain("sm:max-w-sm");
    expect(dialogSource).toContain(
      "-mx-4 -mb-4 flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end"
    );
    expect(dialogSource).toContain('layout = "dialog"');
  });
});
