// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type EmailPreference,
  type EmailPreferenceCalls,
  EmailPreferenceCard,
} from "./email-preference-card";

const user = userEvent.setup();

afterEach(() => {
  cleanup();
});

const SENT_LINE = /Enviados até agora/;
const SAVE_FAILED = /Não deu para salvar/;
const FORBIDDEN_WORDS =
  /descadastr|cancelar inscri|opt-out|série|ativação|trial/i;

function callsOf(
  state: EmailPreference,
  overrides: Partial<EmailPreferenceCalls> = {}
): EmailPreferenceCalls {
  return {
    read: () => Promise.resolve(state),
    readRefusal: () => "Não foi possível carregar as preferências de e-mail.",
    setTips: (on) => Promise.resolve({ ...state, tips: on }),
    ...overrides,
  };
}

async function opened(
  state: EmailPreference,
  overrides: Partial<EmailPreferenceCalls> = {},
  online = true
) {
  const calls = callsOf(state, overrides);
  render(<EmailPreferenceCard calls={calls} online={online} />);
  const toggle = await screen.findByRole("switch", {
    name: "Dicas para começar",
  });
  return { calls, toggle };
}

describe("the card of the e-mails the person receives", () => {
  it("lists the account and billing notices with no control, and says why (AC-8b.2)", async () => {
    await opened({ sent: 0, tips: true });
    const region = screen.getByRole("region", {
      name: "E-mails que você recebe",
    });
    expect(region.textContent).toContain("Avisos da conta e da cobrança");
    expect(region.textContent).toContain(
      "Sempre enviados: fazem parte do serviço."
    );
    const notices = screen
      .getByText("Avisos da conta e da cobrança")
      .closest("div");
    expect(notices?.querySelector("button, input, [role=switch]")).toBeNull();
    expect(screen.getAllByRole("switch")).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows the tips switch with its help, reflecting the saved state", async () => {
    const off = await opened({ sent: 0, tips: false });
    expect(off.toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getByText(
        "Até 3 e-mails nos primeiros 14 dias de uma loja nova, para ajudar a fazer a primeira venda. Vale para todas as suas lojas."
      )
    ).toBeTruthy();
    expect(off.toggle.getAttribute("aria-describedby")).toContain(
      "email-preference-tips-help"
    );
    cleanup();
    const on = await opened({ sent: 0, tips: true });
    expect(on.toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("draws the line of what was sent only when something was, from the count alone (AC-8b.3)", async () => {
    await opened({ sent: 0, tips: true });
    expect(screen.queryByText(SENT_LINE)).toBeNull();
    cleanup();
    await opened({ sent: 2, tips: true });
    expect(screen.getByText("Enviados até agora: 2 de 3.")).toBeTruthy();
    cleanup();
    await opened({ sent: 2, tips: false });
    expect(screen.getByText("Enviados até agora: 2 de 3.")).toBeTruthy();
  });

  it("uses no word of the jargon, with and without a sent tip (AC-8b.5)", async () => {
    await opened({ sent: 2, tips: true });
    expect(
      screen.getByRole("region", { name: "E-mails que você recebe" })
        .textContent
    ).not.toMatch(FORBIDDEN_WORDS);
  });

  it("saves at once on a touch, says Salvo. in a status and keeps the new state", async () => {
    const setTips = vi.fn((on: boolean) =>
      Promise.resolve({ sent: 1, tips: on })
    );
    const { toggle } = await opened({ sent: 1, tips: true }, { setTips });
    await user.click(toggle);
    expect(setTips).toHaveBeenCalledExactlyOnceWith(false);
    await screen.findByText("Salvo.");
    expect(screen.getByText("Salvo.").closest("[role=status]")).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(SAVE_FAILED)).toBeNull();
    await user.click(toggle);
    expect(setTips).toHaveBeenLastCalledWith(true);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    );
  });

  it("keeps the state and says it inline when saving fails, never a toast", async () => {
    const setTips = vi.fn(() => Promise.reject(new Error("falhou")));
    const { toggle } = await opened({ sent: 0, tips: true }, { setTips });
    await user.click(toggle);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Não deu para salvar. Tente de novo.");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Salvo.")).toBeNull();
  });

  it("sends one request for two touches in a row", async () => {
    let finish: (value: EmailPreference) => void = () => undefined;
    const setTips = vi.fn(
      () =>
        new Promise<EmailPreference>((resolve) => {
          finish = resolve;
        })
    );
    const { toggle } = await opened({ sent: 0, tips: true }, { setTips });
    await user.click(toggle);
    await user.click(toggle);
    expect(setTips).toHaveBeenCalledTimes(1);
    finish({ sent: 0, tips: false });
    await screen.findByText("Salvo.");
  });

  it("offline the switch is aria-disabled, described by the strip, and a touch sends nothing", async () => {
    const setTips = vi.fn();
    const { toggle } = await opened(
      { sent: 0, tips: true },
      { setTips },
      false
    );
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.getAttribute("aria-describedby")).toContain(
      "connection-required-text"
    );
    await user.click(toggle);
    expect(setTips).not.toHaveBeenCalled();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("says a failed read in the card and draws no switch", async () => {
    render(
      <EmailPreferenceCard
        calls={callsOf(
          { sent: 0, tips: true },
          { read: () => Promise.reject(new Error("falhou")) }
        )}
        online
      />
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Não foi possível carregar as preferências de e-mail."
    );
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Avisos da conta e da cobrança")).toBeTruthy();
  });
});

