import { describe, expect, it } from "vitest";
import {
  createDialogEntries,
  type DialogEntry,
  type EntryHistory,
  entryOf,
} from "./dialog-history";

/**
 * A history like the browser's: `pushState` drops what was ahead, and `back()` is a step that lands later, with a
 * `popstate` (here, when the test calls `land()`), as the browser queues the traversal.
 */
class FakeHistory implements EntryHistory {
  entries: unknown[];
  index: number;
  private readonly listeners: (() => void)[] = [];
  private pending = 0;

  constructor(entries: unknown[] = [null]) {
    this.entries = [...entries];
    this.index = this.entries.length - 1;
  }

  get state(): unknown {
    return this.entries[this.index];
  }

  get length() {
    return this.entries.length;
  }

  pushState(state: unknown) {
    this.entries = [...this.entries.slice(0, this.index + 1), state];
    this.index += 1;
  }

  back() {
    this.pending -= 1;
  }

  forward() {
    this.pending += 1;
  }

  onPopState(listener: () => void) {
    this.listeners.push(listener);
  }

  /** The queued steps land, each with its `popstate`, as the person or the page asked for them. */
  land() {
    while (this.pending !== 0) {
      const step = Math.sign(this.pending);
      this.pending -= step;
      const next = this.index + step;
      if (next < 0 || next >= this.entries.length) {
        continue;
      }
      this.index = next;
      for (const listener of this.listeners) {
        listener();
      }
    }
  }
}

/** One open form dialog, as `dialog.tsx` runs it: closed by the step back, or by itself. */
function openDialog(
  history: FakeHistory,
  entries: ReturnType<typeof createDialogEntries>
) {
  const dialog = { closedByBack: false, entry: null as DialogEntry | null };
  const entry = entries.push();
  dialog.entry = entry;
  let taken = false;
  history.onPopState(() => {
    if (taken || dialog.closedByBack || !entries.taken(entry)) {
      return;
    }
    taken = true;
    entries.release(entry);
    dialog.closedByBack = true;
  });
  return {
    ...dialog,
    get closedByBack() {
      return dialog.closedByBack;
    },
    /** Esc, ×, Cancelar, Salvar. */
    closeItself() {
      if (!taken) {
        taken = true;
        entries.remove(entry);
      }
    },
  };
}

function setUp(entries: unknown[] = [null]) {
  const history = new FakeHistory(entries);
  const stack = createDialogEntries(history, "load");
  history.onPopState(() => stack.settle());
  return { history, stack };
}

describe("pilha de entradas do Dialog de tela inteira", () => {
  it("abrir empurra uma entrada na mesma página e guarda o que o estado já tinha", () => {
    const { history, stack } = setUp([{ aba: "metas" }]);
    const entry = stack.push();
    expect(history.length).toBe(2);
    expect(entry.depth).toBe(1);
    expect(history.state).toMatchObject({ aba: "metas" });
    expect(entryOf(history.state)).toEqual(entry);
  });

  it("o voltar fecha o Dialog e o voltar seguinte sai da tela", () => {
    const { history, stack } = setUp([null, null]);
    const dialog = openDialog(history, stack);
    history.back();
    history.land();
    expect(dialog.closedByBack).toBe(true);
    expect(history.index).toBe(1);
    // the entry under it is the screen: the next step back leaves
    expect(entryOf(history.state)).toBeNull();
  });

  it("Esc, ×, Cancelar e Salvar retiram a própria entrada: não sobra voltar morto", () => {
    const { history, stack } = setUp([null, null]);
    const dialog = openDialog(history, stack);
    dialog.closeItself();
    history.land();
    expect(dialog.closedByBack).toBe(false);
    expect(history.index).toBe(1);
    expect(entryOf(history.state)).toBeNull();
    // opening again pushes over the screen, not over a leftover entry
    expect(stack.push().depth).toBe(1);
    expect(history.length).toBe(3);
  });

  it("dois Dialogs: cada um tem a sua entrada, o voltar fecha só o de cima e o segundo voltar fecha o de baixo", () => {
    const { history, stack } = setUp([null, null]);
    const below = openDialog(history, stack);
    const above = openDialog(history, stack);
    expect(above.entry?.depth).toBe(2);
    expect(history.length).toBe(4);

    history.back();
    history.land();
    expect(above.closedByBack).toBe(true);
    expect(below.closedByBack).toBe(false);
    expect(entryOf(history.state)).toEqual(below.entry);

    history.back();
    history.land();
    expect(below.closedByBack).toBe(true);
    expect(history.index).toBe(1);
  });

  it("o de cima fechado por Esc não fecha o de baixo", () => {
    const { history, stack } = setUp();
    const below = openDialog(history, stack);
    const above = openDialog(history, stack);
    above.closeItself();
    history.land();
    expect(below.closedByBack).toBe(false);
    expect(entryOf(history.state)).toEqual(below.entry);
  });

  it("os dois fechados ao mesmo tempo: a entrada que sobra é pulada e o voltar seguinte sai", () => {
    const { history, stack } = setUp([null, null]);
    const below = openDialog(history, stack);
    const above = openDialog(history, stack);
    // the dialog over it unmounts first and takes its entry; the one under it is no longer the current entry
    above.closeItself();
    below.closeItself();
    history.land();
    expect(history.index).toBe(1);
    expect(entryOf(history.state)).toBeNull();
  });

  it("aba recém-aberta: a entrada do Dialog é a primeira depois da tela, e o voltar fica na tela", () => {
    const { history, stack } = setUp([null]);
    const dialog = openDialog(history, stack);
    history.back();
    history.land();
    expect(dialog.closedByBack).toBe(true);
    expect(history.index).toBe(0);
  });

  it("recarga com o Dialog aberto: a entrada que sobrou é pulada na carga", () => {
    const left = { polarisDialog: { depth: 1, id: "older-load-1" } };
    const history = new FakeHistory([null, null, left]);
    const stack = createDialogEntries(history, "load");
    history.onPopState(() => stack.settle());
    stack.settle();
    history.land();
    expect(history.index).toBe(1);
    expect(entryOf(history.state)).toBeNull();
  });

  it("um passo à frente até a entrada de um Dialog já fechado volta para a tela", () => {
    const { history, stack } = setUp([null, null]);
    const dialog = openDialog(history, stack);
    history.back();
    history.land();
    expect(dialog.closedByBack).toBe(true);
    history.forward();
    history.land();
    expect(history.index).toBe(1);
  });

  it("um estado que não é da pilha não é entrada", () => {
    expect(entryOf(null)).toBeNull();
    expect(entryOf("texto")).toBeNull();
    expect(entryOf({ polarisDialog: { depth: "1", id: "x" } })).toBeNull();
  });
});
