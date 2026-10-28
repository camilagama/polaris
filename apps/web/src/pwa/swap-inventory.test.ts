import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The inventory of the screens that edit (ADR 0041). A swap of the build reloads the page, so a
 * screen with a form says itself when it holds work: `useHoldSwap(changed)` (`lib/unsent-work.ts`). Read from the
 * source, the whole of `src/`:
 *
 * - every `.tsx` that renders a `<form` calls `useHoldSwap(` itself, or is in `WITHOUT_OWN_HOLD` with where its draft
 *   is held (a screen that owns it, which must call `useHoldSwap(`), why what it holds is cheap to type again
 *   (`ignored`: the file must mark it with `data-swap-ignore`, or the net of the fields typed would hold the swap) or
 *   why it holds no work; the list is exact: a new form fails until it declares, and a line left behind fails too;
 * - every search field (`type="search"`) carries `data-swap-ignore`: what is typed in a search does not hold the swap.
 *
 * Each rule has a control case: the functions run on a planted text with the fault.
 */
const src = fileURLToPath(new URL("..", import.meta.url));

type Exemption =
  | { holdIn: readonly string[] }
  | { ignored: string }
  | { noWork: string };

const WITHOUT_OWN_HOLD: Readonly<Record<string, Exemption>> = {
  "catalog/category-form.tsx": { holdIn: ["catalog/categories-page.tsx"] },
  "catalog/category-list.tsx": { holdIn: ["catalog/categories-page.tsx"] },
  "catalog/product-form.tsx": { holdIn: ["catalog/products-page.tsx"] },
  "catalog/product-variant-parts.tsx": {
    holdIn: [
      "catalog/product-variant-price-section.tsx",
      "catalog/product-variant-sku-section.tsx",
    ],
  },
  "catalog/public-catalog-panels.tsx": {
    holdIn: ["catalog/public-catalog-page.tsx"],
  },
  "dashboard/period-picker.tsx": {
    ignored: "o período escolhido fica no endereço",
  },
  "legal/acceptance/acceptance-page.tsx": {
    noWork: "a caixa do aceite se marca de novo com um toque",
  },
  "offline-poc/offline-persistence-lab.tsx": {
    noWork: "laboratório: não registra o service worker",
  },
  "sign-in/change-password-page.tsx": {
    noWork:
      "senha: digitada de novo, nunca guardada; o campo digitado segura pela rede do guarda",
  },
  "sign-in/confirm-email-page.tsx": {
    noWork:
      "entrada: o e-mail se digita de novo; o campo digitado segura pela rede do guarda",
  },
  "sign-in/email-sign-in-form.tsx": {
    noWork:
      "entrada: o e-mail se digita de novo; o campo digitado segura pela rede do guarda",
  },
  "sign-in/forgot-password-page.tsx": {
    noWork:
      "entrada: o e-mail se digita de novo; o campo digitado segura pela rede do guarda",
  },
  "sign-in/reset-password-page.tsx": {
    noWork:
      "senha: digitada de novo, nunca guardada; o campo digitado segura pela rede do guarda",
  },
  "sign-in/sign-up-page.tsx": {
    noWork:
      "entrada: o e-mail se digita de novo; o campo digitado segura pela rede do guarda",
  },
  "subscription/subscription-offer.tsx": {
    noWork:
      "a escolha do plano é um toque; o envio é uma escrita, que segura enquanto vai",
  },
  "ui/dialog.tsx": { noWork: "o primitivo: o diálogo aberto segura sozinho" },
  "ui/filter-bar.tsx": { ignored: "os filtros ficam no endereço" },
};

// a `//` comment starts a line or follows a space, so the `//` of a URL inside a string is not one
const COMMENT = /\/\*[\s\S]*?\*\/|(?:^|\s)\/\/[^\n]*/gm;
const FORM = /<form\b/;
const HOLDS = /\buseHoldSwap\(/;
const SEARCH = /type="search"/g;
const HAS_SEARCH = /type="search"/;
const IGNORE = /\bdata-swap-ignore\b/;
const TSX = /\.tsx$/;
const TEST = /\.test\.tsx$/;

const withoutComments = (text: string) => text.replace(COMMENT, "");

function sources(directory: string): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (TSX.test(name) && !TEST.test(name)) {
        found.set(
          relative(directory, path).split(sep).join("/"),
          withoutComments(readFileSync(path, "utf8"))
        );
      }
    }
  };
  walk(directory);
  return found;
}

