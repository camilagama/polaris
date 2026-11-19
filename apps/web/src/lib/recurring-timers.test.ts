import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface AllowedInterval {
  /** Whether the callback (or what it reaches) calls the server; the real list only holds `false`. */
  callsServer: boolean;
  file: string;
  intervalMs: string;
  reason: string;
  uses: number;
}

interface RealAllowedInterval extends AllowedInterval {
  callsServer: false;
}

const ADVICE =
  "um timer recorrente novo que chama o servidor gasta cota do Hyperdrive; registre aqui com o motivo e com o intervalo, e use a aba visível";

/** Every `setInterval(` of `apps/web/src` outside the tests. Add a line here only for a timer that never reaches the server. */
const ALLOWED_INTERVALS: readonly RealAllowedInterval[] = [
  {
    callsServer: false,
    file: "home/home-page.tsx",
    intervalMs: "60_000",
    reason: "relógio da tela sem conexão: só atualiza o `now` do estado local",
    uses: 1,
  },
  {
    callsServer: false,
    file: "lib/read-with-retry.ts",
    intervalMs: "CURRENT_CHECK_MS (250)",
    reason:
      "só pergunta se a tela ainda quer a resposta e aborta a chamada que já saiu; não inicia chamada",
    uses: 1,
  },
  {
    callsServer: false,
    file: "lib/use-now.ts",
    intervalMs: "intervalMs (parâmetro do chamador)",
    reason: "relógio local do aparelho para valores derivados de `agora`",
    uses: 1,
  },
  {
    callsServer: false,
    file: "lib/use-store-today.ts",
    intervalMs: "STORE_TODAY_TICK_MS",
    reason: "relê o dia da loja no relógio e no fuso locais",
    uses: 1,
  },
  {
    callsServer: false,
    file: "offline-poc/offline-persistence-lab.tsx",
    intervalMs: "500",
    reason: "laboratório de persistência offline, fora do app do lojista",
    uses: 1,
  },
  {
    callsServer: false,
    file: "pwa/runtime.ts",
    intervalMs: "CHECK_EVERY_MS (1 h)",
    reason:
      "`registration.update()` busca o `/sw.js` estático do mesmo servidor de arquivos, sem Worker de dados nem banco",
    uses: 1,
  },
  {
    callsServer: false,
    file: "settings/app-version-line.tsx",
    intervalMs: "READ_QUEUE_EVERY_MS (15 s)",
    reason:
      "`store.refreshWork()` só lê a fila local (IndexedDB) enquanto há versão nova esperando",
    uses: 1,
  },
];

/** The two recurring server pollers are chained `setTimeout`s; the exact lines pinned here are where the documentation of them lives. */
const SERVER_TIMER_ANCHORS = [
  {
    file: "offline/runtime/sync-scheduler.ts",
    line: "export const TICK_MS = 60_000;",
  },
  {
    file: "lib/connection.ts",
    line: "const PROBE_STEPS_MS = [2000, 4000, 8000] as const;",
  },
] as const;

/**
 * Textual limit, said on purpose: this finds `setInterval(` written out (also as `window.setInterval(` or
 * `globalThis.setInterval(`). It does NOT see a `setTimeout` that schedules itself again, a timer reached through an alias
 * (`const every = setInterval; every(...)`, `window["setInterval"]`), one made by a dependency, a `requestAnimationFrame`
 * loop, a `setInterval` written inside a template literal's `${}`, or one after a regex literal that holds a quote or a
 * backtick (the scanner takes it for a string). The server check reads the whole file, not the callback: a listed file
 * that imports a helper and calls it is not seen, so the reason of each entry is a claim a reviewer checks. The two server pollers of the app are chained
 * `setTimeout`s and are named in SERVER_TIMER_ANCHORS only so a reader finds them.
 */
