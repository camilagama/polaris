import { describe, expect, it } from "vitest";
import { parseArgs, selectRuns } from "./test-datas.mjs";

describe("test:datas", () => {
  it("sem opção, roda os cinco instantes nos dois fusos", () => {
    expect(selectRuns(parseArgs([]))).toHaveLength(10);
  });

  it("--instante e --tz recortam, e o que vem depois de -- é filtro do Vitest", () => {
    const options = parseArgs([
      "--instante",
      "virada-do-ano",
      "--tz",
      "UTC",
      "--",
      "apps/web",
    ]);
    expect(options.filters).toEqual(["apps/web"]);
    expect(selectRuns(options)).toEqual([
      expect.objectContaining({
        instante: expect.objectContaining({ chave: "virada-do-ano" }),
        tz: "UTC",
      }),
    ]);
  });

  it("filtro sem -- na frente (o bun come o -- inicial) também vale", () => {
    expect(parseArgs(["apps/web", "packages/billing"]).filters).toEqual([
      "apps/web",
      "packages/billing",
    ]);
    expect(parseArgs(["--tz", "UTC", "apps/web"])).toEqual({
      filters: ["apps/web"],
      instante: null,
      tz: "UTC",
    });
    expect(parseArgs(["--", "apps/web"]).filters).toEqual(["apps/web"]);
  });

  it.each([
    [["--instant", "virada-do-ano"], "argumento desconhecido: --instant"],
    [["--tz", "UTC", "--instant", "x"], "argumento desconhecido: --instant"],
    [["--tz"], "--tz pede um valor"],
    [["--tz", "--instante"], "--tz pede um valor"],
  ])("%j dá erro", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it.each([
    [{ filters: [], instante: "nunca", tz: null }, "instante desconhecido"],
    [{ filters: [], instante: null, tz: "Mars/Base" }, "fuso desconhecido"],
  ])("%j dá erro", (options, message) => {
    expect(() => selectRuns(options)).toThrow(message);
  });
});
