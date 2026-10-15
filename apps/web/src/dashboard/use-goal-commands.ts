import type { GoalReadModel } from "@polaris/contracts";
import { useCallback, useState } from "react";
import type { Feedback } from "../expenses/use-command-runner";
import { orpcClient } from "../lib/orpc";
import { rpcErrorCode } from "../lib/rpc-error";
import { type GoalAction, goalErrorMessage } from "./goal-errors";
import type { GoalCreateInput, GoalEditInput } from "./goal-model";

export type GoalOutcome = "conflict" | "failed" | "ok";

/**
 * The commands of the goals panel, one at a time: the busy key disables the
 * buttons, and the result becomes a message. After anything but a plain failure
 * the list is read again, because the server settles goals when it reads them
 * and the answers of update and cancel carry no progress. Never throws.
 */
export function useGoalCommands(
  organizationId: string,
  reload: () => Promise<void>
) {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const run = useCallback(
    async (
      key: string,
      action: GoalAction,
      command: () => Promise<string>
    ): Promise<GoalOutcome> => {
      setBusy(key);
      setFeedback(null);
      let outcome: GoalOutcome;
      try {
        setFeedback({ kind: "success", text: await command() });
        outcome = "ok";
      } catch (caughtError) {
        setFeedback({
          kind: "error",
          text: goalErrorMessage(caughtError, action),
        });
        outcome =
          rpcErrorCode(caughtError) === "CONFLICT" ? "conflict" : "failed";
      }
      if (outcome !== "failed") {
        await reload();
      }
      setBusy(null);
      return outcome;
    },
    [reload]
  );

  const create = useCallback(
    (input: GoalCreateInput) =>
      run("create", "create", async () => {
        await orpcClient.goal.create({ ...input, organizationId });
        return "Meta criada.";
      }),
    [organizationId, run]
  );

  const update = useCallback(
    (goal: GoalReadModel, input: GoalEditInput) =>
      run(`update:${goal.id}`, "update", async () => {
        const result = await orpcClient.goal.update({
          expectedVersion: goal.version,
          id: goal.id,
          name: input.name,
          organizationId,
          target: input.target,
        });
        return result.changed
          ? "Meta atualizada."
          : "Nada mudou: a meta já estava assim.";
      }),
    [organizationId, run]
  );

  const cancel = useCallback(
    (goal: GoalReadModel) =>
      run(`cancel:${goal.id}`, "cancel", async () => {
        const result = await orpcClient.goal.cancel({
          expectedVersion: goal.version,
          id: goal.id,
          organizationId,
        });
        return result.changed
          ? "Meta cancelada. Ela fica na lista, só para leitura."
          : "A meta já estava cancelada.";
      }),
    [organizationId, run]
  );

  return { busy, cancel, clearFeedback, create, feedback, update };
}
