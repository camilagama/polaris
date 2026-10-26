import { describe, expect, it } from "vitest";
import { storeInitials } from "./store-initials";

describe("storeInitials (the tile of the store card, v7 § 3 item 12)", () => {
  it("takes the first letter of the first and of the last word of the store", () => {
    expect(storeInitials("Loja da Clara")).toBe("LC");
    expect(storeInitials("ateliê")).toBe("A");
    expect(storeInitials("  Bazar   Central  Sul ")).toBe("BS");
  });

  it("with the e-mail alone, takes the part before the @", () => {
    expect(storeInitials("clara.souza@exemplo.com.br")).toBe("CS");
    expect(storeInitials("contato@exemplo.com.br")).toBe("C");
  });
});
