import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OfflineRuntime } from "../offline/runtime/offline-runtime";
import { RuntimeContext } from "../offline/runtime/runtime-context";
import { OrganizationSetup } from "./organization-setup";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const SAIR_BUTTON = /<button[^>]*type="button"[^>]*>Sair<\/button>/;
const noop = () => undefined;

function render(runtime: OfflineRuntime | null) {
  return renderToStaticMarkup(
    <RuntimeContext.Provider value={runtime}>
      <OrganizationSetup onOpened={noop} />
    </RuntimeContext.Provider>
  );
}

describe("the first access, Abra a sua loja", () => {
  it("offers Sair with the offline runtime off", () => {
    const html = render(null);
    expect(html).toContain("Abra a sua loja");
    expect(html).toMatch(SAIR_BUTTON);
    expect(html).toContain("Não é a sua conta?");
  });

  it("offers the same Sair with the offline runtime on", () => {
    const html = render({} as OfflineRuntime);
    expect(html).toMatch(SAIR_BUTTON);
    expect(html).toContain("Não é a sua conta?");
  });

  it("links the two legal pages under the form, in another tab, as the screen has no menu (AC-2.7)", () => {
    const html = render(null);
    const form = html.indexOf("</form>");
    for (const [href, name] of [
      ["/termos", "Termos de Uso"],
      ["/privacidade", "Política de Privacidade"],
    ] as const) {
      const link = new RegExp(
        `<a class="([^"]*)" href="${href}" rel="noopener noreferrer" target="_blank">${name}`
      ).exec(html);
      expect(link, name).not.toBeNull();
      // under the form, so the form does not move; a touch area of 44 px (`touch-hit`)
      expect(link?.index ?? -1).toBeGreaterThan(form);
      expect(link?.[1]).toContain("touch-hit");
    }
  });
});
