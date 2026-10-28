"use client";

import SearchIcon from "lucide-react/dist/esm/icons/search";
import XIcon from "lucide-react/dist/esm/icons/x";
import {
  type ChangeEvent,
  type ComponentProps,
  useCallback,
  useRef,
} from "react";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";

/* The search box of the lists (Produtos, Estoque): the magnifier at the start and, only while there is text, a
   "Limpar busca" button at the end that empties the field and gives the focus back to it. The name comes from the
   required `label` (there is no visible label above a search box). `type="search"` with the native cancel mark
   hidden, so there is one "X" and it is ours; the mobile keyboard shows "Buscar" (`enterKeyHint`). With touch the
   button has the 48 px area of every control (`touch-hit`) and the group the one of a field. */
interface SearchFieldProps
  extends Omit<
    ComponentProps<"input">,
    | "aria-label"
    | "aria-labelledby"
    | "onChange"
    | "ref"
    | "type"
    | "value"
    | "enterKeyHint"
  > {
  className?: string;
  /** The accessible name of the field: required, there is no visible label. */
  label: string;
  onValueChange: (value: string) => void;
  value: string;
}

function SearchField({
  className,
  label,
  onValueChange,
  value,
  ...props
}: SearchFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
    [onValueChange]
  );
  const handleClear = useCallback(() => {
    onValueChange("");
    ref.current?.focus();
  }, [onValueChange]);

  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <SearchIcon aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput
        autoComplete="off"
        {...props}
        aria-label={label}
        className="[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none"
        // a search is cheap to type again: it does not hold the swap of the build (pwa/swap-guard.ts)
        data-swap-ignore=""
        enterKeyHint="search"
        onChange={handleChange}
        ref={ref}
        type="search"
        value={value}
      />
      {value === "" ? null : (
        <Button
          aria-label="Limpar busca"
          className="mr-1"
          onClick={handleClear}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" />
        </Button>
      )}
    </InputGroup>
  );
}

export { SearchField };
