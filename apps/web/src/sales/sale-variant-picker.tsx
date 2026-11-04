import type { InventoryBalanceEntryReadModel } from "@polaris/contracts";
import SearchIcon from "lucide-react/dist/esm/icons/search";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/ui/combobox";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { InputGroup, InputGroupAddon } from "@/ui/input-group";
import { orpcClient } from "../lib/orpc";
import { useDebouncedValue } from "../lib/use-debounced-value";
import { NewProductLink } from "./sale-fields";
import type { Loadable } from "./sale-form-model";
import {
  type PickerOption,
  pickerErrorMessage,
  pickerView,
  storeHasNothingToSell,
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

/** What a suggestion says: the full name, then the balance and the SKU (the warning tone when there is no balance). */
export function VariantOptionText({ option }: { option: PickerOption }) {
  return (
    <>
      <span className="font-medium [overflow-wrap:anywhere]">
        {option.label}
      </span>
      <span
        className={cn(
          "text-support",
          option.tone === "warning" ? "text-warning" : "text-muted-foreground"
        )}
      >
        {option.detail}
      </span>
    </>
  );
}

interface VariantSearchProps {
  /** Focus the field when it appears: the person asked to change the variant. */
  autoFocus?: boolean | undefined;
  error: string | undefined;
  /** Prefix of the element ids of this line. */
  id: string;
  /** Searches this device's collections instead of the server (no connection). */
  localSearch?: LocalSearch | undefined;
  /** Leaving the search without a choice (Escape, a touch outside, the focus going away) while changing a variant. */
  onCancel?: (() => void) | undefined;
  onPick: (entry: InventoryBalanceEntryReadModel) => void;
  organizationId: string;
  /** The variant already on the line: marked (`aria-selected`, check) in the suggestions. */
  selectedVariantId?: string | undefined;
}

const DISMISS_REASONS = new Set(["escape-key", "focus-out", "outside-press"]);
// only what the person types: Base UI also writes the field when it closes (the label of the value, or empty)
const TYPING_REASONS = new Set(["input-change"]);
const optionLabel = (option: PickerOption) => option.label;
const sameOption = (left: PickerOption, right: PickerOption) =>
  left.id === right.id;

/**
 * Search-and-choose of sellable variants. The suggestions open in a popup anchored to the field (Base UI Combobox),
 * only when the person goes to the field (a touch or click on it, typing, ArrowDown), never by themselves when the
 * screen opens, and they float over the form: nothing under the field moves when they arrive. The arrows move through
 * them, Enter chooses the highlighted one (the first, while typing) and never submits the sale, Escape closes them.
 */
export function VariantSearch({
  autoFocus,
  error,
  id,
  localSearch,
  onCancel,
  onPick,
  organizationId,
  selectedVariantId,
}: VariantSearchProps) {
  const [text, setText] = useState("");
  // Base UI opens it on a touch or click on the field, on typing and on ArrowDown; never by itself
  const [requested, setRequested] = useState(Boolean(autoFocus));
  const { load, retry } = useVariantSearch(organizationId, text, localSearch);
  const view = pickerView(
    load,
    // The list follows the debounced text; the live message follows the list.
    text
  );
  const options = view.kind === "ready" ? view.options : [];
  const selected =
    options.find((option) => option.id === selectedVariantId) ?? null;
  const nothingToSell = storeHasNothingToSell(view);
  const open = requested && !nothingToSell;
  const groupRef = useRef<HTMLDivElement>(null);
  const searchId = `${id}-search`;
  const errorId = `${id}-error`;

  const handleInputValue = useCallback(
    (value: string, details: { reason: string }) => {
      if (TYPING_REASONS.has(details.reason)) {
        setText(value);
      }
    },
    []
  );
  const handleValue = useCallback(
    (option: PickerOption | null) => {
      if (option) {
        onPick(option.entry);
      }
    },
    [onPick]
  );
  const handleOpenChange = useCallback(
    (next: boolean, details: { reason: string }) => {
      setRequested(next);
      if (!next && onCancel && DISMISS_REASONS.has(details.reason)) {
        onCancel();
      }
    },
    [onCancel]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        // Enter must never submit the whole sale from a search box; with an option highlighted, Base UI chooses it.
        event.preventDefault();
      }
      if (event.key === "Escape" && !open && onCancel) {
        onCancel();
      }
    },
    [onCancel, open]
  );

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={searchId}>Produto ou variante</FieldLabel>
      <Combobox
        autoHighlight
        filter={null}
        inputValue={text}
        isItemEqualToValue={sameOption}
        items={options}
        itemToStringLabel={optionLabel}
        onInputValueChange={handleInputValue}
        onOpenChange={handleOpenChange}
        onValueChange={handleValue}
        open={open}
        value={selected}
      >
        <InputGroup ref={groupRef}>
          <InputGroupAddon>
            <SearchIcon aria-hidden="true" />
          </InputGroupAddon>
          <ComboboxInput
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            // only after "Trocar", which the person just pressed on this line
            autoFocus={autoFocus}
            // the search is cheap to type again: it does not hold the swap of the build (pwa/swap-guard.ts)
            data-swap-ignore=""
            id={searchId}
            onKeyDown={handleKeyDown}
            placeholder="Buscar por nome, variante ou SKU"
            type="search"
          />
        </InputGroup>
        <ComboboxContent
          anchor={groupRef}
          aria-busy={view.kind === "loading" || undefined}
        >
          <ComboboxEmpty>
            {view.kind === "loading" ? view.message : null}
            {view.kind === "empty" ? view.message : null}
            {view.kind === "error" ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-destructive">
                {view.message}
                <Button onClick={retry} size="sm" type="button" variant="link">
                  Tentar novamente
                </Button>
              </span>
            ) : null}
          </ComboboxEmpty>
          <ComboboxList aria-label="Variantes encontradas">
            {(option: PickerOption) => (
              <ComboboxItem key={option.id} value={option}>
                <VariantOptionText option={option} />
              </ComboboxItem>
            )}
          </ComboboxList>
          {view.kind === "ready" && view.hint ? (
            <ComboboxFooter>{view.hint}</ComboboxFooter>
          ) : null}
        </ComboboxContent>
      </Combobox>
      <p aria-live="polite" className="sr-only" role="status">
        {open && view.kind === "ready" ? view.status : ""}
      </p>
      <FieldError id={errorId}>{error}</FieldError>
      {nothingToSell ? (
        <div className="grid justify-items-start gap-3">
          <p className="text-muted-foreground text-support">{view.message}</p>
          <NewProductLink href={view.href} />
        </div>
      ) : null}
    </Field>
  );
}
