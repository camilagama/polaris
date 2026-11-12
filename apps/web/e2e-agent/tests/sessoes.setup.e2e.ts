import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

/**
 * Uma sessão salva por loja fictícia (bb-venda, bb-estoque, bb-despesas e as dos testes de achado). O cookie é o do
 * `testUtils` do Better Auth com o segredo do run (pilha/preparar.ts): sem senha, sem Google e sem tela de entrada,
 * então o modelo nunca digita credencial e as capturas seguem ligadas. O valor do cookie também é um `secret` da
 * config, que o e2e troca por `<secret:sessao-...>` no relatório.
 */

interface StoredSession {
  cookies: { name: string; value: string; httpOnly: boolean }[];
  organizationId: string;
}

const STORES = [
  "bb-venda",
  "bb-estoque",
  "bb-despesas",
  "bb-achados-1",
  "bb-achados-2",
] as const;

function storedSession(store: string): StoredSession {
  const file = join(process.env.E2E_AGENT_STATE ?? "", "sessoes.json");
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<
    string,
    StoredSession
  >;
  const session = all[store];
  if (!session) {
    throw new Error(`A loja ${store} não foi semeada (E2E_AGENT_LOJAS).`);
  }
  return session;
}

for (const store of STORES) {
  test.setup(
    `sessão ${store}`,
    { sessions: [store] },
    async ({ app, browser, screen, session }) => {
      const stored = storedSession(store);
      await browser.setCookies(
        stored.cookies.map((cookie) => ({
          httpOnly: cookie.httpOnly,
          name: cookie.name,
          sameSite: "Lax" as const,
          url: "/",
          value: cookie.value,
        }))
      );
      await app.open("/");
      await expect(
        screen.getByRole("link", { exact: true, name: "Vender" }).first()
      ).toBeVisible();
      await session.save(store);
    }
  );
}
