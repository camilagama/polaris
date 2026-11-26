import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "../../../scripts/verify-no-history-comments.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = join(WEB, "..", "..");
const SUITE_PATH = join(WEB, "real-devices", "suite.ts");
const WILDCARD = "\u0000";

type Kind =
  | "attribute"
  | "chunk"
  | "id"
  | "name"
  | "route"
  | "screen"
  | "testid"
  | "text";

interface Expectation {
  kind: Kind;
  line: number;
  origin: string;
  value: string;
}

/**
 * Onde a suíte do Gate 5 chama cada ajudante com um texto ou seletor do produto: `arg` é a posição do argumento.
 * Ajudante novo que receba texto do produto entra aqui, senão a guarda não o vê.
 */
const CALLS: {
  arg: number;
  as: "id-suffix" | "selector" | "text" | Kind;
  name: string;
  optional?: boolean;
}[] = [
  { arg: 1, as: "text", name: "waitForText" },
  { arg: 1, as: "text", name: "clickButtonContaining" },
  { arg: 2, as: "selector", name: "clickButtonContaining", optional: true },
  { arg: 1, as: "text", name: "control" },
  { arg: 2, as: "text", name: "waitForCardState" },
  { arg: 1, as: "text", name: "setChecked" },
  { arg: 1, as: "text", name: "startRuntime" },
  { arg: 0, as: "text", name: "popoverButton" },
  { arg: 1, as: "selector", name: "chooseFromSelect" },
  { arg: 2, as: "text", name: "chooseFromSelect" },
  { arg: 1, as: "selector", name: "click" },
  { arg: 1, as: "selector", name: "tapInPopover" },
  { arg: 1, as: "testid", name: "waitForTestId" },
  { arg: 1, as: "id-suffix", name: "chooseMethod" },
  { arg: 1, as: "screen", name: "openScreensLab" },
  { arg: 0, as: "selector", name: "browser.\\$" },
  { arg: 0, as: "selector", name: "\\.querySelector" },
  { arg: 0, as: "selector", name: "\\.querySelectorAll" },
  { arg: 0, as: "id", name: "\\.getElementById" },
  { arg: 0, as: "route", name: "shellUrl" },
  { arg: 0, as: "route", name: "labUrl" },
];

const CONST_DECLARATION = /^\s*const (\w+) = (.+);$/gm;
const DECLARED = /^\s*(?:const|let) (\w+)\b/gm;
const ARROW_PARAMETERS = /\(([^()]*)\)\s*(?::\s*[^=]+)?=>|\b(\w+)\s*=>/g;
const SIGNATURE =
  /^\s*(?:export )?(?:async function \w+|function \w+|const \w+ = (?:async )?)\(([^)]*)\)/gm;
