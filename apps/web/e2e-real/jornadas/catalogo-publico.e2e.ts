import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, openJourney, test } from "../fixtures";
import { seedProduct } from "../seed";

const ADDRESS_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_ADDRESS = 40;
const RUN_ID_PATTERN = /^[a-f0-9]{12}$/;
const LEADING_HYPHENS = /^-+/;
const WORD_START = /(^|-)([a-z])/g;
const PLAN_NOTICE = "Seu plano não inclui o catálogo público.";
const PLAN_NOTICE_TEXT = /^Seu plano não inclui o catálogo público\./;
const NOT_INCLUDED =
  "O catálogo público não está incluído no plano atual. Seus dados ficam guardados e voltam a valer quando o plano incluir.";
const RESERVED = "Este endereço é reservado. Escolha outro.";
const TOO_SHORT =
  "O endereço precisa ter de 3 a 40 caracteres: letras minúsculas, números e hífens, sem hífen no começo nem no fim.";
const TAKEN = "Este endereço já está em uso por outra loja. Escolha outro.";
const STALE =
  "O perfil mudou em outra solicitação. O que você digitou foi mantido; confira e salve de novo.";
const LIVE = "No ar: qualquer pessoa com o endereço vê os produtos escolhidos.";
const OFF = "Fora do ar: ninguém vê o catálogo.";
const WAITING_PLAN =
  "Ligado, mas fora do ar: o plano atual não inclui o catálogo público. Tudo fica guardado e volta ao ar quando o plano incluir.";
const SAVE_BUTTON = "Salvar perfil";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];
type Journey = Awaited<ReturnType<typeof openJourney>>;

/** The code and the `data.reason` of a refused call; fails if the call answers. */
async function refusal(
  call: Promise<unknown>
): Promise<{ code: string; reason: unknown }> {
  try {
    await call;
  } catch (error) {
    const { code, data } = error as {
      code?: unknown;
      data?: { reason?: unknown } | null;
    };
    return { code: String(code), reason: data?.reason };
  }
  throw new Error("The call was expected to be refused, and it answered.");
}

/**
 * The address is one namespace for every store of the run, 40 characters at most: the journey's own name and the run's
 * id, trimmed from the front when the two are longer than that.
 */
function addressOf(journey: Journey): string {
  const runId = process.env.E2E_RUN_ID ?? "";
  expect(runId, "E2E_RUN_ID of the run").toMatch(RUN_ID_PATTERN);
  const address = `${journey.name.slice("qa-".length)}-${runId}`
    .slice(-MAX_ADDRESS)
    .replace(LEADING_HYPHENS, "");
  expect(address, "the address of the journey is a valid one").toMatch(
    ADDRESS_PATTERN
  );
  return address;
}

/** A Brazilian mobile number (55, area code 11, 9 and 8 digits) that depends on the journey's name, so no two journeys type the same number. */
function whatsappOf(journey: Journey): string {
  const hex = createHash("sha256").update(journey.name).digest("hex");
  const tail = String(Number.parseInt(hex.slice(0, 8), 16) % 100_000_000);
  return `55119${tail.padStart(8, "0")}`;
}

/** The digits as a person types them: +55 11 9xxxx-xxxx. */
function typedWhatsapp(digits: string): string {
  return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
}

/** "minha-loja" as "Minha-Loja": the case of an address typed by a person. */
function mixedCase(address: string): string {
  return address.replace(
    WORD_START,
    (_all, hyphen, letter) => `${hyphen}${letter.toUpperCase()}`
  );
}

/** The stack has no provider: an active subscription is a billing row whose access ends in the future. */
async function makePro(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    `INSERT INTO organization_billing (organization_id, state, access_ends_at, cycle_months)
     VALUES ($1, 'active', now() + interval '365 days', 1)`,
    [organizationId]
  );
}

/** The end of the access in the past counts as Free before the record changes state (the plan is judged on the database clock). */
async function endAccess(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    "UPDATE organization_billing SET access_ends_at = now() - interval '1 day' WHERE organization_id = $1",
    [organizationId]
  );
}

async function renewAccess(sql: Sql, organizationId: string): Promise<void> {
  await sql.query(
    "UPDATE organization_billing SET access_ends_at = now() + interval '365 days' WHERE organization_id = $1",
    [organizationId]
  );
}

interface StoredProfile {
  description: string | null;
  instagram: string | null;
  public_name: string;
  published: boolean;
  slug: string;
  version: number;
  whatsapp: string | null;
}

