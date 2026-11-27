import { describe, expect, it } from "vitest";
import { selectedPreviews } from "./previews";

describe("the previews of a run", () => {
  it("brings up both when the variable is unset, empty or blank", () => {
    expect(selectedPreviews(undefined)).toEqual(["online", "runtime-ligado"]);
    expect(selectedPreviews("")).toEqual(["online", "runtime-ligado"]);
    expect(selectedPreviews("  ")).toEqual(["online", "runtime-ligado"]);
  });

  it("brings up only the ones named, in the order of the stack, and each once", () => {
    expect(selectedPreviews("online")).toEqual(["online"]);
    expect(selectedPreviews("runtime-ligado")).toEqual(["runtime-ligado"]);
    expect(selectedPreviews(" runtime-ligado , online ,online")).toEqual([
      "online",
      "runtime-ligado",
    ]);
  });

  it("stops on a name that is not a preview, and says which names exist", () => {
    expect(() => selectedPreviews("onlin")).toThrow(
      'E2E_REAL_PREVIEWS names "onlin"; use online and/or runtime-ligado'
    );
    expect(() => selectedPreviews("online,")).toThrow('names ""');
  });
});
