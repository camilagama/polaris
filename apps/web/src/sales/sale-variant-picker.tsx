import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { orpcClient } from "../lib/orpc";
import { useDebouncedValue } from "../lib/use-debounced-value";
import type { Loadable } from "./sale-form-model";
import {
  pickerErrorMessage,
  pickerView,
  variantSearchRequest,
} from "./sale-variant-picker-model";

const SEARCH_DELAY_MS = 250;

interface SearchResult {
  entries: readonly InventoryBalanceEntryReadModel[];
  more: boolean;
}

/**
 * One read per search, no matter how many products or variants exist: the
 * server returns variants with their balances, filtered by the typed text.
 */
type LocalSearch = (query: string) => Promise<SearchResult>;

function useVariantSearch(
  organizationId: string,
  text: string,
  localSearch: LocalSearch | undefined
) {
  const query = useDebouncedValue(text, SEARCH_DELAY_MS);
  const [load, setLoad] = useState<Loadable<SearchResult>>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    // Keep the previous matches visible while the next ones load.
    setLoad((previous) =>
      previous.status === "ready" ? previous : { status: "loading" }
    );
    const search: Promise<SearchResult> = localSearch
      ? localSearch(query)
      : orpcClient.inventory
          .listBalances(variantSearchRequest(organizationId, query))
          .then((page) => ({
            entries: page.entries,
            more: page.nextCursor !== null,
          }));
    search
      .then((value) => {
        if (current) {
          setLoad({ status: "ready", value });
        }
      })
      .catch((error: unknown) => {
        if (current) {
          setLoad({ message: pickerErrorMessage(error), status: "error" });
        }
      });
    return () => {
      current = false;
    };
  }, [attempt, localSearch, organizationId, query]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { load, query, retry };
}

interface VariantSearchProps {
  error: string | undefined;
  /** Prefix of the element ids of this line. */
  id: string;
  /** Searches this device's collections instead of the server (no connection). */
  localSearch?: LocalSearch | undefined;
  onPick: (entry: InventoryBalanceEntryReadModel) => void;
  organizationId: string;
}

/**
 * Search-and-choose list of sellable variants. Every result is a real button
 * (at least 44 px tall), so it works with keyboard, screen readers and touch.
 * Enter picks the first match instead of submitting the sale.
 */
export function VariantSearch({
  error,
  id,
  localSearch,
  onPick,
  organizationId,
}: VariantSearchProps) {
  const [text, setText] = useState("");
  const { load, retry } = useVariantSearch(organizationId, text, localSearch);
  const view = pickerView(
    load,
    // The list follows the debounced text; the live message follows the list.
    text
  );
  const options = view.kind === "ready" ? view.options : [];
  const inputRef = useRef<HTMLInputElement>(null);
  const searchId = `${id}-search`;
  const listId = `${id}-results`;
  const errorId = `${id}-error`;

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    []
  );
  const handlePick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { variantId } = event.currentTarget.dataset;
      const option = options.find((candidate) => candidate.id === variantId);
      if (option) {
        onPick(option.entry);
      }
    },
    [onPick, options]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }
      // Enter must never submit the whole sale from a search box.
      event.preventDefault();
      const [first] = options;
      if (first && text.trim() !== "") {
        onPick(first.entry);
      }
    },
    [onPick, options, text]
  );

  return (
    <div className="sale-field sale-picker">
      <label htmlFor={searchId}>Produto ou variante</label>
      <input
        aria-controls={listId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        id={searchId}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Buscar por nome, variante ou SKU"
        ref={inputRef}
        type="search"
        value={text}
      />
      <p aria-live="polite" className="visually-hidden" role="status">
        {view.kind === "ready" ? view.status : ""}
      </p>
      {error ? (
        <p className="sale-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {view.kind === "loading" ? (
        <p className="sale-status" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === "error" ? (
        <p className="sale-message is-error" role="alert">
          {view.message}{" "}
          <button className="sale-link-button" onClick={retry} type="button">
            Tentar novamente
          </button>
        </p>
      ) : null}
      {view.kind === "empty" ? (
        <p className="sale-empty">{view.message}</p>
      ) : null}
      {view.kind === "ready" ? (
        <>
          <ul
            aria-label="Variantes encontradas"
            className="sale-pick-list"
            id={listId}
          >
            {view.options.map((option) => (
              <li key={option.id}>
                <button
                  className="sale-pick-option"
                  data-variant-id={option.id}
                  onClick={handlePick}
                  type="button"
                >
                  <span className="sale-pick-label">{option.label}</span>
                  <span className={`sale-pick-detail is-${option.tone}`}>
                    {option.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {view.hint ? <p className="sale-hint">{view.hint}</p> : null}
        </>
      ) : null}
    </div>
  );
}
