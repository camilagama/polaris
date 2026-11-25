import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "@/ui/checkbox";
import { Field, FieldContent, FieldLabel, FieldTitle } from "@/ui/field";
import { Label } from "@/ui/label";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Switch } from "@/ui/switch";

/**
 * The check box, the radio and the switch off. The root of each one is a span of the Base UI, so `:disabled` never
 * matches: they fade through `data-disabled`, and a label that holds one fades as a whole while the control inside it
 * stays at 1. Tailwind is not compiled here: the classes the real components render are read with the same rules the
 * generated CSS applies (the attribute the markup has, the label that holds a disabled control), and the opacities of
 * the chain are multiplied the way the browser stacks them. e2e-pwa/ui-components.e2e.ts measures in the gallery the
 * card with a radio, and the check box and the switch inside a label.
 */
const OPACITY = /^(.+):opacity-(\d+)(!?)$/;
const PLAIN_OPACITY = /^opacity-(\d+)$/;
const SPACES = /\s+/;
const ATTRS = /\s([\w-]+)(?:="([^"]*)")?/g;
const TAG = /<(\w+)([^>]*)>/g;

interface Tag {
  attrs: Map<string, string>;
  classes: string[];
  name: string;
}

const tagsOf = (html: string): Tag[] =>
  [...html.matchAll(TAG)].map(([, name = "", rest = ""]) => {
    const attrs = new Map<string, string>();
    for (const [, key = "", value = ""] of rest.matchAll(ATTRS)) {
      attrs.set(key, value);
    }
    return {
      attrs,
      classes: (attrs.get("class") ?? "").split(SPACES).filter(Boolean),
      name,
    };
  });

const bySlot = (html: string, slot: string): Tag => {
  const found = tagsOf(html).find((tag) => tag.attrs.get("data-slot") === slot);
  if (!found) {
    throw new Error(`no element with data-slot="${slot}" in ${html}`);
  }
  return found;
};

interface Context {
  holdsDisabledChild?: boolean;
  insideLabelHoldingDisabled?: boolean;
}

const matches = (variant: string, tag: Tag, context: Context): boolean => {
  switch (variant) {
    case "data-disabled":
      return tag.attrs.has("data-disabled");
    case "aria-disabled":
      return tag.attrs.get("aria-disabled") === "true";
    case "has-data-disabled":
      return context.holdsDisabledChild === true;
    case "group-has-data-disabled/label":
      return context.insideLabelHoldingDisabled === true;
    default:
      return false;
  }
};

const ownOpacity = (tag: Tag, context: Context = {}): number => {
  const hits = tag.classes.flatMap((name) => {
    const plain = PLAIN_OPACITY.exec(name);
    if (plain) {
      return [{ important: false, value: Number(plain[1]) / 100 }];
    }
    const [, variant = "", amount = "", bang = ""] = OPACITY.exec(name) ?? [];
    return variant && matches(variant, tag, context)
      ? [{ important: bang === "!", value: Number(amount) / 100 }]
      : [];
  });
  const winners = hits.some((hit) => hit.important)
    ? hits.filter((hit) => hit.important)
    : hits;
  const values = new Set(winners.map((hit) => hit.value));
  if (values.size > 1) {
    throw new Error(`conflicting opacities ${[...values].join(", ")}`);
  }
  return winners[0]?.value ?? 1;
};

const holdsDisabled = (inner: string) => inner.includes(`data-disabled=""`);

const innerOf = (html: string) =>
  html.slice(html.indexOf(">") + 1, html.lastIndexOf("</"));

const labelOpacity = (html: string, slot: string): number =>
  ownOpacity(bySlot(html, slot), {
    holdsDisabledChild: holdsDisabled(innerOf(html)),
  });

const controlOpacity = (
  html: string,
  slot: string,
  context: Context = {}
): number => ownOpacity(bySlot(html, slot), context);

const inLabel = (html: string) => ({
  insideLabelHoldingDisabled: holdsDisabled(innerOf(html)),
});

const ignore = () => undefined;
const render = (node: React.ReactNode) => renderToStaticMarkup(node);

