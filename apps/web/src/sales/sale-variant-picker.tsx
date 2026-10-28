import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import SearchIcon from "lucide-react/dist/esm/icons/search";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Button } from "@/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { orpcClient } from "../lib/orpc";
import { useDebouncedValue } from "../lib/use-debounced-value";
import { NewProductLink } from "./sale-fields";
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
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={searchId}>Produto ou variante</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          aria-controls={listId}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          // the search is cheap to type again: it does not hold the swap of the build (pwa/swap-guard.ts)
          data-swap-ignore=""
          id={searchId}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Buscar por nome, variante ou SKU"
          ref={inputRef}
          type="search"
          value={text}
        />
      </InputGroup>
      <p aria-live="polite" className="sr-only" role="status">
        {view.kind === "ready" ? view.status : ""}
      </p>
      <FieldError id={errorId}>{error}</FieldError>
      {view.kind === "loading" ? (
        <p className="text-muted-foreground text-support" role="status">
          {view.message}
        </p>
      ) : null}
      {view.kind === "error" ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {view.message}
            <Button onClick={retry} size="sm" type="button" variant="link">
              Tentar novamente
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {view.kind === "empty" ? (
        <div className="grid justify-items-start gap-3">
          <p className="text-muted-foreground text-support">{view.message}</p>
          {view.href ? <NewProductLink href={view.href} /> : null}
        </div>
      ) : null}
      {view.kind === "ready" ? (
        <>
          <ul
            aria-label="Variantes encontradas"
            className="grid max-h-88 gap-1.5 overflow-y-auto"
            id={listId}
          >
            {view.options.map((option) => (
              <li key={option.id}>
                <button
                  className="focus-ring grid min-h-11 w-full gap-0.5 rounded-md border border-border bg-card px-3 py-2 text-left motion-full:transition-colors hover:border-input hover:bg-accent"
                  data-variant-id={option.id}
                  onClick={handlePick}
                  type="button"
                >
                  <span className="font-medium [overflow-wrap:anywhere]">
                    {option.label}
                  </span>
                  <span
                    className={cn(
                      "text-support",
                      option.tone === "warning"
                        ? "text-warning"
                        : "text-muted-foreground"
                    )}
                  >
                    {option.detail}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {view.hint ? <FieldDescription>{view.hint}</FieldDescription> : null}
        </>
      ) : null}
    </Field>
  );
}
