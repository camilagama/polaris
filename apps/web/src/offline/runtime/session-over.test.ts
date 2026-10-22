import { beforeEach, describe, expect, it, vi } from "vitest";

const leaveTo = vi.fn();
vi.mock("./leave-browser", () => ({ leaveTo }));

const marker = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../../lib/session-marker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/session-marker")>()),
  clearSessionMarker: () => {
    marker.value = null;
  },
  readSessionMarker: () => marker.value,
}));

const { leaveSessionOver } = await import("./session-over");

async function leave(
  returnTo: string | undefined,
  options?: { atOpen?: boolean }
): Promise<string> {
  leaveSessionOver(null, returnTo, options);
  await vi.waitFor(() => expect(leaveTo).toHaveBeenCalled());
  return leaveTo.mock.calls[0]?.[0] as string;
}

describe("leaveSessionOver (U-01)", () => {
  beforeEach(() => {
    leaveTo.mockReset();
    marker.value = null;
  });

  it("does not say the session ended on a first visit", async () => {
    expect(await leave("/sales", { atOpen: true })).toBe(
      "/entrar?voltar=/sales"
    );
  });

  it("says the session ended when the browser had one", async () => {
    marker.value = "ativa";
    expect(await leave("/sales", { atOpen: true })).toBe(
      "/entrar?motivo=sessao&voltar=/sales"
    );
    expect(marker.value).toBeNull();
  });

  it("says the person left after 'Sair'", async () => {
    marker.value = "saiu";
    expect(await leave("/sales", { atOpen: true })).toBe(
      "/entrar?motivo=saiu&voltar=/sales"
    );
  });

  it("always says the session ended when it was refused while a screen was in use", async () => {
    expect(await leave("/sales")).toBe("/entrar?motivo=sessao&voltar=/sales");
  });
});
