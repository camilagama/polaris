/** A lie-fi connection must not hold the start of the app: after this, the lookup is given up. */
const SESSION_LOOKUP_TIMEOUT_MS = 4000;

/** How long the answer of this tab's last lookup is reused; the runtime's own recheck window is longer (30 s). */
export const SESSION_MEMORY_MS = 10_000;

const SESSION_URL = "/api/auth/get-session";

/**
 * What the server said: the HTTP status and, for a 2xx, the parsed body (`null` is the server's "no session";
 * `undefined` is a body that could not be read). Anything but a 2xx with a session in it is never remembered.
 */
export interface SessionAnswer {
  body: unknown;
  status: number;
}

export interface SessionLookup {
  /** Drops the remembered answer (the session ended or changed hands); a lookup in flight is not reused after it. */
  forget: () => void;
  /**
   * The session of this tab. By default the answer of the last 10 s is reused and calls in flight are joined, so
   * the shell, the runtime and the Assinatura do not each ask. `fresh` always goes to the server (a queue to send,
   * who is leaving) and its answer becomes the one remembered.
   */
  read: (options?: { fresh?: boolean }) => Promise<SessionAnswer>;
}

interface Dependencies {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  memoryMs?: number;
  now: () => number;
  timeoutMs?: number;
}

const lookups = new Set<SessionLookup>();

/** The session ended or changed hands in this tab: no lookup of it keeps what it remembered. */
export function forgetSessionLookups(): void {
  for (const lookup of lookups) {
    lookup.forget();
  }
}

/** The session token and the rest of the body are not needed by anyone and are not kept. */
function onlyTheUser(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    return body;
  }
  const { user } = body as { user?: unknown };
  if (typeof user !== "object" || user === null) {
    return {};
  }
  const { email, id, name } = user as Record<string, unknown>;
  return { user: { email, id, name } };
}

/**
 * Held in memory, per tab, and never written to the device: the e-mail in the answer is "never kept on the device".
 * A failure, a non-2xx and the "no session" answer are not remembered, so a session that ended is seen at once.
 */
export function createSessionLookup(dependencies: Dependencies): SessionLookup {
  const {
    fetch: load,
    memoryMs = SESSION_MEMORY_MS,
    now,
    timeoutMs = SESSION_LOOKUP_TIMEOUT_MS,
  } = dependencies;
  let remembered: { answer: SessionAnswer; at: number; order: number } | null =
    null;
  let flying: Promise<SessionAnswer> | null = null;
  let issued = 0;
  let epoch = 0;

  async function ask(): Promise<SessionAnswer> {
    issued += 1;
    const order = issued;
    const startedAt = now();
    const startedEpoch = epoch;
    const response = await load(SESSION_URL, {
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = response.ok
      ? onlyTheUser(await response.json().catch(() => undefined))
      : undefined;
    const answer = { body, status: response.status };
    if (
      startedEpoch === epoch &&
      (remembered === null || remembered.order < order)
    ) {
      if (response.ok && body !== undefined && body !== null) {
        // the age counts from the start of the lookup: the answer is no newer than that
        remembered = { answer, at: startedAt, order };
      } else if (
        body === null ||
        response.status === 401 ||
        response.status === 403
      ) {
        // a newer answer that proves there is no session overrides the one remembered
        remembered = null;
      }
    }
    return answer;
  }

  function start(): Promise<SessionAnswer> {
    const lookup = ask().finally(() => {
      if (flying === lookup) {
        flying = null;
      }
    });
    flying = lookup;
    return lookup;
  }

  const lookup: SessionLookup = {
    forget() {
      epoch += 1;
      remembered = null;
      flying = null;
    },
    read(options) {
      if (options?.fresh) {
        return start();
      }
      if (remembered) {
        const age = now() - remembered.at;
        // a clock that went back counts as nothing remembered
        if (age >= 0 && age <= memoryMs) {
          return Promise.resolve(remembered.answer);
        }
      }
      return flying ?? start();
    },
  };
  lookups.add(lookup);
  return lookup;
}
