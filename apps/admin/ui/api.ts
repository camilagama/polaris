/**
 * The page's only way to the Admin API: a GET of JSON, or a POST of a JSON body, to this origin, one call per action
 * and never repeated by itself (each read may be counted or audited by the server). A POST goes as
 * `application/json` from the page's own origin, which the browser names in `Origin`: the server refuses a write
 * without both (ADR 0070). Every answer that is not the data becomes one of the problems below, each with its own
 * sentence; no code, status or message of the server reaches the screen (AC-14).
 */

export type Problem =
  | "conflict"
  | "failed"
  | "forbidden"
  | "invalid"
  | "network"
  | "not_allowed"
  | "not_found"
  | "plan_catalog_incomplete"
  | "rate_limited"
  | "refused"
  | "session"
  | "unavailable";

export interface ApiFailure {
  ok: false;
  problem: Problem;
  /** With `rate_limited`: the seconds the server said to wait (`Retry-After`), when it said. */
  retryAfterSeconds?: number;
}

type ApiResult<T> = { data: T; ok: true } | ApiFailure;

export const PROBLEM_TEXT: Readonly<Record<Problem, string>> = {
  conflict:
    "Esta ação já não se aplica ao estado atual. Releia e confira antes de tentar de novo.",
  failed: "Erro no Admin. Tente de novo; se continuar, avise a engenharia.",
  forbidden: "Sem permissão para isto.",
  invalid:
    "A busca não foi aceita: use até 100 caracteres, sem caracteres de controle.",
  network: "Não foi possível falar com o Admin. Tente de novo.",
  not_allowed:
    "O caso não permite esta escolha. Confira as regras desta etapa e escolha de novo.",
  not_found: "Loja não encontrada.",
  plan_catalog_incomplete:
    "O catálogo de planos está incompleto; avise a engenharia.",
  rate_limited: "Muitas consultas em pouco tempo. Espere e tente de novo.",
  refused: "Consulta recusada: confira se o caso está aberto e é desta loja.",
  session: "Sua sessão do Access acabou. Recarregue a página.",
  unavailable:
    "O Admin está indisponível agora. Tente de novo em alguns minutos.",
};

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Api {
  get: <T>(path: string) => Promise<ApiResult<T>>;
  /**
   * `answers` names the statuses besides 2xx whose JSON body is the answer, not a problem: a route that says what it
   * did with a 404 or a 409 (the retry of a dead event). Any other status is a problem as always.
   */
  post: <T>(
    path: string,
    body: Readonly<Record<string, boolean | string | readonly string[]>>,
    answers?: readonly number[]
  ) => Promise<ApiResult<T>>;
}

const STATUS_PROBLEMS: Readonly<Record<number, Problem>> = {
  400: "invalid",
  401: "session",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string"
      ? body.error
      : null;
  } catch {
    return null;
  }
}

async function problemOf(response: Response): Promise<Problem> {
  // With the Access session over, Access answers with a redirect to its own login, on another origin. The page
  // never follows it: `redirect: "manual"` turns it into an opaque answer, which here means the session ended.
  if (response.type === "opaqueredirect" || response.status === 0) {
    return "session";
  }
  const known = STATUS_PROBLEMS[response.status];
  if (response.status === 403) {
    // the refund window's one refusal (a closed case, a case of another store, an inactive operator) is not a
    // missing capability: it has its own sentence, which does not say which of them it was (AC-10)
    return (await errorCode(response)) === "refund_window_read_refused"
      ? "refused"
      : "forbidden";
  }
  if (response.status === 400) {
    // a privacy decision or action the case does not allow is the operator's choice refused, not a malformed request
    return (await errorCode(response)) === "privacy_decision_not_allowed"
      ? "not_allowed"
      : "invalid";
  }
  if (known !== undefined) {
    return known;
  }
  if (response.status === 503) {
    return (await errorCode(response)) === "plan_catalog_incomplete"
      ? "plan_catalog_incomplete"
      : "unavailable";
  }
  return "failed";
}

const SECONDS = /^\d{1,6}$/;

async function failureOf(response: Response): Promise<ApiFailure> {
  const problem = await problemOf(response);
  if (problem !== "rate_limited") {
    return { ok: false, problem };
  }
  const wait = response.headers.get("retry-after") ?? "";
  return SECONDS.test(wait)
    ? { ok: false, problem, retryAfterSeconds: Number(wait) }
    : { ok: false, problem };
}

export function createApi(fetchJson: Fetch): Api {
  const send = async <T>(
    path: string,
    init: RequestInit,
    answers: readonly number[] = []
  ): Promise<ApiResult<T>> => {
    let response: Response;
    try {
      // the method, headers and body are the caller's; how the request goes out is not
      response = await fetchJson(path, {
        ...init,
        cache: "no-store",
        credentials: "same-origin",
        redirect: "manual",
      });
    } catch {
      return { ok: false, problem: "network" };
    }
    if (!(response.ok || answers.includes(response.status))) {
      return failureOf(response);
    }
    try {
      return { data: (await response.json()) as T, ok: true };
    } catch {
      return { ok: false, problem: "failed" };
    }
  };
  return {
    get: (path) =>
      send(path, { headers: { accept: "application/json" }, method: "GET" }),
    post: (path, body, answers) =>
      send(
        path,
        {
          body: JSON.stringify(body),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        },
        answers
      ),
  };
}

interface ClosureNoticeAnswer {
  dismissed: boolean;
  noticeId: string;
  reissue: number;
}

export type ClosureNoticeAct =
  | { kind: "dismiss"; reason: string }
  | { kind: "reissue" };

/**
 * What the closure notice routes answered (ADR 0102): the act was recorded; the server refused it with a named reason
 * (a 409, said in words by the screen, the code never shown); or the call ended in one of the page's problems.
 */
export type ClosureNoticeOutcome =
  | { kind: "done"; answer: ClosureNoticeAnswer }
  | { kind: "problem"; problem: Problem }
  | { kind: "refused"; code: string };

function isClosureNoticeAnswer(value: unknown): value is ClosureNoticeAnswer {
  return (
    typeof value === "object" &&
    value !== null &&
    "noticeId" in value &&
    typeof value.noticeId === "string" &&
    value.noticeId.length > 0
  );
}

function refusalCode(value: unknown): string | null {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : null;
}

/**
 * Reissues or dismisses the closure notice of the case's store: one POST, never repeated by itself. The server's 409
 * names why it refused, so that status is read as an answer; an answer that is neither the notice nor a named
 * refusal is a failure whose outcome the page cannot confirm.
 */
export async function sendClosureNotice(
  api: Api,
  caseId: string,
  organizationId: string,
  act: ClosureNoticeAct
): Promise<ClosureNoticeOutcome> {
  const answer =
    act.kind === "dismiss"
      ? await api.post<unknown>(
          `/api/support-cases/${encodeURIComponent(caseId)}/closure-notice/dismiss`,
          { organizationId, reason: act.reason },
          [409]
        )
      : await api.post<unknown>(
          `/api/support-cases/${encodeURIComponent(caseId)}/closure-notice/reissue`,
          { organizationId },
          [409]
        );
  if (!answer.ok) {
    return { kind: "problem", problem: answer.problem };
  }
  if (isClosureNoticeAnswer(answer.data)) {
    return { answer: answer.data, kind: "done" };
  }
  const code = refusalCode(answer.data);
  return code === null
    ? { kind: "problem", problem: "failed" }
    : { code, kind: "refused" };
}
