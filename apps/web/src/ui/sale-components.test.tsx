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
 * and run axe; these stay here so a change of role fails without a browser.
 */
const LABEL_FOR_PRICE =
  /<label [^>]*data-slot="field-label" for="preco">Preço cobrado<\/label>/;
const FIELDSET_WITH_LEGEND = /^<fieldset[^>]*><legend[^>]*>Forma de pagamento/;
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

  it("keeps title and description as text of the same region", () => {
    const markup = html(
      <Alert variant="warning">
        <AlertTitle>Sem internet.</AlertTitle>
        <AlertDescription>Pode vender.</AlertDescription>
      </Alert>
    );
    expect(markup).toContain("Sem internet.");
    expect(markup).toContain("Pode vender.");
  });
});

describe("Field", () => {
  it("ties the label to the control and the help to its description", () => {
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
    expect(markup).toContain('id="preco"');
    expect(markup).toContain('aria-describedby="preco-ajuda"');
    // the field itself is no nameless group
    expect(markup).not.toContain('data-slot="field" role=');
  });

  it("announces an error with role alert and an icon hidden from the screen reader", () => {
    const markup = html(<FieldError>Informe um preço.</FieldError>);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("Informe um preço.");
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

  it("gives a checkbox with its state and no visible mark when unchecked", () => {
    const markup = html(<Checkbox aria-label="Pretendo antecipar" />);
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain('aria-label="Pretendo antecipar"');
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
  });

  it("lets a later height replace a control height of the theme", () => {
    expect(cn("h-ctl-md", "h-auto")).toBe("h-auto");
    expect(cn("size-ctl-md", "size-8")).toBe("size-8");
  });
});
