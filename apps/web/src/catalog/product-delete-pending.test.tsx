// @vitest-environment happy-dom
import type { ProductReadModel } from "@polaris/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const deleteCall = vi.fn();
const keepLocalRow = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    product: {
      delete: (input: unknown) => deleteCall(input),
      getVariants: () => Promise.resolve({ variants: [] }),
    },
  },
}));
vi.mock("./product-commands", () => ({
  keepLocalRow: (...args: unknown[]) => keepLocalRow(...args),
}));

import { ProductDeleteDialog } from "./product-delete-dialog";
import { useProductDelete } from "./use-product-delete";

const product = (n: number): ProductReadModel => ({
  archivedAt: "2026-10-14T12:00:00.000Z",
  categoryId: null,
  createdAt: "2026-10-14T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id: `0199c2d0-0000-7000-8000-0000000000${20 + n}`,
  name: `Produto ${n}`,
  organizationId: "org",
  status: "archived",
  updatedAt: "2026-10-14T12:00:00.000Z",
  version: 3,
});

type Hook = ReturnType<typeof useProductDelete>;

interface HarnessProps {
  hookRef: { current: Hook | null };
  products: ProductReadModel[];
}

function Harness({ hookRef, products }: HarnessProps) {
  const hook = useProductDelete({
    isLoading: false,
    onDeleted: () => undefined,
    onStart: () => undefined,
    organizationId: "org",
    products,
    refresh: () => undefined,
    workspace: null,
  });
  hookRef.current = hook;
  return (
    <div>
      <div aria-label="Estado dos produtos" role="tablist">
        <button aria-selected="false" role="tab" type="button">
          Ativos
        </button>
        <button aria-selected="true" role="tab" type="button">
          Arquivados
        </button>
      </div>
      <ul>
        {products.map((item) => (
          <li data-product-id={item.id} key={item.id}>
            <button aria-label={`Mais ações para ${item.name}`} type="button">
              Mais
            </button>
          </li>
        ))}
      </ul>
      <ProductDeleteDialog
        finalFocus={hook.finalFocus}
        isOffline={false}
        onCancel={hook.cancel}
        onConfirm={hook.confirm}
        organizationId="org"
        pending={hook.pending}
        product={hook.target}
        refusal={hook.refusal}
        stockHref={null}
      />
    </div>
  );
}

interface Deferred {
  resolve: (value: unknown) => void;
}

function holdTheServer(): Deferred {
  const held: Deferred = { resolve: () => undefined };
  deleteCall.mockImplementation(
    () =>
      new Promise((resolve) => {
        held.resolve = resolve;
      })
  );
  return held;
}

const keepFocusDefault = () => true;
const CLOSE_BUTTON_SELECTOR = '[data-slot="dialog-close"]';
const NAME_FIELD = /Digite o nome do produto/;
const DELETE_BUTTON = { name: /Excluir produto|Excluindo/ };

async function openFor(products: ProductReadModel[], index: number) {
  const hookRef: HarnessProps["hookRef"] = { current: null };
  render(<Harness hookRef={hookRef} products={products} />);
  const asked = products[index] as ProductReadModel;
  act(() => {
    hookRef.current?.ask(asked, products);
  });
  const field = await screen.findByLabelText(NAME_FIELD);
  return { asked, field, hookRef };
}

async function typeNameAndSubmit(field: HTMLElement, name: string) {
  const user = userEvent.setup();
  await user.type(field, name);
  await user.click(screen.getByRole("button", DELETE_BUTTON));
  return user;
}