const PARAMETER_NAME = /(\w+)\??\s*(?::|=|,|$)/g;
const PARAMETER = "\u0001";
const STRING_LITERAL = /^(["'])((?:(?!\1)[^\\]|\\.)*)\1$/;
const ASSET_PREFIX = /^\/assets\//;
const TRAILING_DASH = /-$/;
const AS_NEVER = / as never$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
const TEXT_SELECTOR = /^[a-z]+=(.+)$/;
const TEXT_SUFFIX = /\*=.*$/;
const SCREEN_PARAM = /(?:^|&)screen=([^&]+)/;
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\./;
const DATA_PREFIX = /^data-/;
const NOT_READABLE = /não sabe ler/;
const TEMPLATE_LITERAL = /^`((?:[^`\\]|\\.)*)`$/;

const WINDOWS = [16, 8, 4, 1];

/** Para cada posição do texto sem comentários, a posição no original: a linha acusada é a de `suite.ts`. */
function offsetsOf(original: string, stripped: string) {
  const map: number[] = [];
  let at = 0;
  for (let index = 0; index < stripped.length; index += 1) {
    const aligned = WINDOWS.some((size) =>
      original.startsWith(stripped.slice(index, index + size), at)
    );
    if (!aligned) {
      for (const size of WINDOWS) {
        const next = original.indexOf(stripped.slice(index, index + size), at);
        if (next !== -1) {
          at = next;
          break;
        }
      }
    }
    map.push(at);
    at += 1;
  }
  return map;
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

function unquote(text: string) {
  return text.replace(/\\(.)/g, "$1");
}

const AWAITED_HANDLE = /^\(?await /;
const NESTED_CALL = /^([\w.$]+)\(/;

function isCheckedCall(argument: string) {
  const name = NESTED_CALL.exec(argument.trim())?.[1];
  return CALLS.some((call) => call.name.replaceAll("\\", "") === name);
}

/**
 * Os nomes que a suíte resolve para um texto (`const NOME = "…"`, em qualquer recuo) e os que são valor de execução
 * (parâmetro de ajudante, resultado de uma chamada): um nome fora dos dois grupos, usado onde se espera texto, é
 * argumento que a guarda não sabe ler.
 */
function constants(source: string) {
  const found = new Map<string, string>();
  const runtime = new Set<string>();
  for (const [, name, expression] of source.matchAll(CONST_DECLARATION)) {
    if (!name) {
      continue;
    }
    const value = literal(expression ?? "", found, false);
    if (typeof value === "string" && value !== "param") {
      found.set(name, value);
    } else {
      runtime.add(name);
    }
  }
  for (const [, name] of source.matchAll(DECLARED)) {
    runtime.add(name ?? "");
  }
  for (const [, list, single] of source.matchAll(ARROW_PARAMETERS)) {
    for (const [, name] of (list ?? single ?? "").matchAll(PARAMETER_NAME)) {
      runtime.add(name ?? "");
    }
  }
  for (const [, list] of source.matchAll(SIGNATURE)) {
    for (const [, name] of (list ?? "").matchAll(PARAMETER_NAME)) {
      runtime.add(name ?? "");
    }
  }
  for (const name of runtime) {
    if (!found.has(name)) {
      found.set(name, PARAMETER);
    }
  }
  return found;
}

/** O texto de um literal (com as constantes e `${parâmetro}` resolvidos), `"param"` para um nome solto, ou `undefined`. */
function literal(
  expression: string,
  known: Map<string, string>,
  strict: boolean
): string | "param" | undefined {
  const text = expression.trim().replace(AS_NEVER, "");
  const plain = STRING_LITERAL.exec(text);
  if (plain) {
    return unquote(plain[2] ?? "");
  }
  const template = TEMPLATE_LITERAL.exec(text);
  if (template) {
    return unquote(
      (template[1] ?? "").replace(/\$\{([^}]*)\}/g, (_, inner: string) => {
        const value = known.get(inner.trim());
        return value === undefined || value === PARAMETER ? WILDCARD : value;
      })
    );
  }
  const name = IDENTIFIER.exec(text)?.[0];
  if (name) {
    const value = known.get(name);
    if (value === PARAMETER) {
      return "param";
    }
    if (value !== undefined) {
      return value;
    }
    if (!strict) {
      return undefined;
    }
  }
  if (AWAITED_HANDLE.test(text)) {
    return "param";
  }
  if (strict) {
    throw new Error(
      `argumento que a guarda não sabe ler: ${text.slice(0, 80)}`
    );
  }
  return undefined;
}

function splitArguments(source: string, open: number) {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let index = open; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      current += char;
      if (char === "\\") {
        index += 1;
        current += source[index] ?? "";
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if ("([{".includes(char)) {
      depth += 1;
    } else if (")]}".includes(char)) {
      depth -= 1;
      if (depth < 0) {
        parts.push(current);
        return parts.map((part) => part.trim()).filter(Boolean);
      }
    } else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  throw new Error("chamada sem fechar parênteses");
}

function selectorExpectations(
  selector: string,
  line: number,
  origin: string
): Expectation[] {
  const found: Expectation[] = [];
  const add = (kind: Kind, value: string) => {
    if (value) {
      found.push({ kind, line, origin, value });
    }
  };
  if (selector.startsWith("//")) {
    for (const [, label] of selector.matchAll(/@aria-label="([^"]+)"/g)) {
      add("text", label ?? "");
    }
    return found;
  }
  const byText = TEXT_SELECTOR.exec(selector);
  if (byText) {
    add("text", byText[1] ?? "");
    return found;
  }
  const withoutText = selector.replace(TEXT_SUFFIX, "");
  for (const [, id] of withoutText.matchAll(/#([^\s[\].#:>,"']+)/g)) {
    add("id", id ?? "");
  }
  for (const [, name] of withoutText.matchAll(/\[(data-[\w-]+)/g)) {
    add("attribute", name ?? "");
  }
  for (const [, id] of withoutText.matchAll(/\[for="([^"]+)"\]/g)) {
    add("id", id ?? "");
  }
  for (const [, label] of withoutText.matchAll(
    /\[aria-label\^?="([^"]+?),?"\]/g
  )) {
    add("text", label ?? "");
  }
  return found;
}

function routeExpectations(route: string, line: number, origin: string) {
  const [path = "", query = ""] = route.split("?");
  const found: Expectation[] = [];
  if (path !== "/") {
    found.push({ kind: "route", line, origin, value: path });
  }
  const screen = SCREEN_PARAM.exec(query)?.[1];
  if (screen && screen !== WILDCARD) {
    found.push({ kind: "screen", line, origin, value: screen });
  }
  return found;
}

/** Tudo o que a suíte espera achar na tela, com a linha em que espera. */
function extractExpectations(suiteSource: string): Expectation[] {
  const source = stripComments(suiteSource);
  const offsets = offsetsOf(suiteSource, source);
  const lineAt = (index: number) => lineOf(suiteSource, offsets[index] ?? 0);
  const known = constants(source);
  const found: Expectation[] = [];

  for (const call of CALLS) {
    const pattern = new RegExp(
      `${call.name.startsWith("\\.") ? "" : "(?<![\\w.$])"}${call.name}\\(`,
      "g"
    );
    for (const match of source.matchAll(pattern)) {
      if (source.slice(0, match.index).trimEnd().endsWith("function")) {
        continue;
      }
      const line = lineAt(match.index);
      const argument = splitArguments(source, match.index + match[0].length)[
        call.arg
      ];
      if (argument === undefined && call.optional) {
        continue;
      }
      if (argument === undefined) {
        throw new Error(
          `suite.ts:${line}: ${call.name} sem o argumento ${call.arg}`
        );
      }
      const value = isCheckedCall(argument)
        ? "param"
        : literal(argument, known, true);
      if (value === undefined || value === "param") {
        continue;
      }
      const origin = call.name.replaceAll("\\", "");
      if (call.as === "selector") {
        found.push(...selectorExpectations(value, line, origin));
      } else if (call.as === "route") {
        found.push(...routeExpectations(value, line, origin));
      } else if (call.as === "id-suffix") {
        found.push({ kind: "id", line, origin, value: `sale-method-${value}` });
      } else {
        found.push({ kind: call.as, line, origin, value });
      }
    }
  }

  const direct: [RegExp, Kind, string][] = [
    [/entry\.name\.includes\("([^"]+)"\)/g, "chunk", "includes"],
    [/(?<!name)\.includes\("([^"]+)"\)/g, "text", "includes"],
    [
      /(?:textContent\?\.trim\(\)|where\.focus) [!=]== "([^"]+)"/g,
      "text",
      "comparação",
    ],
    [/\.dataset\.(\w+)/g, "attribute", "dataset"],
    [/history\.state\?\.(\w+)/g, "name", "history.state"],
  ];
  for (const [pattern, kind, origin] of direct) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1] ?? "";
      const value =
        origin === "dataset"
          ? `data-${raw.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`)}`
          : raw;
      found.push({ kind, line: lineAt(match.index), origin, value });
    }
  }
  return found;
}

