// @vitest-environment happy-dom
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./empty-state";

describe("the squares of the icons of an empty state", () => {
  it("draw two of the same icon without a repeated-key warning", () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => {
      root.render(
        <EmptyState icon={[UsersIcon, UsersIcon]} title="A frase." />
      );
    });
    const squares = host.querySelectorAll('[data-slot="empty-icon"]').length;
    const warnings = error.mock.calls.map((call) => call.join(" "));
    error.mockRestore();
    act(() => root.unmount());
    expect(squares).toBe(2);
    expect(warnings.filter((line) => line.includes("same key"))).toEqual([]);
  });
});
