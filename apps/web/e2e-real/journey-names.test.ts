import { describe, expect, it } from "vitest";
import { journeyName, uuidV5 } from "./journey-names";

describe("journey names", () => {
  it("never coincide between projects, journeys or attempts", () => {
    const projects = ["online", "runtime-ligado", "pilha"];
    const journeys = ["cliente", "venda", "venda-a", "onboarding"];
    const names = projects.flatMap((project) =>
      journeys.flatMap((journey) => [0, 1].map((attempt) => journeyName(project, journey, attempt)))
    );
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names.map((name) => uuidV5(name))).size).toBe(names.length);
    expect(journeyName("online", "venda", 0)).not.toBe(journeyName("runtime-ligado", "venda", 0));
    expect(uuidV5(journeyName("online", "venda", 0))).not.toBe(uuidV5(journeyName("runtime-ligado", "venda", 0)));
  });

  it("keep the qa- prefix and refuse what could escape it", () => {
    expect(journeyName("online", "venda", 1)).toBe("qa-online-venda-t1");
    expect(() => journeyName("online", "venda'; drop", 0)).toThrow();
    expect(() => journeyName("Online", "venda", 0)).toThrow();
    expect(() => journeyName("online", "venda", -1)).toThrow();
  });

  it("makes a stable version 5 UUID", () => {
    // RFC 9562 appendix A.4: the DNS namespace and "www.example.com"
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2"
    );
    expect(uuidV5("qa-online-venda-t0")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