/**
 * Argumentos literais de ajudantes da suíte que são dado de teste ou modo, não texto do produto (nome e telefone
 * digitados, nome de captura, valor esperado de um contador): a guarda não os confere e não os confunde com os outros.
 */
const DATA_ARGUMENTS: Record<string, number[]> = {
  openCompetence: [1],
  openScreensLab: [2],
  registerCustomer: [1, 2],
  screenshot: [1],
  setReloadMark: [1],
  waitForCardState: [1],
  waitForCardSynced: [1],
  waitForTestId: [2],
};

const LOCAL_HELPER =
  /^\s*(?:export )?(?:async function (\w+)|function (\w+)|const (\w+) = (?:async )?\()/gm;
const ANY_LITERAL = /^(?:["'`])/;

/**
 * Chamadas a ajudantes da própria suíte com um literal que nem a lista CALLS nem DATA_ARGUMENTS classificam: sem isso
 * um ajudante novo (como o `waitForCardState`) passaria a esperar um texto que a guarda nunca confere.
 */
function unclassifiedLiterals(suiteSource: string) {
  const code = stripComments(suiteSource);
  const offsets = offsetsOf(suiteSource, code);
  const known = constants(code);
  const helpers = new Set(
    [...code.matchAll(LOCAL_HELPER)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? ""
    )
  );
  const found: string[] = [];
  for (const helper of helpers) {
    const pattern = new RegExp(`(?<![\\w.$])${helper}\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      if (code.slice(0, match.index).trimEnd().endsWith("function")) {
        continue;
      }
      const args = splitArguments(code, match.index + match[0].length);
      args.forEach((argument, index) => {
        const covered =
          CALLS.some((call) => call.name === helper && call.arg === index) ||
          DATA_ARGUMENTS[helper]?.includes(index);
        const text = literal(argument, known, false);
        if (
          !covered &&
          ANY_LITERAL.test(argument.trim()) &&
          text !== undefined
        ) {
          found.push(
            `${helper}(argumento ${index}: ${argument.slice(0, 40)}) em suite.ts:${lineOf(suiteSource, offsets[match.index] ?? 0)}`
          );
        }
      });
    }
  }
  return found;
}

const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "e2e", "e2e-pwa"]);

function isProductFile(name: string) {
  return SOURCE_FILE.test(name) && !TEST_FILE.test(name);
}

function walk(directory: string, into: string[]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name)) {
        walk(join(directory, entry.name), into);
      }
    } else if (isProductFile(entry.name)) {
      into.push(join(directory, entry.name));
    }
  }
}

/** Código de produto e dos laboratórios sem comentários: texto só em comentário não conta como existir. */
function loadProduct() {
  const files: string[] = [];
  for (const base of [
    join(WEB, "src"),
    join(REPOSITORY, "packages", "domain", "src"),
    join(REPOSITORY, "packages", "contracts", "src"),
  ]) {
    walk(base, files);
  }
  const product = new Map<string, string>();
  for (const file of files) {
    product.set(
      relative(REPOSITORY, file),
      collapse(stripComments(readFileSync(file, "utf8")))
    );
  }
  product.set(
    "apps/web/index.html",
    collapse(readFileSync(join(WEB, "index.html"), "utf8"))
  );
  return product;
}

/**
 * Texto que a tela monta em pedaços (um `join`, um `${}` de fase): a suíte espera o texto inteiro, a guarda exige os
 * pedaços. Entra aqui só o que o código de produto não traz inteiro; a lista é exata e o teste reprova sobra.
 */
const COMPOSED_TEXTS: Record<string, string[]> = {
  "Camiseta do laboratório · Azul": ["Camiseta do laboratório", "Azul"],
  "Iniciar: ok (ready)": ["Iniciar: ok ("],
  "Sem conexão · 1 operação guardada": ["Sem conexão", "operação guardada"],
};

const collapse = (text: string) => text.replace(/\s+/g, " ");

function fragmentsOf(value: string) {
  const composed = COMPOSED_TEXTS[value];
  if (composed) {
    return composed;
  }
  return value
    .split(new RegExp(`${WILDCARD}|\\d+`))
    .map((part) => collapse(part).trim())
    .filter((part) => part.length >= 3);
}

const TEMPLATE_ID =
  /(?:(?<![\w-])id\s*[=:]|fieldProps\()\s*\{?\s*`([^`$]*)\$\{/g;
const templateIdCache = new WeakMap<Map<string, string>, string[]>();

function templateIds(files: Map<string, string>) {
  const cached = templateIdCache.get(files);
  if (cached) {
    return cached;
  }
  const heads = [...files.values()].flatMap((text) =>
    [...text.matchAll(TEMPLATE_ID)].map((match) => match[1] ?? "")
  );
  templateIdCache.set(files, heads);
  return heads;
}

const quoted = (name: string) => `["'\`]${name}["'\`]`;

function existsInProduct(expectation: Expectation, files: Map<string, string>) {
  const { kind, value } = expectation;
  const entries = [...files.entries()];
  switch (kind) {
    case "text": {
      const fragments = fragmentsOf(value);
      return (
        fragments.length > 0 &&
        entries.some(([, text]) =>
          fragments.every((fragment) => text.includes(fragment))
        )
      );
    }
    case "id": {
      const prefix = value.split(WILDCARD)[0] ?? "";
      const literalId = new RegExp(
        `(?:(?<![\\w-])id\\s*[=:]|fieldProps\\()\\s*\\{?\\s*${quoted(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}`
      );
      const templateId = templateIds(files);
      return (
        entries.some(
          ([path, text]) =>
            literalId.test(text) ||
            (path.endsWith(".html") && text.includes(`id="${prefix}"`))
        ) || templateId.some((head) => head !== "" && prefix.startsWith(head))
      );
    }
    case "attribute":
      return entries.some(([, text]) => {
        const camel = value
          .replace(DATA_PREFIX, "")
          .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        return (
          new RegExp(`(?<![\\w-])${value}(?![\\w-])`).test(text) ||
          text.includes(`dataset.${camel}`)
        );
      });
    case "testid":
      return entries.some(([, text]) =>
        new RegExp(`data-testid=\\{?${quoted(value)}`).test(text)
      );
    case "route":
      return entries.some(([, text]) => new RegExp(quoted(value)).test(text));
    case "screen":
      return entries.some(
        ([path, text]) =>
          path.endsWith("offline-poc/screens-lab.tsx") &&
          new RegExp(quoted(value)).test(text)
      );
    case "chunk":
      return entries.some(([, text]) =>
        text.includes(
          value.replace(ASSET_PREFIX, "").replace(TRAILING_DASH, "")
        )
      );
    case "name":
      return entries.some(([, text]) => text.includes(value));
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** Cada expectativa da suíte que o produto não tem mais, como linha legível. */
function findDrift(suiteSource: string, files: Map<string, string>) {
  const unique = new Map<string, Expectation>();
  for (const expectation of extractExpectations(suiteSource)) {
    const key = `${expectation.kind}\u0001${expectation.value}`;
    if (!unique.has(key)) {
      unique.set(key, expectation);
    }
  }
  return [...unique.values()]
    .filter((expectation) => !existsInProduct(expectation, files))
    .map(
      (expectation) =>
        `${expectation.kind} ${JSON.stringify(expectation.value.replace(WILDCARD, "…"))} (${expectation.origin}, suite.ts:${expectation.line})`
    );
}

/**
 * Expectativas que a guarda já acusa na suíte e que ainda não foram corrigidas nela. A lista é exata: quando a suíte
 * passa a usar o endereço certo, a entrada tem de sair, e o teste reprova se ela ficar sem motivo.
 */
const KNOWN_DRIFT: { entry: string; reason: string }[] = [];

const SUITE_SOURCE = readFileSync(SUITE_PATH, "utf8");
const PRODUCT = loadProduct();

describe("deriva da suíte do Gate 5 (real-devices/suite.ts)", () => {
  it("cada seletor e texto que a suíte espera existe no produto ou no laboratório", () => {
    const pending = findDrift(SUITE_SOURCE, PRODUCT).filter(
      (line) => !KNOWN_DRIFT.some((known) => line.startsWith(known.entry))
    );
    expect(
      pending,
      "A suíte espera algo que a tela não tem mais. Veja docs/runbooks/gate-5-offline.md, seção 'Guarda de deriva da suíte'."
    ).toEqual([]);
  });

  it("a lista de deriva conhecida só tem o que ainda reprova", () => {
    const drift = findDrift(SUITE_SOURCE, PRODUCT);
    expect(
      KNOWN_DRIFT.filter(
        (known) => !drift.some((line) => line.startsWith(known.entry))
      )
    ).toEqual([]);
  });

  it("extrai o que a suíte espera e não passa com extração vazia", () => {
    const found = extractExpectations(SUITE_SOURCE);
    const has = (kind: Kind, value: string) =>
      found.some((item) => item.kind === kind && item.value === value);
    for (const id of ["customer-name", "customer-phone", "sale-profile"]) {
      expect(has("id", id), `#${id}`).toBe(true);
    }
    for (const text of [
      "Novo cliente",
      "Aguardando envio",
      "Venda guardada neste aparelho",
      "Pode vender: a venda fica guardada neste aparelho",
      "Data de competência",
    ]) {
      expect(has("text", text), text).toBe(true);
    }
    expect(has("attribute", "data-day")).toBe(true);
    const perKind = (kind: Kind) =>
      found.filter((item) => item.kind === kind).length;
    expect(perKind("text")).toBeGreaterThanOrEqual(20);
    expect(perKind("id")).toBeGreaterThanOrEqual(3);
    expect(perKind("attribute")).toBeGreaterThanOrEqual(5);
    expect(perKind("route")).toBeGreaterThanOrEqual(3);
    expect(perKind("testid")).toBeGreaterThanOrEqual(1);
  });

  it("nenhum ajudante da suíte recebe um literal que a guarda não classificou", () => {
    expect(unclassifiedLiterals(SUITE_SOURCE)).toEqual([]);
  });

  it("os textos montados em pedaços são só os que o produto não traz inteiros", () => {
    const found = extractExpectations(SUITE_SOURCE).map((item) => item.value);
    for (const text of Object.keys(COMPOSED_TEXTS)) {
      expect(found, text).toContain(text);
      const whole = [...PRODUCT.values()].some((file) => file.includes(text));
      expect(whole, `${text} já existe inteiro no produto`).toBe(false);
    }
  });

  describe("controles plantados", () => {
    it("reprova a cópia da suíte com um seletor renomeado", () => {
      const renamed = SUITE_SOURCE.replaceAll(
        "#customer-name",
        "#customer-nome"
      );
      expect(renamed).not.toBe(SUITE_SOURCE);
      expect(findDrift(renamed, PRODUCT).join("\n")).toContain(
        'id "customer-nome" (browser.$'
      );
    });

    it("reprova a cópia da suíte com um texto trocado", () => {
      const changed = SUITE_SOURCE.replace(
        '"button=Novo cliente"',
        '"button=Adicionar cliente"'
      );
      expect(changed).not.toBe(SUITE_SOURCE);
      expect(findDrift(changed, PRODUCT).join("\n")).toContain(
        'text "Adicionar cliente"'
      );
    });

    it("reprova o texto que a suíte espera e a tela perdeu", () => {
      const without = new Map(PRODUCT);
      const form = "apps/web/src/customers/customer-form.tsx";
      const text = without.get(form) ?? "";
      expect(text).toContain('id="customer-name"');
      without.set(form, text.replaceAll('id="customer-name"', 'id="nome"'));
      expect(findDrift(SUITE_SOURCE, without).join("\n")).toContain(
        'id "customer-name"'
      );
    });

    it.each([
      [
        "atributo",
        "data-row-open",
        "data-row-abrir",
        'attribute "data-row-abrir"',
      ],
      [
        "id de teste",
        '"server-records"',
        '"server-registros"',
        'testid "server-registros"',
      ],
      [
        "endereço",
        '"/ui-galeria"',
        '"/ui-galeria-nova"',
        'route "/ui-galeria-nova"',
      ],
      [
        "tela do laboratório",
        "?screen=expenses",
        "?screen=despesas",
        'screen "despesas"',
      ],
      [
        "camada sob demanda",
        "/assets/filter-bar-motion-",
        "/assets/filter-bar-movimento-",
        'chunk "/assets/filter-bar-movimento-"',
      ],
      [
        "chave do histórico",
        "polarisDialog",
        "polarisFormulario",
        'name "polarisFormulario"',
      ],
      [
        "dataset",
        "dataset.motion",
        "dataset.movimento",
        'attribute "data-movimento"',
      ],
      [
        "texto em includes",
        '"O calendário não abriu."',
        '"O calendário falhou."',
        'text "O calendário falhou."',
      ],
      [
        "texto em comparação",
        '!== "Abrir formulário"',
        '!== "Abrir cadastro"',
        'text "Abrir cadastro"',
      ],
      [
        "rótulo de campo",
        '"Quantidade"',
        '"Qtd. de itens"',
        'text "Qtd. de itens"',
      ],
      [
        "aria-label do seletor",
        'const COMPETENCE = "Data de competência"',
        'const COMPETENCE = "Data do gasto"',
        'text "Data do gasto"',
      ],
    ])("reprova a cópia da suíte com %s renomeado", (_, from, to, expected) => {
      const changed = SUITE_SOURCE.replaceAll(from, to);
      expect(changed).not.toBe(SUITE_SOURCE);
      expect(findDrift(changed, PRODUCT).join("\n")).toContain(expected);
    });

    it("reprova o texto montado em pedaços quando um pedaço some do produto", () => {
      const without = new Map(
        [...PRODUCT].map(([path, text]) => [
          path,
          text.replaceAll("operação guardada", "operação"),
        ])
      );
      expect(findDrift(SUITE_SOURCE, without).join("\n")).toContain(
        'text "Sem conexão · 1 operação guardada"'
      );
    });

    it("acusa a linha de suite.ts em que a chamada está, com comentários antes dela", () => {
      const suite = [
        "/**",
        " * Um comentário de bloco",
        " * de várias linhas.",
        " */",
        "// Novo cliente só em comentário",
        'await waitForText(browser, "Texto que sumiu");',
      ].join("\n");
      expect(findDrift(suite, new Map())).toEqual([
        'text "Texto que sumiu" (waitForText, suite.ts:6)',
      ]);
    });

    it("não conta texto que só aparece em comentário", () => {
      const onlyComment = new Map([
        [
          "apps/web/src/a.tsx",
          stripComments("// Aguardando envio do cliente\nexport const a = 1;"),
        ],
      ]);
      const suite = 'await waitForText(browser, "Aguardando envio");';
      expect(findDrift(suite, onlyComment)).toEqual([
        'text "Aguardando envio" (waitForText, suite.ts:1)',
      ]);
    });

    it("acusa um ajudante novo que recebe texto sem estar classificado", () => {
      const suite = [
        "async function waitForBadge(browser: Browser, text: string) {}",
        'await waitForBadge(browser, "Aguardando envio");',
      ].join("\n");
      expect(unclassifiedLiterals(suite)).toHaveLength(1);
    });

    it("recusa um nome que não é constante nem parâmetro, em vez de deixar de conferir", () => {
      expect(() =>
        extractExpectations("await waitForText(browser, misterio);")
      ).toThrow(NOT_READABLE);
    });

    it("confere a constante local indentada e não só as de coluna 0", () => {
      const suite = [
        "async function run(browser: Browser) {",
        '  const shirt = "Camiseta que sumiu";',
        "  await waitForText(browser, shirt);",
        "}",
      ].join("\n");
      expect(findDrift(suite, new Map())).toEqual([
        'text "Camiseta que sumiu" (waitForText, suite.ts:3)',
      ]);
    });

    it("recusa um argumento que não sabe ler, em vez de deixar de conferir", () => {
      expect(() =>
        extractExpectations('await waitForText(browser, pick("a"));')
      ).toThrow(NOT_READABLE);
    });

    it("a lista de chamadas conferidas cobre os ajudantes da suíte", () => {
      const names = new Set(CALLS.map((call) => call.name));
      const helpers = [
        ...stripComments(SUITE_SOURCE).matchAll(
          /^(?:async function|const) (\w+)\b/gm
        ),
      ].map((match) => match[1] ?? "");
      for (const helper of [
        "waitForText",
        "clickButtonContaining",
        "control",
      ]) {
        expect(helpers).toContain(helper);
        expect(names.has(helper)).toBe(true);
      }
    });
  });
});
