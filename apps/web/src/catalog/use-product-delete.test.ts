import { readFileSync } from "node:fs";
import type { ProductReadModel } from "@polaris/contracts";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

import { keepLocalRow } from "./product-commands";

const HOOK = new URL("./use-product-delete.ts", import.meta.url);

const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;
const IMPORT = /^import\s+([^;]*?)\s+from\s+"([^"]+)";/gm;
const OFFLINE_WORDS = /outbox|enqueue|createOffline|stores\b/gi;
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const TYPE_KEYWORD = /\btype\s+/g;
const BRACES = /[{}]/g;

function code(source: string): string {
  return source.replace(COMMENTS, "");
}

/** Each name the file imports, as `source: name` (a default or namespace import counts by its local name). */
function importedNames(source: string): string[] {
  return [...code(source).matchAll(IMPORT)].flatMap((match) =>
    (match[1] ?? "")
      .replace(TYPE_KEYWORD, "")
      .replace(BRACES, "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => `${match[2]}: ${name}`)
  );
}

/** Textual limit: a queue reached through a name outside these words and outside the static imports is not seen. */
function dynamicImports(source: string): string[] {
  return code(source).match(DYNAMIC_IMPORT) ?? [];
}

function offlineWords(source: string): string[] {
  return code(source).match(OFFLINE_WORDS) ?? [];
}

/** Everything the delete hook may import: the server's client, the one local write after the server answered, and the refusal texts. */
const ALLOWED_IMPORTS = [
  "../lib/orpc: orpcClient",
  "./product-commands: Workspace",
  "./product-commands: keepLocalRow",
  "./product-errors: ProductDeleteRefusal",
  "./product-errors: productDeleteRefusal",
  "@polaris/contracts: ProductReadModel",
  "react: useCallback",
  "react: useEffect",
  "react: useRef",
  "react: useState",
].sort();

describe("o detector de fila do hook de Excluir", () => {
  it("vê import e uso da fila, e não se engana com comentário", () => {
    const planted = `import { createOfflineProduct } from "../offline/product-create";
workspace.stores.outbox.enqueue(command);`;
    expect(importedNames(planted)).toEqual([
      "../offline/product-create: createOfflineProduct",
    ]);
    expect(offlineWords(planted).length).toBeGreaterThan(0);
    expect(offlineWords("workspace.runtime.syncNow()")).toEqual([]);
    expect(offlineWords("// the outbox never gets one\nconst a = 1;")).toEqual(
      []
    );
    expect(
      dynamicImports('const m = await import("../offline/outbox");').length
    ).toBe(1);
    expect(
      dynamicImports('const m = await import ( "../offline/outbox" );').length
    ).toBe(1);
    expect(dynamicImports('// import("x")\nconst a = 1;')).toEqual([]);
    expect(
      importedNames(
        'import type { A } from "x";\nimport { b, type c } from "y";'
      )
    ).toEqual(["x: A", "y: b", "y: c"]);
  });

  it("um nome novo de um módulo já permitido muda a lista", () => {
    const widened =
      'import { keepLocalRow, deleteProductOffline, type Workspace } from "./product-commands";';
    expect(importedNames(widened).sort()).not.toEqual(
      ALLOWED_IMPORTS.filter((name) => name.startsWith("./product-commands"))
    );
  });
});

describe("Excluir produto nunca vira comando guardado no aparelho (AC-2.7)", () => {
  const source = readFileSync(HOOK, "utf8");

  it("o hook importa só os nomes do cliente do servidor, da linha local e dos textos de recusa", () => {
    expect(importedNames(source).sort()).toEqual(ALLOWED_IMPORTS);
  });

  it("o hook não toca a fila nem a loja local", () => {
    expect(offlineWords(source)).toEqual([]);
  });

  it("o hook não carrega módulo nenhum com import() dinâmico", () => {
    expect(dynamicImports(source)).toEqual([]);
  });

  it("a linha local que o hook grava depois da resposta do servidor não passa pela fila", async () => {
    const queueCalls = vi.fn();
    const queue = new Proxy(
      {},
      {
        get: (_target, name) => {
          queueCalls(String(name));
          return () => Promise.resolve();
        },
      }
    );
    const upsert = vi.fn(() => Promise.resolve());
    const workspace = {
      stores: { outbox: queue, writer: { upsert } },
    } as unknown as Parameters<typeof keepLocalRow>[0];
    await keepLocalRow(workspace, {
      id: "p1",
      name: "Jaqueta",
      organizationId: "org",
      status: "deleted",
      version: 3,
    } as unknown as ProductReadModel);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(queueCalls).not.toHaveBeenCalled();
  });
});
