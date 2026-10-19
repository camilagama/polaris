import {
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_NOTICE,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { currentLegalText } from "./legal-content";
import { LegalLoadFailure, LegalLoading } from "./legal-frame";
import { LegalDocumentView, LegalPage } from "./legal-page";
import { LEGAL_PAGE_TITLES } from "./legal-routes";

const noop = () => undefined;
const render = (document: (typeof LEGAL_DOCUMENT_IDS)[number]) =>
  renderToStaticMarkup(<LegalPage document={document} />);
const summaryAnchorPattern = /<li><a href="#([^"]+)"/g;
const backLinkPattern =
  /<a class="legal-back" href="#sumario">Voltar ao sumário<\/a>/g;
const tagStartPattern = /^\/?([a-z][a-z0-9]*)/i;
const headingLowerPattern = /<h[3-6][ >]/g;
const hrefPattern = /href="([^"#][^"]*)"/g;
const outsideAddressPattern = /(?:href|src|action)="(?:https?:)?\/\//;
const appPagePattern = /^\/(?:privacidade|termos)?$/;
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

/** The tags of a markup, by name in lowercase: read from each `<`, so case and spacing never hide one. */
const tagNames = (html: string) =>
  new Set(
    html
      .split("<")
      .slice(1)
      .flatMap((part) => tagStartPattern.exec(part)?.[1]?.toLowerCase() ?? [])
  );
