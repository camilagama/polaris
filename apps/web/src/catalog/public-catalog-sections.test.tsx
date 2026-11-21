// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blankProfileDraft } from "./public-catalog-model";
import { ProfileForm } from "./public-catalog-panels";

const noop = () => undefined;

afterEach(cleanup);

describe("sections of the public profile form", () => {
  let container: HTMLElement;
  let fieldsets: HTMLFieldSetElement[];
  beforeEach(() => {
    ({ container } = render(
      <ProfileForm
        changed={false}
        disabled={false}
        draft={blankProfileDraft}
        feedback={{ error: null, notice: null }}
        onChange={noop}
        online
        onSlugEdited={noop}
        onSubmit={noop}
        pending={false}
        problem={null}
        publicOrigin={null}
        slugEdited={false}
      />
    ));
    fieldsets = [...container.querySelectorAll("fieldset")];
  });

  it("names each section by a visible legend that holds its fields", () => {
    expect(
      fieldsets.map((fieldset) => ({
        controls: [...fieldset.querySelectorAll("input, textarea")].map(
          (control) => control.id
        ),
        legend: fieldset.querySelector(":scope > legend")?.textContent,
      }))
    ).toEqual([
      {
        controls: ["public-name", "public-slug", "public-description"],
        legend: "Como a loja aparece",
      },
      {
        controls: ["public-whatsapp", "public-instagram"],
        legend: "Contato",
      },
    ]);
  });

  it("keeps the fields in the same order and puts one rule between the sections", () => {
    const ids = [
      ...container.querySelectorAll("input:not([type=hidden]), textarea"),
    ].map((control) => control.id);
    expect(ids).toEqual([
      "public-name",
      "public-slug",
      "public-description",
      "public-whatsapp",
      "public-instagram",
    ]);
    const rules = container.querySelectorAll("[data-slot=field-separator]");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.getAttribute("aria-hidden")).toBe("true");
  });
});
