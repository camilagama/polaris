import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const ZONE = "America/Sao_Paulo";
/**
 * PostgreSQL flushes a backend's statistics when it goes idle, at the latest 10 s after the last flush
 * (PGSTAT_IDLE_INTERVAL): the Worker's connections stay open, so the measurement waits that long after the reads.
 */
const FLUSH_MS = 11_000;

type Stats = Map<string, { scans: number; writes: number }>;

/**
 * Journey of the Início (corte inicio.md AC-5, AC-23; desenho do Início v2, § 5.4) on the real stack: the sale of today is
 * in Hoje with its exact amount, and opening the page inserts, updates and deletes nothing in any table of the
 * database (pg_stat_user_tables before and after, with the reads of the page shown in the same statistics). The goal
 * whose period ended, the one write the page may cause, is proved by the `home-writes` gate on PostgreSQL 18.
 */
test("início: a venda de hoje aparece em Hoje e abrir a tela não grava nada no banco (AC-23)", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "inicio", {
    organization: { timezone: ZONE },
  });
  const { page } = journey;
  const organizationId = journey.organizationId as string;
  const { rpc } = journey.user;

  const stats = async (): Promise<Stats> =>
    new Map(
      (
        await sql.query<{ relname: string; scans: string; writes: string }>(
          `SELECT relname,
                  (n_tup_ins + n_tup_upd + n_tup_del)::text AS writes,
                  (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text AS scans
             FROM pg_stat_user_tables WHERE schemaname = 'public'`
        )
      ).rows.map((row) => [
        row.relname,
        { scans: Number(row.scans), writes: Number(row.writes) },
      ])
    );
  const of = (now: Stats, table: string) =>
    now.get(table) ?? { scans: 0, writes: 0 };

  // the browser's first `get-session` records the access of its address on the session row (auth.ts,
  // `recordSessionIpChange`): an access of the sign-in, not of the Início, so it is made before the measurement
  const session = await page.request.get("/api/auth/get-session");
  expect(session.ok()).toBe(true);

  const seededFrom = await stats();
  const candle = await seedProduct(
    rpc,
    organizationId,
    "Vela aromática",
    "45.00"
  );
  await seedStock(
    rpc,
    organizationId,
    candle.variantId,
    5,
    "12.00",
    localDate(runT0(), ZONE)
  );
  await seedCashSale(
    rpc,
    organizationId,
    [{ price: "45.00", quantity: 2, variantId: candle.variantId }],
    new Date(runT0()).toISOString()
  );
  // the seed's own writes have arrived in the statistics before the opening is measured
  await expect
    .poll(async () => of(await stats(), "sales").writes, { timeout: 20_000 })
    .toBeGreaterThan(of(seededFrom, "sales").writes);
  await page.waitForTimeout(FLUSH_MS);
  const before = await stats();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Início" })
  ).toBeVisible();
  const today = page.getByRole("region", { name: "Vendas hoje" });
  await expect(today).toContainText("R$ 90,00");
  await expect(today).toContainText("1 venda");
  await expect(
    page.getByRole("region", { name: "Meta" }).getByRole("link", {
      name: "Definir meta",
    })
  ).toBeVisible();
  // nothing to do: the block is not there
  await expect(
    page.getByRole("region", { name: "Precisa de ação" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Mais vendidos do mês" })
  ).toContainText("Vela aromática");

  // the reads of the page are in the statistics (sales, goals and variants were scanned), then the rest of the window
  await expect
    .poll(
      async () => {
        const now = await stats();
        return ["sales", "goals", "product_variants"].every(
          (table) => of(now, table).scans > of(before, table).scans
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);
  await page.waitForTimeout(FLUSH_MS);
  const after = await stats();
  const written = [...after].flatMap(([table, now]) => {
    const writes = now.writes - of(before, table).writes;
    return writes === 0 ? [] : [`${table} +${writes}`];
  });
  expect(written, "opening the Início writes nothing").toEqual([]);
});
