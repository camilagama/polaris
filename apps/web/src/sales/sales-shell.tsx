const organizationStorageKey = "polaris.organizationId";

/** The requested organization; the server still authorizes every call. */
export function readOrganizationId(): string | null {
  try {
    return window.localStorage.getItem(organizationStorageKey);
  } catch {
    return null;
  }
}

interface SalesTopbarProps {
  current: "customer" | "history" | "sale";
}

export function SalesTopbar({ current }: SalesTopbarProps) {
  return (
    <header className="categories-topbar">
      <a aria-label="Polaris início" className="categories-brand" href="/">
        <span aria-hidden="true" className="categories-brand-mark">
          P
        </span>
        <span>Polaris</span>
      </a>
      <nav aria-label="Navegação principal" className="catalog-switcher">
        <a href="/">Categorias</a>
        <a href="/products">Produtos</a>
        <a href="/customers">Clientes</a>
        <a href="/payment-profiles">Perfis de pagamento</a>
        <a aria-current={current === "sale" ? "page" : undefined} href="/sales">
          Nova venda
        </a>
        <a
          aria-current={current === "history" ? "page" : undefined}
          href="/sales/history"
        >
          Histórico
        </a>
        <a
          aria-current={current === "customer" ? "page" : undefined}
          href="/sales/customer"
        >
          Cliente da venda
        </a>
      </nav>
    </header>
  );
}
