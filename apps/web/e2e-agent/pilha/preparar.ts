import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJourneyUser } from "../../e2e-real/fixtures";
import {
  createRunDatabase,
  dropRunDatabase,
} from "../../e2e-real/run-database";
import {
  ensureRunEnvironment,
  ownerDatabaseUrl,
  previewEnvironment,
} from "../../e2e-real/run-environment";
import { seedCashSale, seedProduct, seedStock } from "../../e2e-real/seed";

/**
 * A pilha do piloto do `e2e` (t440), sobre o harness do e2e-real: o mesmo banco por run, os mesmos logins por
 * binding e a mesma sessão do `testUtils`, feita aqui no Node com o segredo do run. Tudo que é segredo (o run, as
 * senhas dos logins e os cookies de sessão) fica em `E2E_AGENT_STATE`, fora do repositório, com modo 0600.
 *
 *   bun e2e-agent/pilha/preparar.ts banco            cria e migra o banco do run (uma vez)
 *   bun e2e-agent/pilha/preparar.ts ambiente <porta>  imprime o ambiente fechado do preview (para o serve.ts)
 *   bun e2e-agent/pilha/preparar.ts semear <loja>...  cria usuário, loja e dados de cada loja (preview no ar)
 *   bun e2e-agent/pilha/preparar.ts limpar            derruba o banco e os logins do run
 */

const stateDir = process.env.E2E_AGENT_STATE;
if (!stateDir) {
  throw new Error(
    "E2E_AGENT_STATE é obrigatório (diretório fora do repositório)."
  );
}
const storePattern = /^bb-[a-z0-9-]+$/;
const runFile = join(stateDir, "run.json");
const sessionsFile = join(stateDir, "sessoes.json");

function writePrivate(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function loadRun(): void {
  if (!existsSync(runFile)) {
    return;
  }
  const saved = JSON.parse(readFileSync(runFile, "utf8")) as Record<
    string,
    string
  >;
  for (const [name, value] of Object.entries(saved)) {
    process.env[name] = value;
  }
}

function saveRun(): void {
  const names = Object.keys(process.env).filter(
    (name) =>
      name === "E2E_RUN_ID" ||
      name === "E2E_RUN_SECRET" ||
      name.startsWith("E2E_LOGIN_PASSWORD_")
  );
  writePrivate(
    runFile,
    Object.fromEntries(names.map((name) => [name, process.env[name]]))
  );
}

/** Data de hoje em São Paulo (fuso das lojas do piloto), `YYYY-MM-DD`. */
function todayInSaoPaulo(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Sao_Paulo",
    year: "numeric",
  }).format(now);
}

/** O que cada loja tem antes da exploração: o catálogo de uma loja de roupas na primeira semana. */
async function seedStore(
  rpc: Awaited<ReturnType<typeof createJourneyUser>>["rpc"],
  organizationId: string,
  now: Date
): Promise<void> {
  const today = todayInSaoPaulo(now);
  const camiseta = await seedProduct(
    rpc,
    organizationId,
    "Camiseta básica",
    "49.90"
  );
  const bone = await seedProduct(
    rpc,
    organizationId,
    "Boné aba curva",
    "35.00"
  );
  const meia = await seedProduct(
    rpc,
    organizationId,
    "Meia cano alto",
    "12.50"
  );
  await seedStock(rpc, organizationId, camiseta.variantId, 20, "22.00", today);
  await seedStock(rpc, organizationId, bone.variantId, 5, "15.00", today);
  await seedStock(rpc, organizationId, meia.variantId, 30, "4.10", today);
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "49.90", quantity: 2, variantId: camiseta.variantId }],
    now.toISOString()
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  loadRun();
  const run = ensureRunEnvironment();
  saveRun();
  const owner = ownerDatabaseUrl();
  if (command === "banco") {
    await createRunDatabase(owner, run);
    return;
  }
  if (command === "limpar") {
    await dropRunDatabase(owner, run, false);
    return;
  }
  if (command === "ambiente") {
    const origin = `http://127.0.0.1:${rest[0] ?? "4321"}`;
    const environment = previewEnvironment(owner, run, origin, false);
    // só nomes e valores do ambiente fechado, um por linha, para `env -i` do script; vai para arquivo 0600
    const previewFile = join(stateDir as string, "preview.env");
    writeFileSync(
      previewFile,
      Object.entries(environment)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n"),
      { mode: 0o600 }
    );
    chmodSync(previewFile, 0o600);
    return;
  }
  if (command === "semear") {
    const origin = process.env.E2E_AGENT_ORIGIN ?? "http://127.0.0.1:4321";
    const sessions = existsSync(sessionsFile)
      ? (JSON.parse(readFileSync(sessionsFile, "utf8")) as Record<
          string,
          unknown
        >)
      : {};
    const now = new Date();
    for (const store of rest) {
      if (!storePattern.test(store)) {
        throw new Error(
          `Nome de loja recusado: ${store} (bb-<letras, dígitos e hífen>).`
        );
      }
      // já semeada; uma semeadura que falhou no meio só se refaz com `limpar` e `banco` (o usuário tem id fixo)
      if (sessions[store]) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: uma loja de cada vez, no limite de taxa do preview
      const user = await createJourneyUser(origin, `qa-${store}`);
      const created = await user.rpc.organization.createInitial({
        name: `Loja ${store}`,
        timezone: "America/Sao_Paulo",
      });
      if (!store.endsWith("-vazia")) {
        await seedStore(user.rpc, created.organization.id, now);
      }
      sessions[store] = {
        cookies: user.cookies,
        organizationId: created.organization.id,
      };
      writePrivate(sessionsFile, sessions);
    }
    return;
  }
  throw new Error(`Comando desconhecido: ${command}`);
}

await main();
process.exit(0);
