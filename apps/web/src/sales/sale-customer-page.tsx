import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useMemo,
  useState,
} from "react";
import "../catalog/categories-page.css";
import { SaleCustomerPanel } from "./sale-customer-panel";
import { parseSaleId, readSaleIdParam } from "./sale-customer-link-model";
import { readOrganizationId, SalesTopbar } from "./sales-shell";

const invalidSaleIdMessage =
  "Informe um identificador de venda válido (um UUID, como 123e4567-e89b-42d3-a456-426614174000).";

/**
 * Reconciles the customer of an existing sale. There is no sales list yet, so
 * the sale is named by `?saleId=<uuid>` or by pasting its identifier.
 */
export function SaleCustomerPage() {
  const [organizationId] = useState(readOrganizationId);
  const initial = useMemo(() => readSaleIdParam(window.location.search), []);
  const [saleId, setSaleId] = useState<string | null>(
    initial.kind === "valid" ? initial.saleId : null
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(
    initial.kind === "invalid" ? invalidSaleIdMessage : null
  );
  const handleDraftChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = parseSaleId(draft);
      if (parsed === null) {
        setError(invalidSaleIdMessage);
        return;
      }
      setError(null);
      setSaleId(parsed);
      window.history.replaceState(null, "", `?saleId=${parsed}`);
    },
    [draft]
  );
  const handleChangeSale = useCallback(() => {
    setSaleId(null);
    setDraft("");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  return (
    <div className="categories-page sale-page">
      <SalesTopbar current="customer" />
      <main className="categories-content">
        <section className="categories-heading">
          <div>
            <p className="categories-eyebrow">Vendas</p>
            <h1>Cliente da venda</h1>
            <p className="categories-intro-copy">
              Associe, troque ou remova o cliente de uma venda já confirmada. A
              venda em si nunca é alterada.
            </p>
          </div>
        </section>
        {organizationId ? null : (
          <section className="sale-empty-page">
            <p>
              Abra ou crie uma organização para ajustar o cliente de vendas.
            </p>
            <a className="primary-button sale-link" href="/">
              Ir para a página inicial
            </a>
          </section>
        )}
        {organizationId && saleId === null ? (
          <form className="sale-section sale-sale-id" onSubmit={handleSubmit}>
            <div className="sale-field">
              <label htmlFor="sale-id-input">Identificador da venda</label>
              <input
                aria-describedby={error ? "sale-id-error" : undefined}
                aria-invalid={error ? true : undefined}
                autoComplete="off"
                id="sale-id-input"
                onChange={handleDraftChange}
                placeholder="Cole o identificador (UUID) da venda"
                value={draft}
              />
              {error ? (
                <p className="sale-error" id="sale-id-error" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <button className="primary-button" type="submit">
              Abrir venda
            </button>
          </form>
        ) : null}
        {organizationId && saleId !== null ? (
          <>
            <p className="sale-hint">
              Venda <code>{saleId}</code>{" "}
              <button
                className="sale-link-button"
                onClick={handleChangeSale}
                type="button"
              >
                Escolher outra venda
              </button>
            </p>
            <SaleCustomerPanel
              headingLevel={2}
              key={saleId}
              organizationId={organizationId}
              saleId={saleId}
            />
          </>
        ) : null}
      </main>
    </div>
  );
}
