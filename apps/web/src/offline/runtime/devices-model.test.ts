import type { DeviceReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  deviceRows,
  devicesLoadError,
  revokedMessage,
  revokeError,
} from "./devices-model";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const device = (
  n: number,
  overrides: Partial<DeviceReadModel> = {}
): DeviceReadModel => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label: null,
  lastSeenAt: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00.000Z`,
  revokedAt: null,
  ...overrides,
});
const rpcError = (code: string) => Object.assign(new Error(code), { code });

describe("the devices screen rows", () => {
  it("puts this device first, then the most recently seen, and hides revoked ones", () => {
    const rows = deviceRows(
      [
        device(1, { label: "Caixa" }),
        device(2),
        device(3, { revokedAt: "2026-10-12T12:00:00.000Z" }),
        device(4, { label: "  Celular da Ana  " }),
      ],
      uuid(1)
    );
    expect(rows.map((row) => row.id)).toEqual([uuid(1), uuid(4), uuid(2)]);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[1]?.isCurrent).toBe(false);
  });

  it("names a device without a label, and trims a label", () => {
    const rows = deviceRows([device(1), device(2, { label: " Loja " })], null);
    expect(rows.find((row) => row.id === uuid(1))?.labelText).toBe(
      "Aparelho sem nome"
    );
    expect(rows.find((row) => row.id === uuid(2))?.labelText).toBe("Loja");
    expect(rows.every((row) => !row.isCurrent)).toBe(true);
  });
});

describe("the messages", () => {
  it("counts the cancelled authorizations", () => {
    expect(revokedMessage(0)).toBe("Aparelho revogado.");
    expect(revokedMessage(1)).toContain("1 autorização offline cancelada");
    expect(revokedMessage(2)).toContain("2 autorizações offline canceladas");
  });

  it("says what happened for each failure and never claims the revocation happened on an unknown one", () => {
    expect(devicesLoadError(rpcError("UNAUTHORIZED"))).toContain("sessão");
    expect(devicesLoadError(new TypeError("Failed to fetch"))).toContain(
      "conexão"
    );
    expect(revokeError(rpcError("NOT_FOUND"))).toContain("já foi revogado");
    expect(revokeError(new TypeError("Failed to fetch"))).toContain(
      "revogar um aparelho já revogado é seguro"
    );
  });
});