function deferredRead() {
  let resolve: (value: EmailPreference) => void = () => undefined;
  const read = vi.fn(
    () =>
      new Promise<EmailPreference>((done) => {
        resolve = done;
      })
  );
  return { read, resolve: (value: EmailPreference) => resolve(value) };
}

function answer(settle: () => void) {
  return act(() => {
    settle();
    return Promise.resolve();
  });
}

describe("the read of the card", () => {
  it("draws the skeleton in the place of the switch while the read is pending, then the read state (AC-1.1)", async () => {
    const pending = deferredRead();
    const { container } = render(
      <EmailPreferenceCard
        calls={callsOf({ sent: 0, tips: true }, { read: pending.read })}
        online
      />
    );
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByText("Salvo.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.getByRole("heading", { name: "E-mails que você recebe" })
    ).toBeTruthy();
    expect(screen.getByText("Avisos da conta e da cobrança")).toBeTruthy();

    await answer(() => pending.resolve({ sent: 0, tips: false }));
    const toggle = await screen.findByRole("switch", {
      name: "Dicas para começar",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("reads once with the same calls, however many times online changes and the parent draws again (AC-1.2)", async () => {
    const read = vi.fn(() => Promise.resolve({ sent: 0, tips: true }));
    const calls = callsOf({ sent: 0, tips: true }, { read });
    const { rerender } = render(<EmailPreferenceCard calls={calls} online />);
    await screen.findByRole("switch", { name: "Dicas para começar" });

    rerender(<EmailPreferenceCard calls={calls} online={false} />);
    rerender(<EmailPreferenceCard calls={calls} online />);
    rerender(<EmailPreferenceCard calls={calls} online={false} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("switch", { name: "Dicas para começar" })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("drops a late read that was sent before a save, keeping the saved state (AC-1.3)", async () => {
    const first = callsOf({ sent: 0, tips: true });
    const late = deferredRead();
    const second = callsOf(
      { sent: 0, tips: true },
      {
        read: late.read,
        setTips: (on) => Promise.resolve({ sent: 0, tips: on }),
      }
    );
    const { rerender } = render(<EmailPreferenceCard calls={first} online />);
    const toggle = await screen.findByRole("switch", {
      name: "Dicas para começar",
    });

    rerender(<EmailPreferenceCard calls={second} online />);
    expect(late.read).toHaveBeenCalledTimes(1);
    await user.click(toggle);
    await screen.findByText("Salvo.");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await answer(() => late.resolve({ sent: 0, tips: true }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("the retry of a failed read", () => {
  function failingThenReading() {
    const read = vi
      .fn<() => Promise<EmailPreference>>()
      .mockRejectedValueOnce(new Error("falhou"))
      .mockResolvedValue({ sent: 1, tips: true });
    const calls = callsOf({ sent: 1, tips: true }, { read });
    return { calls, read };
  }

  it("draws Tentar novamente under the error, and a touch reads again and draws the switch", async () => {
    const { calls, read } = failingThenReading();
    render(<EmailPreferenceCard calls={calls} online />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("switch")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    const toggle = await screen.findByRole("switch", {
      name: "Dicas para começar",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Tentar novamente" })
    ).toBeNull();
  });

  it("sends one read for two touches, and says it is busy while it waits", async () => {
    const pending = deferredRead();
    const read = vi
      .fn<() => Promise<EmailPreference>>()
      .mockRejectedValueOnce(new Error("falhou"))
      .mockImplementation(pending.read);
    render(
      <EmailPreferenceCard
        calls={callsOf({ sent: 0, tips: true }, { read })}
        online
      />
    );
    await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Tentar novamente" });
    await user.click(retry);
    await user.click(retry);
    expect(read).toHaveBeenCalledTimes(2);
    expect(retry.getAttribute("aria-busy")).toBe("true");
    await answer(() => pending.resolve({ sent: 0, tips: true }));
    await screen.findByRole("switch", { name: "Dicas para começar" });
  });

  it("keeps the error and the button when the new read fails too", async () => {
    const read = vi.fn(() => Promise.reject(new Error("falhou")));
    render(
      <EmailPreferenceCard
        calls={callsOf({ sent: 0, tips: true }, { read })}
        online
      />
    );
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Tentar novamente" })
          .getAttribute("aria-busy")
      ).toBe("false")
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("offline the button is aria-disabled, described by the strip, and a touch reads nothing", async () => {
    const { calls, read } = failingThenReading();
    render(<EmailPreferenceCard calls={calls} online={false} />);
    await screen.findByRole("alert");
    const retry = screen.getByRole("button", { name: "Tentar novamente" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(retry.getAttribute("aria-describedby")).toContain(
      "connection-required-text"
    );
    await user.click(retry);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("does not read again by itself when the connection comes back", async () => {
    const { calls, read } = failingThenReading();
    const { rerender } = render(
      <EmailPreferenceCard calls={calls} online={false} />
    );
    await screen.findByRole("alert");
    rerender(<EmailPreferenceCard calls={calls} online />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("drops an answer of the retry that a newer read of other calls has replaced", async () => {
    const late = deferredRead();
    const first = callsOf(
      { sent: 0, tips: true },
      {
        read: vi
          .fn<() => Promise<EmailPreference>>()
          .mockRejectedValueOnce(new Error("falhou"))
          .mockImplementation(late.read),
      }
    );
    const second = callsOf({ sent: 0, tips: false });
    const { rerender } = render(<EmailPreferenceCard calls={first} online />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Tentar novamente" }));
    rerender(<EmailPreferenceCard calls={second} online />);
    const toggle = await screen.findByRole("switch", {
      name: "Dicas para começar",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await answer(() => late.resolve({ sent: 0, tips: true }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
