import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";

const LONG = "Material de embalagem e limpeza do ateliê";
const ITEMS = [
  { label: "Aluguel", value: "a" },
  { label: LONG, value: "b" },
];

const field = (value: string | null, placeholder = "Escolha uma categoria") =>
  renderToStaticMarkup(
    <Select items={ITEMS} value={value}>
      <SelectTrigger aria-label="Categoria" className="w-full min-w-0">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

const tag = (markup: string, pattern: RegExp) =>
  markup.match(pattern)?.[0] ?? "";
const FIXED_HEIGHT = /(?<![-\w])data-\[size=default\]:(?:touch:)?h-/;
const TRIGGER = /<button[^>]*data-slot="select-trigger"[^>]*>/;
const VALUE = /<span[^>]*data-slot="select-value"[^>]*>/;

describe("o valor do Select", () => {
  it("o campo tem altura mínima, não fixa, para o valor longo crescer", () => {
    const trigger = tag(field("b"), TRIGGER);
    expect(trigger).toContain("data-[size=default]:min-h-ctl-md");
    expect(trigger).toContain("data-[size=default]:touch:min-h-11");
    expect(trigger).not.toMatch(FIXED_HEIGHT);
  });

  it("o valor quebra em até duas linhas, em palavra sem espaço também, antes das reticências", () => {
    const value = tag(field("b"), VALUE);
    expect(value).toContain("min-w-0");
    expect(value).toContain("line-clamp-2");
    expect(value).toContain("whitespace-normal");
    expect(value).toContain("[overflow-wrap:anywhere]");
    expect(value).not.toContain("line-clamp-1");
  });

  it("o valor inteiro fica no DOM e no title, para as reticências não esconderem a escolha", () => {
    const markup = field("b");
    expect(tag(markup, VALUE)).toContain(`title="${LONG}"`);
    expect(markup).toContain(`>${LONG}</span>`);
  });

  it("o texto de convite segue a mesma regra", () => {
    const value = tag(field(null), VALUE);
    expect(value).toContain('title="Escolha uma categoria"');
    expect(value).toContain("line-clamp-2");
  });

  it("o nome acessível do gatilho continua o do campo", () => {
    expect(tag(field("b"), TRIGGER)).toContain('aria-label="Categoria"');
  });
});
