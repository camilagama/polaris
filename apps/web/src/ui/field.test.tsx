import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, FieldLabel } from "@/ui/field";

/**
 * A hidden label must keep the 1 px box of `sr-only`: any other width rule that wins over it makes the label as wide as
 * its text, and a long unbroken text widens the scrollable area of the page. The width itself needs a browser:
 * e2e/lote-2-telas.e2e.ts measures the page with a 100 character name.
 */
const classesOf = (html: string, tag: string) =>
  (html.match(new RegExp(`<${tag} [^>]*class="([^"]*)"`))?.[1] ?? "")
    .replaceAll("&amp;", "&")
    .replaceAll("&gt;", ">")
    .split(" ");

describe("FieldLabel hidden with sr-only", () => {
  it("applies the fit-content width only to a label that is not sr-only", () => {
    const hidden = classesOf(
      renderToStaticMarkup(<FieldLabel className="sr-only">Nome</FieldLabel>),
      "label"
    );
    expect(hidden).toContain("sr-only");
    expect(hidden).not.toContain("w-fit");
    expect(hidden).toContain("[&:where(:not(.sr-only))]:w-fit");
  });

  it("makes a vertical Field give its hidden children 1 px, never auto", () => {
    const field = classesOf(
      renderToStaticMarkup(
        <Field>
          <FieldLabel className="sr-only">Nome</FieldLabel>
        </Field>
      ),
      "div"
    );
    expect(field).toContain("[&>.sr-only]:w-px");
    expect(field).not.toContain("[&>.sr-only]:w-auto");
  });
});
