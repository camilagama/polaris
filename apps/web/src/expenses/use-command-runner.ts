import type { ExpenseReadModel } from "@polaris/contracts";
import { useCallback, useState } from "react";
import { browserConnection } from "../lib/browser-connection";
import { rpcErrorCode } from "../lib/rpc-error";
import { type ExpenseAction, expenseErrorMessage } from "./expense-errors";

export interface Feedback {
  kind: "error" | "success";
  text: string;
  /** The expense the notice can give back ("Desfazer"), in the version the command left it: kept when the give back itself failed, so it can be tried again. */
  undo?: ExpenseReadModel;
}

/** What a command says when it works: the sentence, and what "Desfazer" would restore, when it can. */
export type CommandSuccess = string | { text: string; undo: ExpenseReadModel };

export type CommandOutcome = "conflict" | "failed" | "ok";

/**
 * Runs one command at a time for a part of the screen: the busy key disables
 * the buttons, and the result becomes a message. Never throws. Offline nothing leaves: the buttons say why (the
 * notice of the shell), so a press that still gets here, by the keyboard, sends nothing.
 */
export function useCommandRunner() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const clearFeedback = useCallback(() => setFeedback(null), []);

  const run = useCallback(
    async (
      key: string,
      action: ExpenseAction,
      command: () => Promise<CommandSuccess>,
      retryUndo?: ExpenseReadModel
    ): Promise<CommandOutcome> => {
      if (!browserConnection.isOnline()) {
        return "failed";
      }
      setBusy(key);
      setFeedback(null);
      try {
        const done = await command();
        setFeedback(
          typeof done === "string"
            ? { kind: "success", text: done }
            : { kind: "success", text: done.text, undo: done.undo }
        );
        return "ok";
      } catch (caughtError) {
        const conflict = rpcErrorCode(caughtError) === "CONFLICT";
        // a conflict means the version of the notice is old: giving back again would only conflict again
        setFeedback({
          kind: "error",
          text: expenseErrorMessage(caughtError, action),
          ...(retryUndo && !conflict ? { undo: retryUndo } : {}),
        });
        return conflict ? "conflict" : "failed";
      } finally {
        setBusy(null);
      }
    },
    []
  );

  return { busy, clearFeedback, feedback, run, setFeedback };
}
