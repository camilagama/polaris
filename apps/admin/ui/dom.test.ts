import { describe, expect, it } from "vitest";
import { checkAttribute, createDom } from "./dom";
import { FakeDocument } from "./test-dom";

/**
 * `dom.el` sets no attribute that runs code, styles the page or points outside the Admin (the security review of
 * PR 373): a handler, a style or a frame's document is refused whatever its value, and a URL attribute takes only a
 * path of this origin. The page's policy refuses most of these too; this is the refusal that does not need a browser.
 */

const dom = () => createDom(new FakeDocument() as unknown as Document);

describe("the attributes dom.el sets", () => {
  it.each([
    ["onclick", "alert(1)"],
    ["ONERROR", "x"],
    ["onfocus", ""],
    ["style", "color: red"],
    ["Style", "x"],
    ["srcdoc", "<script>alert(1)</script>"],
    ["srcset", "/ui/a.png 1x"],
  ])("refuses %s whatever its value", (name, value) => {
    expect(() => checkAttribute(name, value)).toThrow();
    expect(() => dom().el("a", { [name]: value })).toThrow();
  });

  it.each([
    "https://elsewhere.example/",
    "http://elsewhere.example/",
    "//elsewhere.example/x",
    "/\\elsewhere.example/x",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:alguem@exemplo.com",
    "api/whoami",
    " /api/whoami",
    "/api/who ami",
    "/api/\twhoami",
    "/api/\u0000",
    "/api/\u0085",
    "",
  ])("refuses %j as a URL attribute: only a path of the Admin", (value) => {
    for (const name of [
      "href",
      "src",
      "action",
      "formaction",
      "HREF",
      "xlink:href",
    ]) {
      expect(() => checkAttribute(name, value)).toThrow();
    }
    expect(() => dom().el("a", { href: value })).toThrow();
  });

  it.each([
    "/",
    "/api/whoami",
    "/ui/admin-1a2b3c.css",
    "/api/organizations?query=Loja%20A",
  ])("takes %s, a path of the Admin", (value) => {
    const link = dom().el("a", { href: value }, "Admin");
    expect(link.getAttribute("href")).toBe(value);
  });

  it("sets every other attribute as it is, and the text as text", () => {
    const element = dom().el(
      "button",
      {
        "aria-describedby": "dica",
        "data-label": "<b>x</b>",
        title: 'onclick="x"',
        type: "button",
      },
      "<img src=x onerror=alert(1)>"
    );
    expect(element.getAttribute("data-label")).toBe("<b>x</b>");
    expect(element.getAttribute("title")).toBe('onclick="x"');
    expect(element.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
