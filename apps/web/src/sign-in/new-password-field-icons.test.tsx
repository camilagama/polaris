import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NewPasswordField } from "./new-password-field";

const noop = () => undefined;
const SIXTEEN_PX = /class="[^"]*\bsize-4\b/;

function renderList(value: string): string {
  return renderToStaticMarkup(
    <NewPasswordField
      error={null}
      flagged={false}
      id="nova"
      label="Nova senha"
      name="password"
      onChange={noop}
      onToggle={noop}
      value={value}
      visible={false}
    />
  );
}

const listOf = (html: string) =>
  html.slice(html.indexOf("<ul"), html.indexOf("</ul>"));
const svgs = (html: string) => listOf(html).match(/<svg\b[^>]*>/g) ?? [];

describe("os ícones dos requisitos da senha têm 16 px", () => {
  it.each([
    ["nenhum requisito atendido", "", false],
    ["todos os requisitos atendidos", "Senha-Forte-2026!", true],
  ])("%s", (_name, value, met) => {
    const html = renderList(value);
    expect(listOf(html)).toContain(`data-met="${met}"`);
    expect(listOf(html)).not.toContain(`data-met="${!met}"`);
    const icons = svgs(html);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon).toMatch(SIXTEEN_PX);
      expect(icon).not.toContain("size-3.5");
    }
  });
});