const allowedTags = new Set([
  "a",
  "article",
  "button",
  "div",
  "h1",
  "h2",
  "header",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "section",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

describe.each(LEGAL_DOCUMENT_IDS)("the page of %s", (document) => {
  const html = render(document);

  it("has the title, one h1 and the version of the constant (AC-1, AC-3)", () => {
    expect(count(html, /<h1[ >]/g)).toBe(1);
    expect(html).toContain(LEGAL_PAGE_TITLES[document]);
    expect(html).toContain(
      `Versão ${LEGAL_DOCUMENTS[document].version}. Em vigor desde:`
    );
    expect(html).toContain(legalVersionLine(document).split("[")[0] ?? "");
  });

  it("has a summary whose every anchor leads to a heading (AC-1, AC-15)", () => {
    const anchors = [...html.matchAll(summaryAnchorPattern)].map(
      (match) => match[1]
    );
    expect(anchors.length).toBeGreaterThan(5);
    for (const anchor of anchors) {
      expect(html).toContain(`<h2 id="${anchor}"`);
    }
  });

  it("orders the headings as h1, then h2 only (AC-15)", () => {
    expect(count(html, headingLowerPattern)).toBe(0);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf("<h2"));
  });

  it("shows the draft notice while it exists (AC-10)", () => {
    expect(html.includes(LEGAL_DRAFT_NOTICE ?? "\0")).toBe(
      LEGAL_DRAFT_NOTICE !== null
    );
  });

  it("collects nothing and loads nothing: no form, no script, no outside address (AC-17)", () => {
    const tags = [...tagNames(html)];
    expect(tags.filter((tag) => !allowedTags.has(tag))).toEqual([]);
    expect(html).not.toMatch(outsideAddressPattern);
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("links only to pages of the app", () => {
    const hrefs = [...html.matchAll(hrefPattern)].map((match) => match[1]);
    for (const href of hrefs) {
      expect(href).toMatch(appPagePattern);
    }
  });
});

describe("the tables (AC-16)", () => {
  const html = render("privacy");

  it("keep a header row and name the column of every cell, for the narrow layout", () => {
    expect(count(html, /<table /g)).toBe(3);
    // the three tables have 3, 2 and 2 columns
    expect(count(html, /<th scope="col">/g)).toBe(7);
    expect(count(html, /<td /g)).toBe(count(html, /<td data-label="[^"]+"/g));
    expect(count(html, /<td /g)).toBeGreaterThan(30);
  });
});

describe("the pending markers (AC-9)", () => {
  it("show in the page in a highlighted mark, so staging makes them visible", () => {
    const html = renderToStaticMarkup(
      <LegalDocumentView
        document="terms"
        text={"# T\n\n## 1. Um\n\nContato: **[preencher: e-mail]**."}
      />
    );
    expect(html).toContain(
      '<mark class="legal-marker">[preencher: e-mail]</mark>'
    );
  });

  it("show the effective date of the constant as a marker while it is a draft", () => {
    if (LEGAL_DOCUMENTS.terms.effectiveFrom === null) {
      expect(render("terms")).toContain(
        '<mark class="legal-marker">[preencher na publicação]</mark>'
      );
    }
  });
});

describe("the view", () => {
  it("renders the text it is given, so a new version shows with no code change", () => {
    const html = renderToStaticMarkup(
      <LegalDocumentView
        document="terms"
        text={"# T\n\n## 1. Só isto\n\nUm texto novo."}
      />
    );
    expect(html).toContain("Um texto novo.");
    expect(html).toContain('<h2 id="1-so-isto">1. Só isto</h2>');
    expect(currentLegalText("terms")).not.toContain("Um texto novo.");
  });
});

describe("the markup check", () => {
  it("sees a tag in any case or spacing, so a text cannot slip one past the list", () => {
    expect(
      [...tagNames("<SCRIPT>x</SCRIPT><Img src=x><p></p>")].sort()
    ).toEqual(["img", "p", "script"]);
  });
});

describe.each(LEGAL_DOCUMENT_IDS)("the essentials of %s (V5)", (document) => {
  const html = render(document);
  const essential = html.slice(
    html.indexOf('<section aria-labelledby="o-essencial"'),
    html.indexOf("</section>")
  );

  it("come in a box before the summary, with 4 to 6 sentences", () => {
    expect(essential).toContain('<h2 id="o-essencial">O essencial</h2>');
    expect(html.indexOf("o-essencial")).toBeLessThan(
      html.indexOf('id="sumario"')
    );
    expect(count(essential, /<li>/g)).toBeGreaterThanOrEqual(4);
    expect(count(essential, /<li>/g)).toBeLessThanOrEqual(6);
  });

  it("is not in the summary, which lists only the numbered sections", () => {
    const anchors = [...html.matchAll(summaryAnchorPattern)].map(
      (match) => match[1]
    );
    expect(anchors).not.toContain("o-essencial");
  });

  it("does not take the box in for a section: no 'Voltar ao sumário' in it", () => {
    expect(essential).not.toContain("Voltar ao sumário");
  });
});

describe.each(LEGAL_DOCUMENT_IDS)(
  "the way back to the summary of %s (V2)",
  (document) => {
    const html = render(document);

    it("ends every numbered section with a link to the summary, and the summary has that id", () => {
      // every <section> but the essentials box is a numbered section
      const sections = count(html, /<section /g) - 1;
      expect(sections).toBeGreaterThan(5);
      expect(count(html, backLinkPattern)).toBe(sections);
      expect(html).toContain('id="sumario"');
    });
  }
);

describe("the notice of the queue in the terms (V5)", () => {
  it("is highlighted in section 8, before the list", () => {
    const html = render("terms");
    const section = html.slice(html.indexOf('<h2 id="8-encerrar-a-loja">'));
    expect(section.indexOf('class="legal-callout"')).toBeGreaterThan(-1);
    expect(section.indexOf('class="legal-callout"')).toBeLessThan(
      section.indexOf("<ul>")
    );
    expect(section).toContain("a fila pode se perder");
  });
});

describe("the states of a page that is not there yet (V3)", () => {
  it.each(LEGAL_DOCUMENT_IDS)(
    "loading shows the brand and the title of %s",
    (document) => {
      const html = renderToStaticMarkup(<LegalLoading document={document} />);
      expect(html).toContain("Polaris");
      expect(html).toContain(
        `<h1 id="legal-title">${LEGAL_PAGE_TITLES[document]}</h1>`
      );
      expect(html).toContain('role="status"');
      expect(html).toContain("Carregando…");
    }
  );

  it.each([
    [false, "Não foi possível abrir esta página. Tente de novo."],
    [true, "Sem conexão. Abra de novo quando a internet voltar."],
  ])(
    "failure (offline: %s) shows the brand, the title, the message and a retry",
    (offline, message) => {
      const html = renderToStaticMarkup(
        <LegalLoadFailure document="terms" offline={offline} onRetry={noop} />
      );
      expect(html).toContain("Polaris");
      expect(html).toContain('<h1 id="legal-title">Termos de Uso</h1>');
      expect(html).toContain(
        `<p class="legal-state" role="alert">${message}</p>`
      );
      expect(html).toContain("Tentar novamente");
    }
  );
});
