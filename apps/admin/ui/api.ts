/**
 * The page's only way to the Admin API: a GET of JSON from this origin, one call per action and never repeated by
 * itself (each read may be counted or audited by the server). Every answer that is not the data becomes one of the
 * problems below, each with its own sentence; no code, status or message of the server reaches the screen (AC-14).
 */

export type Problem =
  | "failed"
  | "forbidden"
  | "invalid"
  | "network"
  | "not_found"
  | "plan_catalog_incomplete"
  | "rate_limited"
  | "session"
  | "unavailable";

type ApiResult<T> = { data: T; ok: true } | { ok: false; problem: Problem };

export const PROBLEM_TEXT: Readonly<Record<Problem, string>> = {
  failed: "Erro no Admin. Tente de novo; se continuar, avise a engenharia.",
  forbidden: "Sem permissão para isto.",
  invalid:
    "A busca não foi aceita: use até 100 caracteres, sem caracteres de controle.",
  network: "Não foi possível falar com o Admin. Tente de novo.",
  not_found: "Loja não encontrada.",
  plan_catalog_incomplete:
    "O catálogo de planos está incompleto; avise a engenharia.",
  rate_limited: "Muitas consultas em pouco tempo. Espere e tente de novo.",
  session: "Sua sessão do Access acabou. Recarregue a página.",
  unavailable:
    "O Admin está indisponível agora. Tente de novo em alguns minutos.",
};

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface Api {
  get: <T>(path: string) => Promise<ApiResult<T>>;
}

const STATUS_PROBLEMS: Readonly<Record<number, Problem>> = {
  400: "invalid",
  401: "session",
  403: "forbidden",
  404: "not_found",
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

export function createApi(fetchJson: Fetch): Api {
  return {
    get: async <T>(path: string): Promise<ApiResult<T>> => {
      let response: Response;
      try {
        response = await fetchJson(path, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "manual",
        });
      } catch {
        return { ok: false, problem: "network" };
      }
      if (!response.ok) {
        return { ok: false, problem: await problemOf(response) };
      }
      try {
        return { data: (await response.json()) as T, ok: true };
      } catch {
        return { ok: false, problem: "failed" };
      }
    },
  };
}
