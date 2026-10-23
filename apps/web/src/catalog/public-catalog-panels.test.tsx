import type {
  ProductReadModel,
  PublicCatalogProfileReadModel,
} from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blankProfileDraft } from "./public-catalog-model";
import { ProductsCard, ProfileForm, SwitchCard } from "./public-catalog-panels";

const none = () => undefined;
const SAVED_IN_STATUS = /<div role="status"><p[^>]*>.*Perfil salvo\./;
const REFUSED_IN_ALERT = /<div role="alert"><p[^>]*>.*O perfil não foi salvo\./;
const noFeedback = { error: null, notice: null };
// a button that is off for a reason on the screen: aria-disabled and the id of the reason, never `disabled`
const OFF_TURN_ON = /<button[^>]*aria-disabled="true"[^>]*>Ligar catálogo/;
const OFF_SAVE = /<button[^>]*aria-disabled="true"[^>]*>Salvar perfil/;
const DESCRIBED_BY_PLAN =
  /<button[^>]*aria-describedby="public-catalog-plan-notice"[^>]*>Ligar catálogo/;
const DESCRIBED_BY_SAVE_REASON =
  /<button[^>]*aria-describedby="public-profile-save-reason"[^>]*>Salvar perfil/;

/** The tag of the input (or textarea) with this id, as drawn. */
function controlTag(markup: string, id: string): string {
  const tag = new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`).exec(
    markup
  );
  if (!tag) {
    throw new Error(`no control ${id}`);
  }
  return tag[0];
}
const profile: PublicCatalogProfileReadModel = {
  description: null,
  instagram: null,
  publicName: "Loja da Ana",
  published: true,
  slug: "loja-da-ana",
  version: 2,
  whatsapp: null,
};
const product = (id: string, name: string): ProductReadModel => ({
  archivedAt: null,
  categoryId: null,
  createdAt: "2026-10-16T12:00:00.000Z",
  deletedAt: null,
  description: null,
  id,
  name,
  organizationId: "org",
  status: "active",
  updatedAt: "2026-10-16T12:00:00.000Z",
  version: 1,
});

describe("the catalog switch", () => {
  const render = (overrides: Partial<Parameters<typeof SwitchCard>[0]> = {}) =>
    renderToStaticMarkup(
      <SwitchCard
        changed={false}
        feedback={noFeedback}
        onToggle={none}
        pending={false}
        planBlocks={false}
        profile={profile}
        publicOrigin="https://catalogo.example"
        visibility="live"
        {...overrides}
      />
    );

  it("links to the public address only while the catalog is live", () => {
    expect(render()).toContain('href="https://catalogo.example/loja-da-ana"');
    expect(render()).toContain("Desligar catálogo");
    expect(render({ visibility: "off" })).not.toContain(
      "https://catalogo.example"
    );
  });

  it("explains a catalog that is on but outside the plan, and still lets it be turned off", () => {
    const html = render({ planBlocks: true, visibility: "waiting-plan" });
    expect(html).toContain("o plano atual não inclui");
    expect(html).toContain("Desligar catálogo");
  });

  it("asks for the profile first, and for it to be saved before switching", () => {
    expect(render({ profile: null, visibility: "off" })).toContain(
      "Salve o perfil para poder ligar"
    );
    expect(render({ changed: true })).toContain("Salve o perfil antes");
  });

  it("does not let a catalog that is off be turned on while the plan blocks it", () => {
    const html = render({
      planBlocks: true,
      profile: { ...profile, published: false },
      visibility: "off",
    });
    expect(html).toMatch(OFF_TURN_ON);
    expect(html).toMatch(DESCRIBED_BY_PLAN);
    expect(html).not.toContain('disabled=""');
  });
});

describe("the product list", () => {
  const products = [product("a", "Vestido"), product("b", "Blusa")];
  const render = (
    overrides: Partial<Parameters<typeof ProductsCard>[0]> = {}
  ) =>
    renderToStaticMarkup(
      <ProductsCard
        feedback={noFeedback}
        onChange={none}
        pending={false}
        planBlocks={false}
        products={products}
        shown={new Set(["a"])}
        {...overrides}
      />
    );

  it("counts what is shown and offers each product the opposite action", () => {
    const html = render();
    expect(html).toContain("1 de 2 produtos ativos escolhidos");
    expect(html).toContain("Tirar do catálogo");
    expect(html).toContain("Mostrar no catálogo");
  });

  it("says so when there are no products", () => {
    expect(render({ products: [], shown: new Set() })).toContain(
      "ainda não tem produtos ativos"
    );
  });
});

describe("the profile form", () => {
  it("previews the address under the origin and keeps saving off until something changes", () => {
    const html = renderToStaticMarkup(
      <ProfileForm
        changed={false}
        disabled={false}
        draft={{ ...blankProfileDraft, slug: "loja-da-ana" }}
        feedback={noFeedback}
        onChange={none}
        onSlugEdited={none}
        onSubmit={none}
        pending={false}
        problem={null}
        publicOrigin="https://catalogo.example"
        slugEdited
      />
    );
    expect(html).toContain("https://catalogo.example/loja-da-ana");
    expect(html).toMatch(OFF_SAVE);
    expect(html).toMatch(DESCRIBED_BY_SAVE_REASON);
    expect(html).toContain("Altere algum campo para salvar.");
    expect(html).toContain("280 caracteres");
  });

  const renderForm = (
    overrides: Partial<Parameters<typeof ProfileForm>[0]> = {}
  ) =>
    renderToStaticMarkup(
      <ProfileForm
        changed
        disabled={false}
        draft={{ ...blankProfileDraft, publicName: "Loja", slug: "a" }}
        feedback={noFeedback}
        onChange={none}
        onSlugEdited={none}
        onSubmit={none}
        pending={false}
        problem={null}
        publicOrigin="https://catalogo.example"
        slugEdited
        {...overrides}
      />
    );

  it("puts the error of the address under the address and ties it to the field (U-48)", () => {
    const html = renderForm({
      problem: { field: "slug", message: "Endereço inválido." },
    });
    expect(html).toContain('id="public-slug-error"');
    expect(html).toContain("Endereço inválido.");
    const slug = controlTag(html, "public-slug");
    expect(slug).toContain('aria-invalid="true"');
    expect(slug).toContain("public-slug-error");
    // the name is not marked
    expect(controlTag(html, "public-name")).not.toContain("aria-invalid");
  });

  it("shows the message of the save under the save button, in live regions that are always there (U-49)", () => {
    const quiet = renderForm();
    expect(quiet).toContain('<div role="status"></div>');
    expect(quiet).toContain('<div role="alert"></div>');
    const saved = renderForm({
      feedback: { error: null, notice: "Perfil salvo." },
    });
    expect(saved.indexOf("Salvar perfil")).toBeLessThan(
      saved.indexOf("Perfil salvo.")
    );
    expect(saved).toMatch(SAVED_IN_STATUS);
    const refused = renderForm({
      feedback: { error: "O perfil não foi salvo.", notice: null },
    });
    expect(refused).toMatch(REFUSED_IN_ALERT);
  });
});

describe("the messages of the switch and of the products", () => {
  it("sit next to their own button, not at the top of the page (U-49)", () => {
    const html = renderToStaticMarkup(
      <SwitchCard
        changed={false}
        feedback={{ error: null, notice: "Catálogo ligado." }}
        onToggle={none}
        pending={false}
        planBlocks={false}
        profile={profile}
        publicOrigin="https://catalogo.example"
        visibility="live"
      />
    );
    expect(html.indexOf("Desligar catálogo")).toBeLessThan(
      html.indexOf("Catálogo ligado.")
    );
  });
});
