import type { ConfirmedSaleView } from "./sale-form-model";

interface SaleSnapshotProps {
  sale: ConfirmedSaleView;
}

/** The confirmed sale exactly as stored: items, totals, payment and fees. */
export function SaleSnapshot({ sale }: SaleSnapshotProps) {
  return (
    <>
      <dl className="sale-details">
        {sale.saleDetails.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd>{detail.value}</dd>
          </div>
        ))}
      </dl>
      <h3>Itens</h3>
      <ul className="sale-lines">
        {sale.items.map((item) => (
          <li key={item.key}>
            <span className="sale-line-label">{item.label}</span>
            <span>{item.detail}</span>
            <small>{item.costText}</small>
          </li>
        ))}
      </ul>
      <dl className="sale-totals">
        {sale.totals.map((row) => (
          <div className={`is-${row.tone}`} key={row.key}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <h3>Pagamento</h3>
      <dl className="sale-details">
        {sale.paymentDetails.map((detail) => (
          <div key={detail.label}>
            <dt>{detail.label}</dt>
            <dd
              className={
                detail.tone === "plain"
                  ? undefined
                  : `sale-fee is-${detail.tone}`
              }
            >
              {detail.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="sale-hint">{sale.note}</p>
    </>
  );
}
