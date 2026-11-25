import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TabPanelScope } from "../app-shell/screen-title";
import { ChangePasswordForm } from "./change-password-page";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const REGION =
  /role="region"[^>]*aria-labelledby="([^"]+)"|aria-labelledby="([^"]+)"[^>]*role="region"/u;

const H2_TITLE = /<h2[^>]*>.*Nova senha<\/span><\/h2>/su;
const H3_TITLE = /<h3[^>]*>.*Nova senha<\/span><\/h3>/su;

describe("o bloco Nova senha da aba Senha", () => {
  it("é uma região nomeada pelo título, com os dois campos e os dois botões dentro", () => {
    const html = renderToStaticMarkup(<ChangePasswordForm />);
    const labelled = REGION.exec(html)?.slice(1).find(Boolean);
    expect(labelled).toBeDefined();
    expect(html).toContain(`id="${labelled}"`);
    expect(html).toContain('data-slot="card-frame"');
    expect(html).toContain("Nova senha");
    expect(html).toContain('name="current-password"');
    expect(html).toContain('name="new-password"');
    expect(html).toContain("Trocar senha");
    expect(html).toContain("Cancelar");
  });

  it("o título é h2 na página sozinha e h3 dentro da aba, sob o título da aba", () => {
    const alone = renderToStaticMarkup(<ChangePasswordForm />);
    expect(alone).toMatch(H2_TITLE);
    const inTab = renderToStaticMarkup(
      <TabPanelScope>
        <ChangePasswordForm />
      </TabPanelScope>
    );
    expect(inTab).toMatch(H3_TITLE);
  });
});
