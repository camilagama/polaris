import { describe, expect, it } from "vitest";
import { checkAttribute, checkTag, createDom, labelName } from "./dom";
import { FakeDocument } from "./test-dom";

/**
 * `dom.el` makes only the elements and sets only the attributes the page uses: a
 * handler, a style, a frame's document or an image's source is refused whatever its value, an element that navigates
 * or loads (`meta`, `link`, `iframe`…) is refused by name, and an `href` takes only a path of the Admin's page. The
 * page's policy refuses most of these too; this is the refusal that does not need a browser.
 */

const dom = () => createDom(new FakeDocument() as unknown as Document);

describe("the elements dom.el makes", () => {
  it.each([
    "meta",
    "link",
    "iframe",
    "frame",
    "object",
    "embed",
    "base",
    "script",
    "style",
    "img",
    "svg",
    "template",
    "META",
  ])("refuses %s", (tag) => {
    expect(() => checkTag(tag)).toThrow();
    expect(() => dom().el(tag as "p")).toThrow();
  });

  it("makes the elements of text, forms and tables", () => {
    for (const tag of [
      "section",
      "table",
      "button",
      "select",
      "bdi",
    ] as const) {
      expect(dom().el(tag).tagName).toBe(tag);
    }
  });
});

describe("the attributes dom.el sets", () => {
  it.each([
    ["onclick", "alert(1)"],
    ["ONERROR", "x"],
    ["onfocus", ""],
    ["style", "color: red"],
    ["Style", "x"],
    ["srcdoc", "<script>alert(1)</script>"],
    ["srcset", "/ui/a.png 1x"],
    ["src", "/ui/a.png"],
    ["action", "/"],
    ["formaction", "/"],
    ["xlink:href", "/"],
    ["http-equiv", "refresh"],
    ["content", "0;url=https://elsewhere.example"],
    ["imagesrcset", "/a.png"],
    ["usemap", "#m"],
    ["data-x", "1"],
  ])("refuses %s whatever its value", (name, value) => {
    expect(() => checkAttribute(name, value)).toThrow();
    expect(() => dom().el("span", { [name]: value })).toThrow();
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
    "ui/admin.css",
    " /ui/admin.css",
    "/ui/admin .css",
    "/ui/\tadmin.css",
    "/ui/\u0000",
    "/ui/\u0085",
    "/api",
    "/api/funnel?weeks=26",
    "/api?x",
    "/api#x",
    "",
  ])("refuses %j as an href: only a path of the Admin's page", (value) => {
    for (const name of ["href", "HREF"]) {
      expect(() => checkAttribute(name, value)).toThrow();
    }
    expect(() => dom().el("a", { href: value })).toThrow();
  });

  it.each(["/", "/ui/admin-1a2b3c.css", "/apis", "/api-docs"])(
    "takes %s, a path of the Admin's page",
    (value) => {
      const link = dom().el("a", { href: value }, "Admin");
      expect(link.getAttribute("href")).toBe(value);
    }
  );

  it("sets every attribute of the list as it is, and the text as text", () => {
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

describe("a name in an attribute", () => {
  it.each([
    "\u00ad",
    "\u061c",
    "\u200b",
    "\u200f",
    "\u202e",
    "\u2060",
    "\u2064",
    "\u2066",
    "\u2069",
    "\ufeff",
    "\u0007",
    "\u009b",
  ])("shows the invisible character %j as one that is seen", (character) => {
    expect(labelName(`Loja${character}Ana`)).toBe("Loja\uFFFDAna");
  });
});
