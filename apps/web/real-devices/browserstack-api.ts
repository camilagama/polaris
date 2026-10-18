import { REST } from "./config";

/** As credenciais vêm só do ambiente; nenhum valor é impresso nem gravado. */
export function credentials() {
  const user = process.env.BROWSERSTACK_USERNAME ?? "";
  const key = process.env.BROWSERSTACK_ACCESS_KEY ?? "";
  if (!(user && key)) {
    throw new Error(
      "Defina BROWSERSTACK_USERNAME e BROWSERSTACK_ACCESS_KEY no ambiente (ex.: . ~/.secrets/browserstack.env)."
    );
  }
  return { key, user };
}

/** Remove usuário e chave de qualquer texto antes de ele ir para log ou relatório. */
export function redact(text: string) {
  const { key, user } = credentials();
  const secrets = [
    key,
    encodeURIComponent(key),
    Buffer.from(`${user}:${key}`).toString("base64"),
    // um usuário curto estragaria o texto: só entra se for distintivo
    ...(user.length >= 6 ? [user] : []),
  ];
  return secrets.reduce(
    (clean, secret) => clean.split(secret).join("***"),
    text
  );
}

async function rest(path: string, init: RequestInit = {}) {
  const { key, user } = credentials();
  return await fetch(`${REST}${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`,
      "content-type": "application/json",
    },
  });
}

/**
 * Troca o perfil de rede do aparelho com a sessão em andamento (`update_network.json`).
 * `no-network` deixa o aparelho sem rede; a sessão WebDriver não passa pela rede do aparelho.
 */
export async function setNetworkProfile(sessionId: string, profile: string) {
  const response = await rest(`/sessions/${sessionId}/update_network.json`, {
    body: JSON.stringify({ networkProfile: profile }),
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(
      `update_network.json (${profile}): HTTP ${response.status}`
    );
  }
}

/**
 * Volta a rede do aparelho ao normal. O perfil `reset` responde 200 mas não religa a rede nos
 * aparelhos testados; o perfil documentado `4g-lte-advanced-good` religa.
 */
export function restoreNetwork(sessionId: string) {
  return setNetworkProfile(sessionId, "4g-lte-advanced-good");
}

export async function sessionLinks(sessionId: string) {
  try {
    const response = await rest(`/sessions/${sessionId}.json`);
    if (!response.ok) {
      return { dashboard: null };
    }
    const body = (await response.json()) as {
      automation_session?: { browser_url?: string };
    };
    return { dashboard: body.automation_session?.browser_url ?? null };
  } catch {
    return { dashboard: null };
  }
}

/** Marca o resultado da sessão no painel do BrowserStack; devolve `false` se a API recusar. */
export async function markSession(
  sessionId: string,
  status: "failed" | "passed",
  reason: string
) {
  try {
    const response = await rest(`/sessions/${sessionId}.json`, {
      body: JSON.stringify({ reason: reason.slice(0, 250), status }),
      method: "PUT",
    });
    return response.ok;
  } catch {
    return false;
  }
}
