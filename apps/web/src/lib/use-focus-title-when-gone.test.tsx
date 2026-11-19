// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useFocusTitleWhenGone } from "./use-focus-title-when-gone";

function List({ busy = false, visible }: { busy?: boolean; visible: boolean }) {
  const focus = useFocusTitleWhenGone<HTMLHeadingElement>(visible);
  return (
    <div>
      <h1 ref={focus.title} tabIndex={-1}>
        Lista
      </h1>
      <button type="button">Outro</button>
      {visible ? (
        <button
          disabled={busy}
          onBlur={focus.onBlur}
          onFocus={focus.onFocus}
          type="button"
        >
          Carregar mais
        </button>
      ) : null}
    </div>
  );
}

afterEach(cleanup);

describe("useFocusTitleWhenGone", () => {
  it("leva o foco ao título quando o botão some com o foco nele", () => {
    const { rerender } = render(<List visible />);
    const button = screen.getByRole("button", { name: "Carregar mais" });
    button.focus();
    fireEvent.focus(button);
    rerender(<List visible={false} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Lista" })
    );
  });

  it("não mexe no foco quando o botão some e o foco estava em outro lugar", () => {
    const { rerender } = render(<List visible />);
    const button = screen.getByRole("button", { name: "Carregar mais" });
    const other = screen.getByRole("button", { name: "Outro" });
    button.focus();
    fireEvent.focus(button);
    other.focus();
    fireEvent.blur(button);
    rerender(<List visible={false} />);
    expect(document.activeElement).toBe(other);
  });

  it("o blur de um botão desligado não conta: o foco ainda vai ao título quando ele some", () => {
    const { rerender } = render(<List visible />);
    const button = screen.getByRole("button", { name: "Carregar mais" });
    button.focus();
    fireEvent.focus(button);
    rerender(<List busy visible />);
    fireEvent.blur(screen.getByRole("button", { name: "Carregar mais" }));
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<List visible={false} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Lista" })
    );
  });
});
