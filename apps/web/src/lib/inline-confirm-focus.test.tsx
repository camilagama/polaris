// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineConfirm } from "@/ui/inline-confirm";

afterEach(cleanup);

const noop = () => undefined;
const findOpener = () => document.getElementById("opener");

interface HarnessProps {
  busy?: boolean;
  onConfirm?: () => void;
}

function Harness({ busy = false, onConfirm = noop }: HarnessProps) {
  const [asking, setAsking] = useState(false);
  const show = useCallback(() => setAsking(true), []);
  const hide = useCallback(() => setAsking(false), []);
  return (
    <div>
      {asking ? (
        <InlineConfirm
          action="remoção"
          busy={busy}
          confirmLabel="Remover cliente"
          keepLabel="Manter cliente"
          object="Ana Lima"
          onConfirm={onConfirm}
          onKeep={hide}
          opener={findOpener}
        >
          Remover tira a ficha da lista. Não dá para desfazer.
        </InlineConfirm>
      ) : (
        <button id="opener" onClick={show} type="button">
          Remover…
        </button>
      )}
    </div>
  );
}

async function openBox() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Remover…" }));
  const box = await screen.findByRole("group", {
    name: "Confirmar remoção de Ana Lima",
  });
  return { box, user };
}

describe("InlineConfirm", () => {
  it("is a group named by the action and the object, described by the sentence, never an alertdialog", async () => {
    render(<Harness />);
    const { box } = await openBox();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const sentence = document.getElementById(
      box.getAttribute("aria-describedby") ?? ""
    );
    expect(sentence?.textContent).toBe(
      "Remover tira a ficha da lista. Não dá para desfazer."
    );
    expect(sentence?.querySelector("strong")).toBeNull();
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(box.className).toContain("focus-ring");
    expect(box.className).toContain("ring-destructive/60");
  });

  it("puts keeping first (outline) and the destructive answer after it, in a wrapping row", async () => {
    render(<Harness />);
    const { box } = await openBox();
    const buttons = Array.from(box.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Manter cliente",
      "Remover cliente",
    ]);
    expect(buttons[0]?.className).toContain("border-border");
    expect(buttons[1]?.className).toContain("bg-destructive");
    expect(buttons[0]?.parentElement?.className).toContain("flex-wrap");
    expect(buttons[0]?.parentElement?.className).toContain("gap-3");
  });

  it("takes the focus when it opens, and the first Tab lands on keeping", async () => {
    render(<Harness />);
    const { box, user } = await openBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Manter cliente" })
    );
  });

  it("gives the focus back to the button that opened it when it is kept", async () => {
    render(<Harness />);
    const { user } = await openBox();
    await user.click(screen.getByRole("button", { name: "Manter cliente" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById("opener"))
    );
  });

  it("keeps on Esc, gives the focus back and does not let Esc reach what is around it", async () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    render(<Harness />);
    const { box, user } = await openBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById("opener"))
    );
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });

  it("confirms with the destructive button only", async () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const { box, user } = await openBox();
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      document.activeElement === box || box.contains(document.activeElement)
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Remover cliente" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("turns both buttons off while it runs, and Esc waits too", async () => {
    const { rerender } = render(<Harness />);
    const { user } = await openBox();
    await user.click(screen.getByRole("button", { name: "Remover cliente" }));
    rerender(<Harness busy />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("group"))
    );
    for (const name of ["Manter cliente", "Remover cliente"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled
      ).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.getByRole("group")).toBeTruthy();
  });
});
