import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDom } from "../../ui/dom";
import { FakeDocument, type FakeElement, markupOf } from "../../ui/test-dom";
import { waitingItem } from "../../ui/views/home";

const FIXTURE = join(
  fileURLToPath(new URL("../../../..", import.meta.url)),
  "apps/web/e2e-pwa/fixtures/admin-waiting-item.json"
);
const WAITING_ITEM_CASES: (Parameters<typeof waitingItem>[1] & {
  markup: string;
})[] = JSON.parse(readFileSync(FIXTURE, "utf8"));

const dom = createDom(new FakeDocument() as unknown as Document);
const markup = (item: Parameters<typeof waitingItem>[1]) =>
  markupOf(waitingItem(dom, item) as unknown as FakeElement);

describe("o item de Esperando por você", () => {
  it("makes the figure, the text and the destination in this order, in one link", () => {
    expect(
      markup({
        destination: "Ver atendimentos",
        figure: "42",
        href: "/casos",
        what: "atendimentos abertos",
      })
    ).toBe(
      '<li><a aria-label="42 atendimentos abertos: ver atendimentos" class="waiting-item" href="/casos"><span class="waiting-count">42</span> <span class="waiting-what">atendimentos abertos</span> <span class="waiting-go">Ver atendimentos →</span></a></li>'
    );
  });

  it("leaves out the figure and its space when there is none", () => {
    expect(
      markup({
        destination: "Ver falhas de envio",
        figure: null,
        href: "/incidentes",
        what: "Há falhas de envio",
      })
    ).toBe(
      '<li><a aria-label="Há falhas de envio: ver falhas de envio" class="waiting-item" href="/incidentes"><span class="waiting-what">Há falhas de envio</span> <span class="waiting-go">Ver falhas de envio →</span></a></li>'
    );
  });

  it("escapes what a store or a person wrote", () => {
    expect(
      markup({
        destination: "Ver",
        figure: null,
        href: "/casos",
        what: '<b>"a" & b</b>',
      })
    ).toContain(
      '<span class="waiting-what">&lt;b&gt;&quot;a&quot; &amp; b&lt;/b&gt;</span>'
    );
  });

  it.each(
    WAITING_ITEM_CASES.map(
      (item) => [item.figure ?? "no figure", item] as const
    )
  )("makes the markup the browser test measures (%s)", (_name, item) => {
    expect(markup(item)).toBe(item.markup);
  });
});
