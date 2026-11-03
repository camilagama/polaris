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
});
