import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import {
  INVALID_SALE_ID_MESSAGE,
  parseSaleId,
} from "./sale-customer-link-model";

interface SaleIdFormProps {
  initialError: string | null;
  onOpen: (saleId: string) => void;
}

/** Asks for a sale identifier when the URL has none (there is no picker yet). */
export function SaleIdForm({ initialError, onOpen }: SaleIdFormProps) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value),
    []
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const parsed = parseSaleId(draft);
      if (parsed === null) {
        setError(INVALID_SALE_ID_MESSAGE);
        return;
      }
      setError(null);
      onOpen(parsed);
    },
    [draft, onOpen]
  );
  return (
    <form className="sale-section sale-sale-id" onSubmit={handleSubmit}>
      <div className="sale-field">
        <label htmlFor="sale-id-input">Identificador da venda</label>
        <input
          aria-describedby={error ? "sale-id-error" : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          id="sale-id-input"
          onChange={handleChange}
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
  );
}
