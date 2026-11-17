import { describe, expect, it } from "vitest";
import { appCommit, type GitRunner } from "./app-commit";
import { UNKNOWN_SHA } from "./report";

const SHA = "9b3d37ed5c223fba78109e32e9196bb294b35358";

function runner(outputs: { head: string; status: string }): GitRunner {
  return (args) => (args[0] === "status" ? outputs.status : outputs.head);
}

describe("appCommit", () => {
  it("devolve o SHA de 40 hex do HEAD", () => {
    expect(appCommit(runner({ head: `${SHA}\n`, status: "" }))).toEqual({
      dirty: false,
      sha: SHA,
    });
  });

  it("trata saída que não é um SHA completo como desconhecido", () => {
    for (const head of [
      "",
      "9b3d37e\n",
      "fatal: not a git repository",
      `${SHA}\n${SHA}`,
    ]) {
      expect(appCommit(runner({ head, status: "" })).sha).toBe(UNKNOWN_SHA);
    }
  });

  it("não derruba o gate quando o git lança", () => {
    const failing: GitRunner = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(appCommit(failing)).toEqual({ dirty: false, sha: UNKNOWN_SHA });
  });

  it("cai em desconhecido quando só o rev-parse lança", () => {
    const failing: GitRunner = (args) => {
      if (args[0] === "rev-parse") {
        throw new Error("fatal");
      }
      return " M a.ts\n";
    };
    expect(appCommit(failing)).toEqual({ dirty: false, sha: UNKNOWN_SHA });
  });

  it("marca limpo quando status --porcelain vem vazio", () => {
    expect(appCommit(runner({ head: SHA, status: "\n" })).dirty).toBe(false);
  });

  it("marca sujo quando status --porcelain tem alterações", () => {
    expect(
      appCommit(runner({ head: SHA, status: " M apps/web/src/main.tsx\n" }))
    ).toEqual({ dirty: true, sha: SHA });
  });

  it("consulta o git com os comandos esperados", () => {
    const calls: string[][] = [];
    appCommit((args) => {
      calls.push(args);
      return args[0] === "status" ? "" : SHA;
    });
    expect(calls).toEqual([
      ["status", "--porcelain"],
      ["rev-parse", "HEAD"],
    ]);
  });
});
