import { randomBytes } from "node:crypto";
import { makeSignature } from "better-auth/crypto";
import { createJourneyUser, expect, test } from "../fixtures";
import { journeyName } from "../journey-names";

const FIRST_SCRIPT = /<script[^>]*src="(\/assets\/[^"]+\.js)"/;
const SESSION_COOKIE = /([\w.-]*session_token)=([^.;]+)\./;

/**
 * The first tests of the run: the preview really uses the run's secret and database, and serves the deployable
 * bundle. If they fail, no journey starts (the other projects depend on this one).
 */
test("o preview aceita a sessão assinada pelo segredo do run e recusa a de outro segredo", async ({
  request,
}, testInfo) => {
  const origin = String(testInfo.project.use.baseURL);
  const user = await createJourneyUser(
    origin,
    journeyName("pilha", "fumaca", testInfo.retry)
  );

  const accepted = await request.get("/api/auth/get-session", {
    headers: Object.fromEntries(user.headers),
  });
  expect(accepted.status()).toBe(200);
  expect((await accepted.json())?.user?.id).toBe(user.id);

  // the same session token, signed by another secret
  const cookie = user.headers.get("cookie") ?? "";
  const [, cookieName, token] =
    SESSION_COOKIE.exec(decodeURIComponent(cookie)) ?? [];
  expect(token, "the run cookie carries a signed session token").toBeTruthy();
  const otherSignature = await makeSignature(
    token as string,
    randomBytes(32).toString("hex")
  );
  const refused = await request.get("/api/auth/get-session", {
    headers: {
      cookie: `${cookieName}=${encodeURIComponent(`${token}.${otherSignature}`)}`,
    },
  });
  expect(refused.status()).toBe(200);
  expect(await refused.json()).toBeNull();
});

test("o preview serve o bundle de produção: sem laboratório offline", async ({
  page,
}) => {
  await page.goto("/offline-poc");
  await expect(
    page.getByRole("heading", { name: "Página não encontrada" })
  ).toBeVisible();
});

test("o preview responde 404, nunca a página, para um pedaço de /assets/ que não existe, e serve o que existe", async ({
  request,
}) => {
  const missing = await request.get("/assets/dashboard-page-ZZZZZZZZ.js");
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-type"]).not.toContain("text/html");
  expect(missing.headers()["cache-control"]).toBe("no-store");

  // a chunk of the build is still served as itself: the first script the shell asks for
  const shell = await (await request.get("/")).text();
  const [, script] = FIRST_SCRIPT.exec(shell) ?? [];
  expect(script, "the shell names its first script").toBeTruthy();
  const present = await request.get(script as string);
  expect(present.status()).toBe(200);
  expect(present.headers()["content-type"]).toContain("javascript");
  // passing through the Worker does not cost the file the headers of \`_headers\`
  expect(present.headers()["content-security-policy"]).toContain(
    "default-src 'self'"
  );
  expect(present.headers()["cross-origin-resource-policy"]).toBe("same-origin");
  expect(present.headers()["x-content-type-options"]).toBe("nosniff");
});
