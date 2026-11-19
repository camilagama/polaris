import { Client } from "pg";

export type StatementKind = "control" | "data" | "setting";

export interface RecordedStatement {
  kind: StatementKind;
  text: string;
}

type QueryArgument = string | { text?: string } | null | undefined;

const transactionControl = /^\s*(begin|commit|rollback|start transaction)\b/i;
const sessionSetting = /\bset_config\s*\(|^\s*set\s/i;

function textOf(argument: QueryArgument) {
  if (typeof argument === "string") {
    return argument;
  }
  return argument?.text ?? "<unreadable statement>";
}

export function kindOfStatement(text: string): StatementKind {
  if (transactionControl.test(text)) {
    return "control";
  }
  return sessionSetting.test(text) ? "setting" : "data";
}

/**
 * Records every statement the `pg` driver sends from now on, as the platform's Hyperdrive counts them: one per
 * `query` call, with BEGIN, COMMIT and the settings of the transaction included. Counting at the driver means the
 * routes are measured through their real code path (session, tenant transaction, repository) and not through a
 * model of it. `stop` puts the driver back.
 */
export function recordStatements() {
  const prototype = Client.prototype as unknown as {
    query: (this: unknown, ...args: unknown[]) => unknown;
  };
  const original = prototype.query;
  const statements: RecordedStatement[] = [];
  prototype.query = function recorded(this: unknown, ...args: unknown[]) {
    const text = textOf(args[0] as QueryArgument);
    statements.push({ kind: kindOfStatement(text), text });
    return original.apply(this, args);
  };
  return {
    statements,
    stop() {
      prototype.query = original;
    },
  };
}
