import { lazyScreen } from "../app-shell/lazy-screen";
import { ScreenTabs, type TabPanel } from "../app-shell/screen-tabs";

/** Each tab is its own chunk, as each screen was. */
const PANELS: readonly TabPanel[] = [
  {
    Screen: lazyScreen(() =>
      import("./products-page").then((module) => ({
        default: module.ProductsPage,
      }))
    ),
    value: "produtos",
  },
  {
    Screen: lazyScreen(() =>
      import("./categories-page").then((module) => ({
        default: module.CategoriesPage,
      }))
    ),
    value: "categorias",
  },
];

/** Produtos, with the categories as its second tab (map of navigation, § 1; `/categories` opens that tab). */
export function CatalogProductsScreen() {
  return (
    <ScreenTabs
      label="Produtos e categorias"
      panels={PANELS}
      screen="products"
      title="Produtos"
    />
  );
}