/** What breaks the rule of the forms: a form with no hold and no line, a line with no form, a holder that does not hold. */
function formFaults(
  files: ReadonlyMap<string, string>,
  exemptions: Readonly<Record<string, Exemption>>
): string[] {
  const faults: string[] = [];
  for (const [file, text] of files) {
    if (FORM.test(text) && !HOLDS.test(text) && !(file in exemptions)) {
      faults.push(`${file}: formulário sem useHoldSwap`);
    }
  }
  for (const [file, exemption] of Object.entries(exemptions)) {
    const text = files.get(file);
    if (text === undefined || !FORM.test(text) || HOLDS.test(text)) {
      faults.push(`${file}: linha da lista sem razão de estar`);
    }
    if ("ignored" in exemption && !IGNORE.test(text ?? "")) {
      faults.push(`${file}: sem data-swap-ignore`);
    }
    if ("holdIn" in exemption) {
      for (const holder of exemption.holdIn) {
        if (!HOLDS.test(files.get(holder) ?? "")) {
          faults.push(`${file}: ${holder} não declara useHoldSwap`);
        }
      }
    }
  }
  return faults.sort();
}

/** The search fields without `data-swap-ignore` in the same element. */
function searchFaults(files: ReadonlyMap<string, string>): string[] {
  const faults: string[] = [];
  for (const [file, text] of files) {
    for (const match of text.matchAll(SEARCH)) {
      const start = text.lastIndexOf("<", match.index);
      const end = text.indexOf(">", match.index);
      if (!IGNORE.test(text.slice(start, end))) {
        faults.push(`${file}: busca sem data-swap-ignore`);
      }
    }
  }
  return faults;
}

describe("o inventário das telas que editam (troca de build)", () => {
  const files = sources(src);

  it("varre a árvore inteira de src/", () => {
    expect(files.size).toBeGreaterThan(200);
    expect(files.has("sales/sale-page.tsx")).toBe(true);
  });

  it("toda tela com formulário declara useHoldSwap, ou diz quem segura por ela ou por que não há trabalho", () => {
    expect(formFaults(files, WITHOUT_OWN_HOLD)).toEqual([]);
    expect(Object.keys(WITHOUT_OWN_HOLD)).toEqual(
      Object.keys(WITHOUT_OWN_HOLD).sort()
    );
  });

  it("toda busca leva data-swap-ignore", () => {
    expect(searchFaults(files)).toEqual([]);
    // the search field of the lists and the product search of the sale
    const searches = [...files].filter(([, text]) => HAS_SEARCH.test(text));
    expect(searches.map(([file]) => file).sort()).toEqual([
      "sales/sale-variant-picker.tsx",
      "ui/search-field.tsx",
    ]);
  });

  describe("controles plantados", () => {
    const planted = (entries: Record<string, string>) =>
      new Map(Object.entries(entries));

    it("reprova uma tela nova com formulário e sem useHoldSwap (nem num comentário)", () => {
      expect(
        formFaults(
          planted({
            "nova/tela.tsx": withoutComments(
              "// useHoldSwap(true)\nexport const T = () => <form />;"
            ),
          }),
          {}
        )
      ).toEqual(["nova/tela.tsx: formulário sem useHoldSwap"]);
    });

    it("reprova a linha da lista que ficou sem formulário ou que já declara", () => {
      expect(
        formFaults(
          planted({
            "a.tsx": "<div />",
            "b.tsx": "useHoldSwap(x); <form />",
          }),
          { "a.tsx": { noWork: "x" }, "b.tsx": { noWork: "y" } }
        )
      ).toEqual([
        "a.tsx: linha da lista sem razão de estar",
        "b.tsx: linha da lista sem razão de estar",
      ]);
    });

    it("reprova o formulário barato de refazer que não leva data-swap-ignore", () => {
      expect(
        formFaults(planted({ "p.tsx": "<form onSubmit={f} />" }), {
          "p.tsx": { ignored: "fica no endereço" },
        })
      ).toEqual(["p.tsx: sem data-swap-ignore"]);
    });

    it("reprova quem diz segurar e não declara", () => {
      expect(
        formFaults(planted({ "f.tsx": "<form />", "page.tsx": "<div />" }), {
          "f.tsx": { holdIn: ["page.tsx"] },
        })
      ).toEqual(["f.tsx: page.tsx não declara useHoldSwap"]);
    });

    it("reprova uma busca sem data-swap-ignore, e aceita a que leva", () => {
      expect(
        searchFaults(
          planted({
            "bad.tsx": '<input onChange={f} type="search" value={v} />',
            "good.tsx": '<input data-swap-ignore="" type="search" />',
          })
        )
      ).toEqual(["bad.tsx: busca sem data-swap-ignore"]);
    });
  });
});