const card = (disabled: boolean) =>
  render(
    <RadioGroup disabled={disabled} value="pix">
      <FieldLabel htmlFor="forma-pix">
        <Field orientation="horizontal">
          <FieldContent>
            <FieldTitle>Pix</FieldTitle>
          </FieldContent>
          <RadioGroupItem id="forma-pix" value="pix" />
        </Field>
      </FieldLabel>
    </RadioGroup>
  );

const cardLabel = (html: string) => {
  const start = html.indexOf("<label");
  return html.slice(start, html.indexOf("</label>") + "</label>".length);
};

describe("the radio off", () => {
  it("loose, fades to 50% by data-disabled and shows the blocked cursor", () => {
    const html = render(
      <RadioGroup disabled value="a">
        <RadioGroupItem value="a" />
      </RadioGroup>
    );
    const radio = bySlot(html, "radio-group-item");
    expect(ownOpacity(radio)).toBe(0.5);
    expect(radio.classes).toContain("data-disabled:cursor-not-allowed");
  });

  it("loose and on, stays at 1", () => {
    const html = render(
      <RadioGroup value="a">
        <RadioGroupItem value="a" />
      </RadioGroup>
    );
    expect(ownOpacity(bySlot(html, "radio-group-item"))).toBe(1);
  });

  it("inside a FieldLabel the card fades to 50% and the radio stays at 1: 50% once, never 25%", () => {
    const html = cardLabel(card(true));
    const label = labelOpacity(html, "field-label");
    const radio = controlOpacity(html, "radio-group-item", inLabel(html));
    expect(label).toBe(0.5);
    expect(radio).toBe(1);
    expect(label * radio).toBe(0.5);
  });

  it("a card that is on fades nothing", () => {
    const html = cardLabel(card(false));
    expect(labelOpacity(html, "field-label")).toBe(1);
    expect(controlOpacity(html, "radio-group-item", inLabel(html))).toBe(1);
  });
});

describe("the switch off", () => {
  const off = render(<Switch disabled />);

  it("fades by data-disabled alone, without aria-disabled", () => {
    const root = bySlot(off, "switch");
    const withoutAria = { ...root, attrs: new Map(root.attrs) };
    withoutAria.attrs.delete("aria-disabled");
    expect(withoutAria.attrs.has("data-disabled")).toBe(true);
    expect(ownOpacity(withoutAria)).toBe(0.5);
    expect(root.classes).toContain("data-disabled:opacity-50");
    expect(root.classes).toContain("data-disabled:cursor-not-allowed");
  });

  it("still fades by aria-disabled alone, the way the offline switch is held back with a reason", () => {
    const root = bySlot(off, "switch");
    const withoutData = { ...root, attrs: new Map(root.attrs) };
    withoutData.attrs.delete("data-disabled");
    expect(ownOpacity(withoutData)).toBe(0.5);
  });

  it("on, stays at 1", () => {
    expect(ownOpacity(bySlot(render(<Switch />), "switch"))).toBe(1);
  });

  it("inside a Label the label fades to 50% and the switch stays at 1", () => {
    const html = render(
      <Label>
        <Switch disabled />
        Dicas
      </Label>
    );
    const label = labelOpacity(html, "label");
    const control = controlOpacity(html, "switch", inLabel(html));
    expect(label).toBe(0.5);
    expect(control).toBe(1);
  });
});

describe("the check box off inside a Label", () => {
  it("the label fades to 50% and the box stays at 1: 50% once", () => {
    const html = render(
      <Label>
        <Checkbox checked={false} disabled onCheckedChange={ignore} />
        Azul
      </Label>
    );
    const label = labelOpacity(html, "label");
    const box = controlOpacity(html, "checkbox", inLabel(html));
    expect(label).toBe(0.5);
    expect(box).toBe(1);
    expect(label * box).toBe(0.5);
  });

  it("a label with the box on fades nothing", () => {
    const html = render(
      <Label>
        <Checkbox checked={false} onCheckedChange={ignore} />
        Azul
      </Label>
    );
    expect(labelOpacity(html, "label")).toBe(1);
    expect(controlOpacity(html, "checkbox", inLabel(html))).toBe(1);
  });

  it("loose, the box fades to 50% by itself", () => {
    const html = render(<Checkbox checked disabled onCheckedChange={ignore} />);
    expect(controlOpacity(html, "checkbox")).toBe(0.5);
  });
});