const SET_INTERVAL = /\bsetInterval\s*\(/g;
const SERVER_CALL =
  /\borpcClient\b|\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bEventSource\b|\bWebSocket\b/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const QUOTE = /["'`]/;

/** The source with comments and the text of strings and templates turned into spaces (line breaks kept). */
function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < source.length) {
    const rest = source.slice(i, i + 2);
    if (rest === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (rest === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
    } else if (QUOTE.test(source[i] ?? "")) {
      const quote = source[i] as string;
      let j = i + 1;
      while (j < source.length && source[j] !== quote) {
        j += source[j] === "\\" ? 2 : 1;
        if (quote !== "`" && source[j] === "\n") {
          break;
        }
      }
      out += quote + blank(source.slice(i + 1, j)) + (source[j] ?? "");
      i = j + 1;
    } else {
      out += source[i];
      i += 1;
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function readSources(): Map<string, string> {
  return new Map(
    sourceFiles(SRC).map((path) => [
      relative(SRC, path).split("\\").join("/"),
      readFileSync(path, "utf8"),
    ])
  );
}

function usesOf(source: string): number {
  return codeOnly(source).match(SET_INTERVAL)?.length ?? 0;
}

/** Everything wrong with the `setInterval` uses of `files` against `allowed`; empty when the rule holds. */
function recurringTimerProblems(
  files: ReadonlyMap<string, string>,
  allowed: readonly AllowedInterval[]
): string[] {
  const problems: string[] = [];
  const byFile = new Map(allowed.map((entry) => [entry.file, entry]));
  for (const [file, source] of files) {
    const uses = usesOf(source);
    if (uses === 0) {
      continue;
    }
    const entry = byFile.get(file);
    if (!entry) {
      problems.push(
        `${file}: ${uses} setInterval( fora da lista ALLOWED_INTERVALS (regra: todo timer recorrente se registra); ${ADVICE}`
      );
      continue;
    }
    if (entry.uses !== uses) {
      problems.push(
        `${file}: ${uses} setInterval( e a lista diz ${entry.uses} (regra: contagem exata); ${ADVICE}`
      );
    }
    if (!entry.callsServer && SERVER_CALL.test(codeOnly(source))) {
      problems.push(
        `${file}: registrado como "chama o servidor: não" mas o arquivo tem chamada ao servidor (regra: timer recorrente sem servidor); ${ADVICE}`
      );
    }
  }
  for (const entry of allowed) {
    if (usesOf(files.get(entry.file) ?? "") === 0) {
      problems.push(
        `${entry.file}: está em ALLOWED_INTERVALS mas não tem mais setInterval( (regra: tire da lista o que saiu do código)`
      );
    }
  }
  return problems;
}

/** The `{ … }` that follows `header` in code already stripped by `codeOnly`; empty when the header is not found. */
function bodyOf(code: string, header: string): string {
  const start = code.indexOf(header);
  if (start === -1) {
    return "";
  }
  let depth = 0;
  for (let i = code.indexOf("{", start); i < code.length; i += 1) {
    if (code[i] === "{") {
      depth += 1;
    } else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return code.slice(start, i + 1);
      }
    }
  }
  return "";
}

const WORK_SOURCE_HEADER = "workSource(): PendingWorkSource {";

/** The body of `workSource()`, so the `read` is found from it and not as the first `read: async () => {` of the file. */
function workSourceBody(runtime: string): string {
  expect(
    runtime.split(WORK_SOURCE_HEADER),
    `âncora ausente ou duplicada: ${WORK_SOURCE_HEADER}`
  ).toHaveLength(2);
  return bodyOf(runtime, WORK_SOURCE_HEADER);
}

describe("timers recorrentes de apps/web/src", () => {
  it("todo setInterval( está registrado, com motivo, e nenhum chama o servidor", () => {
    const files = readSources();
    expect(files.has("lib/use-now.ts")).toBe(true);
    expect(recurringTimerProblems(files, ALLOWED_INTERVALS)).toEqual([]);
  });

  it("a lista registra cada uso, com com motivo, intervalo e sem servidor", () => {
    expect(ALLOWED_INTERVALS.map((entry) => entry.file)).toEqual(
      [...ALLOWED_INTERVALS.map((entry) => entry.file)].sort()
    );
    expect(ALLOWED_INTERVALS.reduce((sum, entry) => sum + entry.uses, 0)).toBe(
      7
    );
    for (const entry of ALLOWED_INTERVALS) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
      expect(entry.intervalMs, entry.file).not.toBe("");
      expect(entry.callsServer, entry.file).toBe(false);
    }
  });

  it("os dois pollers que chamam o servidor seguem onde estão documentados", () => {
    const files = readSources();
    for (const { file, line } of SERVER_TIMER_ANCHORS) {
      expect(files.get(file), file).toContain(line);
    }
    expect(files.get("offline/runtime/sync-scheduler.ts")).toContain(
      "isVisible()"
    );
  });

  it("o refreshWork do aviso de versão lê só a fila local", () => {
    const files = readSources();
    const store = codeOnly(files.get("pwa/update-store.ts") ?? "");
    const runtime = codeOnly(
      files.get("offline/runtime/offline-runtime.ts") ?? ""
    );
    const workSource = workSourceBody(runtime);
    const chain = [
      ["refreshWork", bodyOf(store, "async refreshWork() {"), "readWork()"],
      ["readWork", bodyOf(store, "async function readWork()"), "source.read()"],
      [
        "workSource.read",
        bodyOf(workSource, "read: async () => {"),
        "this.refreshCounts()",
      ],
      [
        "refreshCounts",
        bodyOf(runtime, "async refreshCounts(): Promise<void> {"),
        "stores.outbox.snapshot()",
      ],
    ] as const;
    for (const [name, body, calls] of chain) {
      expect(body, name).toContain(calls);
      expect(SERVER_CALL.test(body), name).toBe(false);
      expect(body, name).not.toContain("source.sync");
      expect(body, name).not.toContain("trySend");
    }
  });

  it.each([
    "orpcClient.x.y()",
    'fetch("/x")',
    "new XMLHttpRequest()",
    "navigator.sendBeacon(u)",
    "new EventSource(u)",
    "new WebSocket(u)",
  ])("o detector de servidor vê %s", (call) => {
    expect(SERVER_CALL.test(codeOnly(`const f = () => ${call};`))).toBe(true);
  });

  describe("âncora do workSource (código em memória)", () => {
    const decoy = "decoy() { return { read: async () => { fetch(u); } }; }\n";
    const real = `${WORK_SOURCE_HEADER} return { read: async () => { await this.refreshCounts(); } }; }\n`;

    it("um read parecido antes do workSource não é o que se confere", () => {
      const body = bodyOf(workSourceBody(decoy + real), "read: async () => {");
      expect(body).toContain("this.refreshCounts()");
      expect(SERVER_CALL.test(body)).toBe(false);
    });

    it("cabeçalho ausente ou duplicado reprova", () => {
      expect(() => workSourceBody(decoy)).toThrow(
        "âncora ausente ou duplicada"
      );
      expect(() => workSourceBody(real + real)).toThrow(
        "âncora ausente ou duplicada"
      );
    });
  });

  describe("controles plantados (arquivos em memória)", () => {
    const planted = "settings/novo-poller.tsx";
    const source = "setInterval(() => orpcClient.x.y(), 1000);\n";
    const files = new Map([[planted, source]]);

    it("um setInterval novo que chama o servidor reprova dizendo o arquivo e a regra", () => {
      const problems = recurringTimerProblems(files, []);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(planted);
      expect(problems[0]).toContain("fora da lista ALLOWED_INTERVALS");
      expect(problems[0]).toContain("gasta cota do Hyperdrive");
    });

    it("o mesmo arquivo na lista passa na regra de registro, mas não se declarado sem servidor", () => {
      const entry: AllowedInterval = {
        callsServer: true,
        file: planted,
        intervalMs: "1000",
        reason: "controle plantado: poller que chama o servidor",
        uses: 1,
      };
      expect(recurringTimerProblems(files, [entry])).toEqual([]);
      const denied = recurringTimerProblems(files, [
        { ...entry, callsServer: false },
      ]);
      expect(denied).toHaveLength(1);
      expect(denied[0]).toContain("chama o servidor: não");
    });

    it("window.setInterval e globalThis.setInterval também contam", () => {
      for (const form of ["window.setInterval", "globalThis.setInterval"]) {
        const problems = recurringTimerProblems(
          new Map([[planted, `${form}(tick, 1000);`]]),
          []
        );
        expect(problems, form).toHaveLength(1);
      }
    });

    it("comentário e texto de string não contam", () => {
      const quiet = [
        "// setInterval(() => orpcClient.x.y(), 1000)",
        "/* setInterval( */",
        'const a = "setInterval(";',
        "const b = `setInterval(`;",
      ].join("\n");
      expect(recurringTimerProblems(new Map([[planted, quiet]]), [])).toEqual(
        []
      );
    });

    it("contagem diferente da lista e entrada que sobrou reprovam", () => {
      const entry: AllowedInterval = {
        callsServer: false,
        file: planted,
        intervalMs: "1000",
        reason: "controle plantado: relógio local de teste",
        uses: 1,
      };
      const two = new Map([
        [planted, "setInterval(a, 1);\nsetInterval(b, 1);"],
      ]);
      expect(recurringTimerProblems(two, [entry])[0]).toContain(
        "contagem exata"
      );
      expect(
        recurringTimerProblems(new Map([[planted, ""]]), [entry])[0]
      ).toContain("tire da lista");
    });

    it("o limite do detector está dito: regex com crase esconde o que vem depois", () => {
      const blind =
        "const odd = /<|`/;\nsetInterval(tick, 1000);\nconst end = `x`;";
      expect(recurringTimerProblems(new Map([[planted, blind]]), [])).toEqual(
        []
      );
    });

    it("o limite do detector está dito: setTimeout encadeado e alias passam", () => {
      const blind = [
        "const again = () => { orpcClient.x.y(); setTimeout(again, 1000); };",
        "const every = setInterval; every(() => orpcClient.x.y(), 1000);",
      ].join("\n");
      expect(recurringTimerProblems(new Map([[planted, blind]]), [])).toEqual(
        []
      );
    });
  });
});
