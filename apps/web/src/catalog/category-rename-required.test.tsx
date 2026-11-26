// @vitest-environment happy-dom
import type { CategoryReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryList } from "./category-list";

const REQUIRED = "Informe o nome da categoria.";
const LIMIT = /Limite de 100 caracteres/;
const FIELD = "Novo nome para Camisetas";

const camisetas: CategoryReadModel = {
  archivedAt: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  id: "0199c2d0-0000-7000-8000-000000000041",
  name: "Camisetas",
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-14T12:00:00.000Z",
};

const noop = () => undefined;

function Renaming({
  onSubmit,
  online = true,
}: {
  onSubmit: () => void;
  online?: boolean;
}) {
  const [value, setValue] = useState(camisetas.name);
  return (
    <CategoryList
      categories={[camisetas]}
      isLoading={false}
      onArchive={noop}
      onDelete={noop}
      onDeleteCancel={noop}
      onDeleteStart={noop}
      online={online}
      onRenameCancel={noop}
      onRenameChange={setValue}
      onRenameStart={noop}
      onRenameSubmit={onSubmit}
      onRestore={noop}
      pendingAction={null}
      pendingDeleteId={null}
      renameValue={value}
      renamingCategoryId={camisetas.id}
      status="active"
    />
  );
}

afterEach(cleanup);

describe("renaming a category with an empty name", () => {
  it.each([
    ["empty", ""],
    ["only spaces", "   "],
  ])(
    "says the name is required and sends nothing when it is %s",
    async (_label, typed) => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<Renaming onSubmit={onSubmit} />);
      const field = screen.getByRole("textbox", { name: FIELD });

      await user.clear(field);
      if (typed !== "") {
        await user.type(field, typed);
      }
      await user.click(screen.getByRole("button", { name: "Salvar" }));

      const message = screen.getByText(REQUIRED).closest("[data-slot]");
      expect(message?.getAttribute("data-slot")).toBe("field-error");
      expect(message?.getAttribute("role")).toBe("alert");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(field.getAttribute("aria-describedby")).toBe(message?.id);
      expect(document.activeElement).toBe(field);
      expect(onSubmit).not.toHaveBeenCalled();
    }
  );

  it("says it also without a connection, since nothing was typed to keep", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Renaming online={false} onSubmit={onSubmit} />);
    await user.clear(screen.getByRole("textbox", { name: FIELD }));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(screen.getByText(REQUIRED)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("takes the message away when the person types again", async () => {
    const user = userEvent.setup();
    render(<Renaming onSubmit={noop} />);
    const field = screen.getByRole("textbox", { name: FIELD });
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await user.type(field, "Blusas");

    expect(screen.queryByText(REQUIRED)).toBeNull();
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("keeps the limit message, not the required one, for a name over 100 characters", async () => {
    const user = userEvent.setup();
    render(<Renaming onSubmit={noop} />);
    const field = screen.getByRole("textbox", { name: FIELD });
    await user.clear(field);
    await user.click(field);
    await user.paste("a".repeat(101));
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(screen.queryByText(REQUIRED)).toBeNull();
    expect(screen.getByText(LIMIT)).toBeTruthy();
  });

  it("still sends a valid name", async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<Renaming onSubmit={onSubmit} />);
    const field = screen.getByRole("textbox", { name: FIELD });
    await user.clear(field);
    await user.type(field, "Blusas");
    await user.click(screen.getByRole("button", { name: "Salvar" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(REQUIRED)).toBeNull();
  });
});
