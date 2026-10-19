import {
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  LEGAL_DRAFT_NOTICE,
  legalVersionLine,
} from "@polaris/domain/legal/legal-documents";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { currentLegalText } from "./legal-content";
import { LegalDocumentView, LegalPage } from "./legal-page";
import { LEGAL_PAGE_TITLES } from "./legal-routes";

const render = (document: (typeof LEGAL_DOCUMENT_IDS)[number]) =>
  renderToStaticMarkup(<LegalPage document={document} />);
const anchorPattern = /<a href="#([^"]+)"/g;
const headingLowerPattern = /<h[3-6][ >]/g;
const hrefPattern = /href="([^"#][^"]*)"/g;
const collectingTagPattern = /<(form|input|script|iframe|img|link|style)[ >]/;
const outsideAddressPattern = /(?:href|src|action)="(?:https?:)?\/\//;
const appPagePattern = /^\/(?:privacidade|termos)?$/;
const count = (html: string, pattern: RegExp) =>
  html.match(pattern)?.length ?? 0;

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
    const anchors = [...html.matchAll(anchorPattern)].map((match) => match[1]);
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
    expect(html).not.toMatch(collectingTagPattern);
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
    // the three tables have 3, 2 and 3 columns
    expect(count(html, /<th scope="col">/g)).toBe(8);
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
