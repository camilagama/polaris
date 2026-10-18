import type {
  ProductReadModel,
  PublicCatalogProfileReadModel,
} from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blankProfileDraft } from "./public-catalog-model";
import { ProductsCard, ProfileForm, SwitchCard } from "./public-catalog-panels";

const none = () => undefined;
const DISABLED_TURN_ON = /disabled=""[^>]*>Ligar catálogo/;
const DISABLED_SAVE = /disabled=""[^>]*>Salvar perfil/;
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
    expect(html).toMatch(DISABLED_TURN_ON);
  });
});

describe("the product list", () => {
  const products = [product("a", "Vestido"), product("b", "Blusa")];
  const render = (
    overrides: Partial<Parameters<typeof ProductsCard>[0]> = {}
  ) =>
    renderToStaticMarkup(
      <ProductsCard
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
        onChange={none}
        onSlugEdited={none}
        onSubmit={none}
        pending={false}
        publicOrigin="https://catalogo.example"
        slugEdited
      />
    );
    expect(html).toContain("https://catalogo.example/loja-da-ana");
    expect(html).toMatch(DISABLED_SAVE);
    expect(html).toContain("280 caracteres");
  });
});
