// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";

const FIELDS: FilterField[] = [
  { id: "customer", label: "Cliente", placeholder: "Nome", type: "text" },
  { id: "query", label: "Produto", placeholder: "Nome", type: "text" },
];
const RULES: FilterRule[] = [
  { fieldId: "customer", value: "Maria" },
  { fieldId: "query", value: "camiseta" },
];
const CLEAR_ALL = { name: "Limpar tudo" };

afterEach(cleanup);

describe("Limpar tudo da barra", () => {
  it("sem onClearAll entrega a lista vazia a onChange, como as outras telas", () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        fields={FIELDS}
        label="Filtrar"
        onChange={onChange}
        value={RULES}
      />
    );
    fireEvent.click(screen.getByRole("button", CLEAR_ALL));
    expect(onChange).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("com onClearAll chama só ele: a tela decide o que mais sai junto com as pílulas", () => {
    const onChange = vi.fn();
    const onClearAll = vi.fn();
    render(
      <FilterBar
        fields={FIELDS}
        label="Filtrar"
        onChange={onChange}
        onClearAll={onClearAll}
        value={RULES}
      />
    );
    fireEvent.click(screen.getByRole("button", CLEAR_ALL));
    expect(onClearAll).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });
});
