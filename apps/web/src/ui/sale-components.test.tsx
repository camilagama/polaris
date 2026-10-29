import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { ButtonGroup } from "@/ui/button-group";
import { Card, CardDescription, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Separator } from "@/ui/separator";

/**
 * The markup of the components of the sale (ADR 0103, section 8, item 3): the role and the name each one gives
 * the screen reader. The browser checks (e2e-pwa/ui-components.e2e.ts) find the same ones by role and label
 * and run axe; these stay here so a change of role fails without a browser. The name a radio or a checkbox
 * gets from its <label> is computed by the browser (Base UI ties it at runtime): the e2e proves that one.
 */
const LABEL_FOR_PRICE =
  /<label [^>]*data-slot="field-label" for="preco">Preço cobrado<\/label>/;
const FIELDSET_WITH_LEGEND = /^<fieldset[^>]*><legend[^>]*>Forma de pagamento/;
const ALERT_REGION =
  /^<div [^>]*role="status"[^>]*>.*Sem internet\..*Pode vender\..*<\/div>$/;
const FIELD_TAG = /<div [^>]*data-slot="field"[^>]*>/;
const GROUP_TAG = /<div [^>]*data-slot="input-group"[^>]*>/;
const ROLE = /\srole=/;
const ADDON_TEXT = /data-slot="input-group-addon"[^>]*>R\$<\/div>/;
const HIDDEN_MARK = /<svg [^>]*aria-hidden="true"/;
const BADGE_AS_TEXT = /^<span[^>]*>Offline · 3<\/span>$/;

const html = (node: React.ReactNode) => renderToStaticMarkup(node);

describe("Alert", () => {
  it("interrupts only for an error: alert in the destructive variant, status otherwise", () => {
    expect(html(<Alert variant="destructive">x</Alert>)).toContain(
      'role="alert"'
    );
    expect(html(<Alert variant="warning">x</Alert>)).toContain('role="status"');
    expect(html(<Alert>x</Alert>)).toContain('role="status"');
  });

  it("keeps title and description inside the announced region", () => {
    const markup = html(
      <Alert variant="warning">
        <AlertTitle>Sem internet.</AlertTitle>
        <AlertDescription>Pode vender.</AlertDescription>
      </Alert>
    );
    expect(markup).toMatch(ALERT_REGION);
  });
});

describe("Field", () => {
  it("labels the control, adds no role of its own and keeps the R$ as text", () => {
    const markup = html(
      <Field>
        <FieldLabel htmlFor="preco">Preço cobrado</FieldLabel>
        <InputGroup>
          <InputGroupAddon>R$</InputGroupAddon>
          <InputGroupInput aria-describedby="preco-ajuda" id="preco" />
        </InputGroup>
        <FieldDescription id="preco-ajuda">Tabela: R$ 50,00</FieldDescription>
      </Field>
    );
    expect(markup).toMatch(LABEL_FOR_PRICE);
    // neither the field nor the "R$" wrapper is a nameless group, and the "R$" stays readable text
    expect(markup.match(FIELD_TAG)?.[0]).not.toMatch(ROLE);
    expect(markup.match(GROUP_TAG)?.[0]).not.toMatch(ROLE);
    expect(markup).toMatch(ADDON_TEXT);
  });

  it("announces an error with role alert and an icon hidden from the screen reader", () => {
    const markup = html(<FieldError>Informe um preço.</FieldError>);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Informe um preço.");
  });

  it("says an error rewritten at each key as a polite status, with the same icon", () => {
    const markup = html(<FieldError live="polite">Use até 64.</FieldError>);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Use até 64.");
  });

  it("renders no error without a message", () => {
    expect(html(<FieldError />)).toBe("");
  });

  it("names a set of fields by its legend", () => {
    const markup = html(
      <FieldSet>
        <FieldLegend variant="label">Forma de pagamento</FieldLegend>
      </FieldSet>
    );
    expect(markup).toMatch(FIELDSET_WITH_LEGEND);
  });
});

describe("RadioGroup and Checkbox", () => {
  it("give a radiogroup of radios with the checked state", () => {
    const markup = html(
      <RadioGroup aria-label="Forma de pagamento" defaultValue="pix">
        <RadioGroupItem aria-label="Pix" value="pix" />
        <RadioGroupItem aria-label="Dinheiro" value="dinheiro" />
      </RadioGroup>
    );
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-checked="false"');
  });

  it("gives a checkbox with its state, and the mark (hidden from the screen reader) only when checked", () => {
    const unchecked = html(<Checkbox aria-label="Pretendo antecipar" />);
    expect(unchecked).toContain('role="checkbox"');
    expect(unchecked).toContain('aria-checked="false"');
    expect(unchecked).not.toContain("<svg");
    const checked = html(
      <Checkbox aria-label="Pretendo antecipar" defaultChecked />
    );
    expect(checked).toContain('aria-checked="true"');
    expect(checked).toMatch(HIDDEN_MARK);
  });
});

describe("Card, Badge, ButtonGroup and Separator", () => {
  it("lets the screen give the card title its heading level", () => {
    const markup = html(
      <Card>
        <CardHeader>
          <CardTitle aria-level={2} role="heading">
            Itens
          </CardTitle>
          <CardDescription>2 itens</CardDescription>
        </CardHeader>
      </Card>
    );
    expect(markup).toContain('aria-level="2"');
    expect(markup).toContain('role="heading"');
  });

  it("keeps the badge as text", () => {
    expect(html(<Badge variant="warning">Offline · 3</Badge>)).toMatch(
      BADGE_AS_TEXT
    );
  });

  it("makes the stepper a group named by the caller", () => {
    expect(html(<ButtonGroup aria-label="Quantidade" />)).toContain(
      'role="group" aria-label="Quantidade"'
    );
  });

  it("gives a separator", () => {
    expect(html(<Separator />)).toContain('role="separator"');
  });
});

describe("cn", () => {
  // one class per argument: the formatter sorts the classes inside a string, which would undo the order tested here
  it("keeps the type sizes of the theme next to a text color", () => {
    expect(cn("text-support", "text-muted-foreground")).toBe(
      "text-support text-muted-foreground"
    );
    expect(cn("text-section", "text-destructive")).toBe(
      "text-section text-destructive"
    );
    expect(cn("text-sm", "text-support")).toBe("text-support");
    expect(cn("text-value-lg", "text-foreground")).toBe(
      "text-value-lg text-foreground"
    );
  });

  it("lets a later height replace a control height of the theme", () => {
    expect(cn("h-ctl-md", "h-auto")).toBe("h-auto");
    expect(cn("size-ctl-md", "size-8")).toBe("size-8");
  });
});