async function storedProfiles(
  sql: Sql,
  organizationId: string
): Promise<StoredProfile[]> {
  return (
    await sql.query<StoredProfile>(
      `SELECT public_name, slug, description, whatsapp, instagram, published, version
         FROM public_catalog_profiles WHERE organization_id = $1`,
      [organizationId]
    )
  ).rows;
}

/** Every column of the profile and of the choice of products, as the database holds them (the downgrade must not change one). */
async function storedCatalog(sql: Sql, organizationId: string) {
  const profile = (
    await sql.query<{ row: unknown }>(
      "SELECT to_jsonb(p) AS row FROM public_catalog_profiles p WHERE organization_id = $1",
      [organizationId]
    )
  ).rows.map(({ row }) => row);
  const choice = (
    await sql.query<{ row: unknown }>(
      "SELECT to_jsonb(p) AS row FROM product_publications p WHERE organization_id = $1 ORDER BY product_id",
      [organizationId]
    )
  ).rows.map(({ row }) => row);
  return { choice, profile };
}

/** The products the store shows now (chosen and not taken out), by product id. */
async function shownProducts(
  sql: Sql,
  organizationId: string
): Promise<string[]> {
  return (
    await sql.query<{ product_id: string }>(
      `SELECT product_id FROM product_publications
        WHERE organization_id = $1 AND unpublished_at IS NULL ORDER BY product_id`,
      [organizationId]
    )
  ).rows.map(({ product_id }) => product_id);
}

async function profileCount(sql: Sql, organizationId: string): Promise<number> {
  return Number(
    (
      await sql.query<{ total: string }>(
        "SELECT count(*) AS total FROM public_catalog_profiles WHERE organization_id = $1",
        [organizationId]
      )
    ).rows[0]?.total
  );
}

async function openCatalog(page: Page) {
  await page.goto("/public-catalog");
  await expect(
    page.getByRole("tab", { name: "Catálogo público", selected: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByRole("tabpanel", { name: "Catálogo público" })
      .getByRole("button", { name: SAVE_BUTTON })
  ).toBeVisible({ timeout: 30_000 });
}

interface ProfileText {
  description?: string;
  instagram?: string;
  name: string;
  slug: string;
  whatsapp?: string;
}

async function fillProfile(page: Page, text: ProfileText) {
  await page.getByLabel("Nome público", { exact: true }).fill(text.name);
  await page.getByLabel("Endereço", { exact: true }).fill(text.slug);
  if (text.description !== undefined) {
    await page.getByLabel("Descrição").fill(text.description);
  }
  if (text.whatsapp !== undefined) {
    await page.getByLabel("WhatsApp").fill(text.whatsapp);
  }
  if (text.instagram !== undefined) {
    await page.getByLabel("Instagram").fill(text.instagram);
  }
}

const productRow = (page: Page, name: string) =>
  page
    .getByRole("list", { name: "Produtos do catálogo" })
    .getByRole("listitem")
    .filter({ hasText: name });

/** The setup the Worker reads for the screen: the plan in force and what is kept, whatever the screen draws. */
function setupOf(journey: Journey) {
  return journey.user.rpc.publicCatalog.setup({
    organizationId: journey.organizationId as string,
  });
}

/**
 * AC-2.1: a Free store does not set the public catalog up. The screen says so before anything is sent (the plan notice,
 * the save button off and described by it, the choice of products off), and the Worker refuses the call itself with
 * `entitlement_denied`; no profile row and no choice of product is written.
 */
test("catálogo público: loja Free não configura, a tela avisa, o servidor recusa e nada é gravado", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const journey = await openJourney(browser, testInfo, "catalogo-free");
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const hat = await seedProduct(
    user.rpc,
    organizationId,
    `Chapéu ${journey.name}`
  );
  const sent: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/rpc/publicCatalog/")) {
      sent.push(new URL(request.url()).pathname);
    }
  });

  await openCatalog(page);
  await expect(page.getByText(PLAN_NOTICE)).toBeVisible();
  await expect(page.getByText(OFF, { exact: true })).toBeVisible();
  await fillProfile(page, {
    name: `Loja ${journey.name}`,
    slug: addressOf(journey),
  });
  const save = page.getByRole("button", { name: SAVE_BUTTON });
  await expect(save).toHaveAttribute("aria-disabled", "true");
  await expect(save).toHaveAccessibleDescription(PLAN_NOTICE_TEXT);
  await save.click({ force: true });
  await expect(
    productRow(page, `Chapéu ${journey.name}`).getByRole("button", {
      name: "Mostrar no catálogo",
    })
  ).toBeDisabled();

  // the Worker does not trust the screen: the same save and the same choice by the command are refused
  const refused = { code: "CONFLICT", reason: "entitlement_denied" };
  expect(
    await refusal(
      user.rpc.publicCatalog.saveProfile({
        organizationId,
        publicName: `Loja ${journey.name}`,
        slug: addressOf(journey),
      })
    )
  ).toEqual(refused);
  expect(
    await refusal(
      user.rpc.publicCatalog.publishProducts({
        organizationId,
        productIds: [hat.productId],
      })
    )
  ).toEqual(refused);
  expect(await setupOf(journey)).toMatchObject({
    enabled: false,
    profile: null,
    publishedProductIds: [],
  });
  // nothing left the screen to the commands (the setup read is the only one), and nothing is in the database
  expect(sent, "the listener saw the read of the screen").toContain(
    "/rpc/publicCatalog/setup"
  );
  expect(sent.filter((path) => !path.endsWith("/setup"))).toEqual([]);
  expect(await profileCount(sql, organizationId)).toBe(0);
  expect(await shownProducts(sql, organizationId)).toEqual([]);
  expect(
    (
      await sql.query(
        "SELECT 1 FROM product_publications WHERE organization_id = $1",
        [organizationId]
      )
    ).rowCount
  ).toBe(0);
  await expect(page.getByText(NOT_INCLUDED)).toHaveCount(0);
});

