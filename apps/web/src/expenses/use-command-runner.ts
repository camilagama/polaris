import { useCallback, useState } from "react";
import { rpcErrorCode } from "../lib/rpc-error";
import { type ExpenseAction, expenseErrorMessage } from "./expense-errors";

export interface Feedback {
  kind: "error" | "success";
  text: string;
}

export type CommandOutcome = "conflict" | "failed" | "ok";

/**
 * Runs one command at a time for a part of the screen: the busy key disables
 * the buttons, and the result becomes a message. Never throws.
 */
export function useCommandRunner() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const run = useCallback(
    async (
      key: string,
      action: ExpenseAction,
      command: () => Promise<string>
    ): Promise<CommandOutcome> => {
      setBusy(key);
      setFeedback(null);
      try {
        const text = await command();
        setFeedback({ kind: "success", text });
        return "ok";
      } catch (caughtError) {
        setFeedback({
          kind: "error",
          text: expenseErrorMessage(caughtError, action),
        });
        return rpcErrorCode(caughtError) === "CONFLICT" ? "conflict" : "failed";
      } finally {
        setBusy(null);
      }
    },
    []
  );

  return { busy, clearFeedback, feedback, run, setFeedback };
}
