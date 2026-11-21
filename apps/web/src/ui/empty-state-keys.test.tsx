// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

describe("the squares of the icons of an empty state", () => {
  it("draw two of the same icon without a repeated-key warning", () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { container } = render(
      <EmptyState icon={[UsersIcon, UsersIcon]} title="A frase." />
    );
    const warnings = error.mock.calls.map((call) => String(call.join(" ")));
    error.mockRestore();
    expect(container.querySelectorAll('[data-slot="empty-icon"]')).toHaveLength(
      2
    );
    expect(warnings.filter((line) => line.includes("same key"))).toEqual([]);
  });
});