/**
 * AC-2.2, AC-2.3, AC-2.7: a Pro store saves its profile on screen (the address in lowercase, the WhatsApp in digits, the
 * Instagram without the @, version 1); the address is reserved, long enough and unique among all stores (another store
 * holds it: the store that tried gets no row); and an edit made elsewhere in the meantime is a conflict that keeps what
 * was typed and the database as the other edit left it.
 */
test("catálogo público: o perfil do Pro, o endereço único e reservado e a edição sobre versão antiga", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(240_000);
  const journey = await openJourney(browser, testInfo, "catalogo-perfil");
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  await makePro(sql, organizationId);
  const address = addressOf(journey);
  const name = `Loja ${journey.name}`;
  const whatsapp = whatsappOf(journey);
  const instagram = journey.name.replaceAll("-", "_").slice(-30);

  // another store of the run holds an address; the command lowers the case of what it is given
  const other = await openJourney(browser, testInfo, "catalogo-outra");
  const otherId = other.organizationId as string;
  await makePro(sql, otherId);
  const taken = addressOf(other);
  expect(mixedCase(taken), "the typed address differs in case").not.toBe(taken);
  await other.user.rpc.publicCatalog.saveProfile({
    organizationId: otherId,
    publicName: `Loja ${other.name}`,
    slug: mixedCase(taken),
  });
  expect((await storedProfiles(sql, otherId)).map(({ slug }) => slug)).toEqual([
    taken,
  ]);

  await openCatalog(page);
  await expect(page.getByText(PLAN_NOTICE)).toHaveCount(0);
  await expect(page.getByText(OFF, { exact: true })).toBeVisible();

  // AC-2.3: the address of another store, typed in another case, is refused under its field and nothing is written
  await fillProfile(page, { name, slug: mixedCase(taken) });
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText(TAKEN)).toBeVisible();
  expect(await profileCount(sql, organizationId)).toBe(0);
  await expect(page.getByLabel("Endereço", { exact: true })).toBeFocused();
  expect(
    (
      await sql.query("SELECT 1 FROM public_catalog_profiles WHERE slug = $1", [
        taken,
      ])
    ).rowCount
  ).toBe(1);

  // AC-2.3: a reserved name and one too short
  await page.getByLabel("Endereço", { exact: true }).fill("admin");
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText(RESERVED)).toBeVisible();
  await page.getByLabel("Endereço", { exact: true }).fill("ab");
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText(TOO_SHORT)).toBeVisible();
  expect(await profileCount(sql, organizationId)).toBe(0);
  // the Worker says the same for the command, whatever the screen checked before
  expect(
    await refusal(
      user.rpc.publicCatalog.saveProfile({
        organizationId,
        publicName: name,
        slug: "admin",
      })
    )
  ).toEqual({ code: "BAD_REQUEST", reason: "reserved_slug" });
  expect(
    await refusal(
      user.rpc.publicCatalog.saveProfile({
        organizationId,
        publicName: name,
        slug: "ab",
      })
    )
  ).toEqual({ code: "BAD_REQUEST", reason: "invalid_slug" });
  expect(
    await refusal(
      user.rpc.publicCatalog.saveProfile({
        organizationId,
        publicName: name,
        slug: taken,
      })
    )
  ).toEqual({ code: "CONFLICT", reason: "public_catalog_slug_taken" });
  expect(await profileCount(sql, organizationId)).toBe(0);

  // AC-2.2: the profile as typed, saved once
  await fillProfile(page, {
    description: "Peças escolhidas a dedo.",
    instagram: `@${instagram}`,
    name,
    slug: mixedCase(address),
    whatsapp: typedWhatsapp(whatsapp),
  });
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText("Perfil salvo.")).toBeVisible();
  await expect
    .poll(async () => storedProfiles(sql, organizationId))
    .toEqual([
      {
        description: "Peças escolhidas a dedo.",
        instagram,
        public_name: name,
        published: false,
        slug: address,
        version: 1,
        whatsapp,
      },
    ]);
  await expect(page.getByLabel("Endereço", { exact: true })).toHaveValue(
    address
  );
  expect((await storedProfiles(sql, otherId)).map(({ slug }) => slug)).toEqual([
    taken,
  ]);

  // AC-2.7: an edit made by the command while the page is open (version 2); the page still holds version 1
  const edited = await user.rpc.publicCatalog.saveProfile({
    description: "Edição feita em outra solicitação.",
    expectedVersion: 1,
    instagram: null,
    organizationId,
    publicName: name,
    slug: address,
    whatsapp,
  });
  expect(edited.version).toBe(2);
  const typed = `${name} (nome digitado)`;
  await page.getByLabel("Nome público", { exact: true }).fill(typed);
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText(STALE)).toBeVisible();
  await expect(page.getByLabel("Nome público", { exact: true })).toHaveValue(
    typed
  );
  expect(await storedProfiles(sql, organizationId)).toEqual([
    {
      description: "Edição feita em outra solicitação.",
      instagram: null,
      public_name: name,
      published: false,
      slug: address,
      version: 2,
      whatsapp,
    },
  ]);
});