beforeEach(() => {
  deleteCall.mockReset();
  keepLocalRow.mockReset();
  keepLocalRow.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("Excluir produto: a chamada em andamento", () => {
  it("trava o campo e põe aria-busy no botão que diz Excluindo…", async () => {
    const held = holdTheServer();
    const { asked, field } = await openFor([product(1), product(2)], 0);
    await typeNameAndSubmit(field, asked.name);

    await waitFor(() =>
      expect(screen.getByRole("button", DELETE_BUTTON).textContent).toBe(
        "Excluindo…"
      )
    );
    const button = screen.getByRole("button", DELETE_BUTTON);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(
      (screen.getByLabelText(NAME_FIELD) as HTMLInputElement).disabled
    ).toBe(true);
    held.resolve({ product: asked });
  });

  it("Esc, o × e Manter arquivado não fecham enquanto a chamada roda", async () => {
    const held = holdTheServer();
    const { asked, field, hookRef } = await openFor(
      [product(1), product(2)],
      0
    );
    expect(document.querySelector(CLOSE_BUTTON_SELECTOR)).not.toBeNull();
    const user = await typeNameAndSubmit(field, asked.name);
    await waitFor(() =>
      expect(screen.getByRole("button", DELETE_BUTTON).textContent).toBe(
        "Excluindo…"
      )
    );

    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Manter arquivado" }));

    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(document.querySelector(CLOSE_BUTTON_SELECTOR)).toBeNull();
    expect(hookRef.current?.target?.id).toBe(asked.id);
    expect(hookRef.current?.pending).toBe(true);
    held.resolve({ product: asked });
  });

  it("o segundo toque, mesmo antes do React desenhar o botão travado, não envia outra chamada", async () => {
    const held = holdTheServer();
    const { asked, hookRef } = await openFor([product(1), product(2)], 0);

    const confirm = hookRef.current?.confirm as Hook["confirm"];
    let calls: Promise<void>[] = [];
    act(() => {
      calls = [confirm(), confirm()];
    });
    await act(async () => {
      held.resolve({ product: asked });
      await Promise.all(calls);
    });

    expect(deleteCall).toHaveBeenCalledTimes(1);
  });

  it("enviar o formulário de novo com a chamada em curso não envia outra", async () => {
    const held = holdTheServer();
    const { asked, field } = await openFor([product(1), product(2)], 0);
    await typeNameAndSubmit(field, asked.name);
    await waitFor(() => expect(deleteCall).toHaveBeenCalledTimes(1));

    const form = screen.getByRole("button", DELETE_BUTTON).closest("form");
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.submit(form as HTMLFormElement);

    expect(deleteCall).toHaveBeenCalledTimes(1);
    held.resolve({ product: asked });
  });

  it("cancelar pelo hook com a chamada em curso não solta o produto pedido", async () => {
    const held = holdTheServer();
    const { asked, field, hookRef } = await openFor(
      [product(1), product(2)],
      0
    );
    await typeNameAndSubmit(field, asked.name);
    await waitFor(() => expect(deleteCall).toHaveBeenCalledTimes(1));

    act(() => {
      hookRef.current?.cancel();
    });

    expect(hookRef.current?.target?.id).toBe(asked.id);
    held.resolve({ product: asked });
  });
});

describe("Excluir produto: o foco depois do sucesso", () => {
  it("vai para o menu do produto vizinho", async () => {
    const held = holdTheServer();
    const products = [product(1), product(2), product(3)];
    const { asked, field } = await openFor(products, 1);
    await typeNameAndSubmit(field, asked.name);
    await waitFor(() => expect(deleteCall).toHaveBeenCalledTimes(1));

    act(() => {
      held.resolve({ product: { ...asked, status: "deleted" } });
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Mais ações para Produto 3" })
      )
    );
  });

  it("vai para a aba Arquivados quando a lista esvazia", async () => {
    const held = holdTheServer();
    const { asked, field } = await openFor([product(1)], 0);
    await typeNameAndSubmit(field, asked.name);
    await waitFor(() => expect(deleteCall).toHaveBeenCalledTimes(1));

    act(() => {
      held.resolve({ product: { ...asked, status: "deleted" } });
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("tab", { name: "Arquivados" })
      )
    );
  });
});

describe("Excluir produto: o diálogo sozinho com a chamada em curso", () => {
  const renderDialog = (pending: boolean) => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ProductDeleteDialog
        finalFocus={keepFocusDefault}
        isOffline={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
        organizationId="org"
        pending={pending}
        product={product(1)}
        refusal={null}
        stockHref={null}
      />
    );
    return { onCancel, onConfirm };
  };

  it("sem chamada em curso, Esc, o × e Manter arquivado cancelam", async () => {
    const { onCancel } = renderDialog(false);
    const user = userEvent.setup();
    await screen.findByLabelText(NAME_FIELD);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Manter arquivado" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("com a chamada em curso, Esc e Manter arquivado não chamam onCancel e o × some", async () => {
    const { onCancel } = renderDialog(true);
    const user = userEvent.setup();
    await screen.findByLabelText(NAME_FIELD);
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Manter arquivado" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector(CLOSE_BUTTON_SELECTOR)).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Manter arquivado" })
        .getAttribute("aria-disabled")
    ).toBe("true");
  });

  it("sem chamada em curso, tocar fora do diálogo cancela", async () => {
    const { onCancel } = renderDialog(false);
    const user = userEvent.setup();
    await screen.findByLabelText(NAME_FIELD);
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    await user.click((overlay ?? document.body) as HTMLElement);
    await waitFor(() => expect(onCancel).toHaveBeenCalled());
  });

  it("com a chamada em curso, tocar fora do diálogo não chama onCancel", async () => {
    const { onCancel } = renderDialog(true);
    const user = userEvent.setup();
    await screen.findByLabelText(NAME_FIELD);
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    await user.click((overlay ?? document.body) as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
