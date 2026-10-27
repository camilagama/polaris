import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/**
 * Piloto do `e2e` (t440, não mesclar): a pilha local do e2e-real (vite preview + workerd + PostgreSQL de teste),
 * subida por `pilha/com-pilha.sh`, sem `app.command`. A chave do modelo vem só de `E2E_ANTHROPIC_API_KEY`,
 * passada ao provider aqui; os cookies de sessão das lojas fictícias (sessoes.json, fora do repositório) entram
 * como `secrets`, que o e2e troca por `<secret:nome>` em relatório, saída e entrada do modelo.
 */

const anthropic = createAnthropic({
  apiKey: process.env.E2E_ANTHROPIC_API_KEY ?? "",
});

const stateDir = process.env.E2E_AGENT_STATE ?? "";
const sessionsFile = join(stateDir, "sessoes.json");

interface StoredSession {
  cookies: { name: string; value: string }[];
  organizationId: string;
}

const sessions: Record<string, StoredSession> =
  stateDir && existsSync(sessionsFile)
    ? JSON.parse(readFileSync(sessionsFile, "utf8"))
    : {};

const secrets = Object.fromEntries(
  Object.entries(sessions).flatMap(([store, session]) =>
    session.cookies.map((cookie) => [`sessao-${store}`, cookie.value])
  )
);

const context =
  "Polaris é um app de gestão para pequenas lojas (pt-BR, valores em reais). A loja é fictícia e já começa logada; " +
  "não há e-mail, Google, pagamento real nem cobrança neste ambiente local. " +
  "Nunca encerre a organização, nunca exporte dados, nunca assine o plano Pro e nunca saia da conta (Sair). " +
  "Não são bugs: dados de exemplo da semeadura (Camiseta básica, Boné aba curva, Meia cano alto e uma venda de 2 camisetas); " +
  "um link que abre outra aba; texto acessível partido em volta de links; imagens que carregam ao rolar.";

const explorer = {
  context,
  maxInputTokens: 28_000,
  maxModelCalls: 16,
  maxSteps: 20,
  model: anthropic("claude-sonnet-5-5"),
  // a sessão (b) morreu com MODEL_PROVIDER_FAILED: o bloco de thinking do Sonnet 5.5 recusado porque a lista de
  // ferramentas mudou no meio do passo; drop_block é o que a própria API sugere (beta thinking-binding-controls)
  providerOptions: {
    anthropic: {
      thinking: {
        blockBinding: { prefixMismatchBehavior: "drop_block" },
        type: "adaptive",
      },
    },
  },
};

export default {
  agents: {
    cetico: {
      ...explorer,
      system:
        "Você é um lojista na primeira semana de uso. Desconfie de todo número, data, total e contagem na tela; " +
        "confira cada um contra os outros lugares onde ele aparece.",
    },
    default: {
      context,
      maxInputTokens: 32_000,
      model: anthropic("claude-haiku-5-5"),
    },
    explorador: explorer,
  },
  cache: { mode: "read-write" },
  reporters: ["list"],
  retries: 0,
  secrets,
  targets: [
    {
      app: { url: `http://127.0.0.1:${process.env.E2E_AGENT_PORT ?? "4321"}` },
      engine: web(),
      name: "web",
    },
  ],
  tests: ["tests/**/*.e2e.ts"],
  workers: 1,
} satisfies E2EConfig;