/**
 * AC-2.4, AC-2.5, AC-2.6: the switch needs a saved profile and says what the visitor gets; two of three products are
 * chosen and only they are in the database; an archived product cannot be chosen; and when the plan ends the screen says
 * "ligado, mas fora do ar" while every column of the profile and of the choice stays as it was, and all of it is back with
 * the plan.
 */
test("catálogo público: o interruptor, a escolha dos produtos e o downgrade que não apaga nada", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(300_000);
  const journey = await openJourney(browser, testInfo, "catalogo-produtos");
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  await makePro(sql, organizationId);
  const names = {
    bag: `Bolsa ${journey.name}`,
    mug: `Caneca ${journey.name}`,
    shirt: `Camiseta ${journey.name}`,
  };
  const shirt = await seedProduct(user.rpc, organizationId, names.shirt);
  const mug = await seedProduct(user.rpc, organizationId, names.mug);
  await seedProduct(user.rpc, organizationId, names.bag);
  const old = await user.rpc.product.create({
    name: `Antiga ${journey.name}`,
    organizationId,
  });
  await user.rpc.product.archive({
    expectedVersion: old.version,
    id: old.id,
    organizationId,
  });

  // AC-2.4: without a profile there is no switch to press; the command says why it refuses
  await openCatalog(page);
  await expect(
    page.getByText("Salve o perfil para poder ligar o catálogo.")
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ligar catálogo" })
  ).toHaveCount(0);
  expect(
    await refusal(
      user.rpc.publicCatalog.setPublished({
        expectedVersion: 1,
        organizationId,
        published: true,
      })
    )
  ).toEqual({ code: "CONFLICT", reason: "public_catalog_profile_missing" });
  expect(await profileCount(sql, organizationId)).toBe(0);

  await fillProfile(page, {
    name: `Loja ${journey.name}`,
    slug: addressOf(journey),
  });
  await page.getByRole("button", { name: SAVE_BUTTON }).click();
  await expect(page.getByText("Perfil salvo.")).toBeVisible();
  await page.getByRole("button", { name: "Ligar catálogo" }).click();
  await expect(page.getByText("Catálogo ligado.")).toBeVisible();
  await expect(page.getByText(LIVE, { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await storedProfiles(sql, organizationId))[0])
    .toMatchObject({ published: true, version: 2 });
  await page.getByRole("button", { name: "Desligar catálogo" }).click();
  await expect(page.getByText("Catálogo desligado.")).toBeVisible();
  await expect(page.getByText(OFF, { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await storedProfiles(sql, organizationId))[0])
    .toMatchObject({ published: false, version: 3 });

  // AC-2.5: two of the three active products; the archived one is not even on the screen
  await expect(
    page
      .getByRole("list", { name: "Produtos do catálogo" })
      .getByRole("listitem")
  ).toHaveCount(3);
  await expect(productRow(page, "Antiga")).toHaveCount(0);
  await productRow(page, names.shirt)
    .getByRole("button", { name: "Mostrar no catálogo" })
    .click();
  await expect(page.getByText("Produtos no catálogo.")).toBeVisible();
  await expect(
    page.getByText("1 de 3 produtos ativos escolhidos.")
  ).toBeVisible();
  await productRow(page, names.mug)
    .getByRole("button", { name: "Mostrar no catálogo" })
    .click();
  await expect(productRow(page, names.mug)).toContainText("No catálogo");
  await expect(
    page.getByText("2 de 3 produtos ativos escolhidos.")
  ).toBeVisible();
  await expect
    .poll(async () => shownProducts(sql, organizationId))
    .toEqual([shirt.productId, mug.productId].sort());
  await expect(productRow(page, names.bag)).not.toContainText("No catálogo");
  await productRow(page, names.mug)
    .getByRole("button", { name: "Tirar do catálogo" })
    .click();
  await expect(page.getByText("Produtos fora do catálogo.")).toBeVisible();
  await expect
    .poll(async () => shownProducts(sql, organizationId))
    .toEqual([shirt.productId]);
  await productRow(page, names.mug)
    .getByRole("button", { name: "Mostrar no catálogo" })
    .click();
  await expect
    .poll(async () => shownProducts(sql, organizationId))
    .toEqual([shirt.productId, mug.productId].sort());

  // an archived product is refused by the command and nothing is written for it
  const before = await storedCatalog(sql, organizationId);
  expect(
    await refusal(
      user.rpc.publicCatalog.publishProducts({
        organizationId,
        productIds: [old.id],
      })
    )
  ).toEqual({ code: "CONFLICT", reason: "public_catalog_product_unavailable" });
  expect(await storedCatalog(sql, organizationId)).toEqual(before);

  // AC-2.6: the switch on, then the plan ends: kept as it was, "ligado, mas fora do ar"
  await page.getByRole("button", { name: "Ligar catálogo" }).click();
  await expect(page.getByText(LIVE, { exact: true })).toBeVisible();
  const kept = await storedCatalog(sql, organizationId);
  expect(kept.profile).toHaveLength(1);
  expect(kept.choice).toHaveLength(2);
  await endAccess(sql, organizationId);
  await openCatalog(page);
  await expect(page.getByText(PLAN_NOTICE)).toBeVisible();
  await expect(page.getByText(WAITING_PLAN, { exact: true })).toBeVisible();
  await expect(productRow(page, names.shirt)).toContainText("No catálogo");
  await expect(productRow(page, names.mug)).toContainText("No catálogo");
  expect(await setupOf(journey)).toMatchObject({
    enabled: false,
    profile: { published: true },
    publishedProductIds: [shirt.productId, mug.productId].sort(),
  });
  expect(await storedCatalog(sql, organizationId)).toEqual(kept);
  const belt = await seedProduct(
    user.rpc,
    organizationId,
    `Cinto ${journey.name}`
  );
  expect(
    await refusal(
      user.rpc.publicCatalog.publishProducts({
        organizationId,
        productIds: [belt.productId],
      })
    )
  ).toEqual({ code: "CONFLICT", reason: "entitlement_denied" });
  expect(await storedCatalog(sql, organizationId)).toEqual(kept);

  // back to the plan: the same profile, the same switch, the same two products, "no ar"
  await renewAccess(sql, organizationId);
  await openCatalog(page);
  await expect(page.getByText(LIVE, { exact: true })).toBeVisible();
  await expect(page.getByText(PLAN_NOTICE)).toHaveCount(0);
  await expect(productRow(page, names.shirt)).toContainText("No catálogo");
  await expect(productRow(page, names.mug)).toContainText("No catálogo");
  expect(await storedCatalog(sql, organizationId)).toEqual(kept);

  // turning off and taking a product out never need the plan
  await endAccess(sql, organizationId);
  await openCatalog(page);
  await productRow(page, names.mug)
    .getByRole("button", { name: "Tirar do catálogo" })
    .click();
  await expect(page.getByText("Produtos fora do catálogo.")).toBeVisible();
  await page.getByRole("button", { name: "Desligar catálogo" }).click();
  await expect(page.getByText("Catálogo desligado.")).toBeVisible();
  await expect(page.getByText(OFF, { exact: true })).toBeVisible();
  await expect
    .poll(async () => shownProducts(sql, organizationId))
    .toEqual([shirt.productId]);
  await expect
    .poll(async () => (await storedProfiles(sql, organizationId))[0]?.published)
    .toBe(false);
});
