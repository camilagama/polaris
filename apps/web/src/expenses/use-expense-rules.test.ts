// @vitest-environment happy-dom
import type { ExpenseRuleReadModel } from "@polaris/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExpenseRules } from "./use-expense-rules";

const listRules = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    expense: {
      listRules: (input: unknown, options: unknown) =>
        listRules(input, options),
    },
  },
}));

const ruleOf = (id: string) => ({ id }) as unknown as ExpenseRuleReadModel;

const answer = (...ids: string[]) => ({ rules: ids.map(ruleOf) });

const idsOf = (rules: readonly ExpenseRuleReadModel[]) =>
  rules.map(({ id }) => id);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(cleanup);

beforeEach(() => {
  listRules.mockReset();
  listRules.mockResolvedValue(answer("rule-1"));
});

describe("useExpenseRules", () => {
  it("reads nothing while disabled and stays loading", async () => {
    const { result } = renderHook(() => useExpenseRules("org-a", false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(listRules).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({
      error: null,
      isLoading: true,
      rules: [],
    });
  });

  it("reads once when it turns enabled and keeps the rules in the state", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useExpenseRules("org-a", enabled),
      { initialProps: { enabled: false } }
    );
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    expect(listRules).toHaveBeenCalledTimes(1);
    expect(listRules.mock.calls[0]?.[0]).toEqual({
      organizationId: "org-a",
      status: "all",
    });
    expect(idsOf(result.current.state.rules)).toEqual(["rule-1"]);
    expect(result.current.state.error).toBeNull();
  });

  it("does not read again when it goes back to disabled", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useExpenseRules("org-a", enabled),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(result.current.state.isLoading).toBe(false));
    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listRules).toHaveBeenCalledTimes(1);
    expect(idsOf(result.current.state.rules)).toEqual(["rule-1"]);
  });

  it("reload reads even while disabled, as the panel does after a command", async () => {
    const { result } = renderHook(() => useExpenseRules("org-a", false));
    listRules.mockResolvedValue(answer("rule-1", "rule-2"));
    await act(async () => {
      await result.current.reload();
    });
    expect(listRules).toHaveBeenCalledTimes(1);
    expect(result.current.state.isLoading).toBe(false);
    expect(idsOf(result.current.state.rules)).toEqual(["rule-1", "rule-2"]);
  });

  it("reads again when the store changes while enabled", async () => {
    listRules.mockImplementation((input: { organizationId: string }) =>
      Promise.resolve(answer(`rule-of-${input.organizationId}`))
    );
    const { result, rerender } = renderHook(
      ({ organizationId }) => useExpenseRules(organizationId, true),
      { initialProps: { organizationId: "org-a" } }
    );
    await waitFor(() =>
      expect(idsOf(result.current.state.rules)).toEqual(["rule-of-org-a"])
    );
    rerender({ organizationId: "org-b" });
    await waitFor(() =>
      expect(idsOf(result.current.state.rules)).toEqual(["rule-of-org-b"])
    );
    expect(listRules).toHaveBeenCalledTimes(2);
    expect(listRules.mock.calls[1]?.[0]).toEqual({
      organizationId: "org-b",
      status: "all",
    });
  });

  it("an old answer still in flight does not overwrite the newer one", async () => {
    const old = deferred<{ rules: ExpenseRuleReadModel[] }>();
    listRules.mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useExpenseRules("org-a", true));
    await waitFor(() => expect(listRules).toHaveBeenCalledTimes(1));

    listRules.mockResolvedValueOnce(answer("new-rule"));
    await act(async () => {
      await result.current.reload();
    });
    expect(idsOf(result.current.state.rules)).toEqual(["new-rule"]);

    await act(async () => {
      old.resolve(answer("old-rule"));
      await old.promise;
      await new Promise((done) => {
        setTimeout(done, 0);
      });
    });
    expect(idsOf(result.current.state.rules)).toEqual(["new-rule"]);
    expect(result.current.state.isLoading).toBe(false);
  });
});
