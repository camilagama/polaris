"use client";

import SearchIcon from "lucide-react/dist/esm/icons/search";
import XIcon from "lucide-react/dist/esm/icons/x";
import {
  type ChangeEvent,
  type ComponentProps,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";

/* The search box of the lists (Produtos, Estoque): the magnifier at the start and, only while there is text, a
   "Limpar busca" button at the end that empties the field and gives the focus back to it. The name comes from the
   required `label` (there is no visible label above a search box). `type="search"` with the native cancel mark
   hidden, so there is one "X" and it is ours; the mobile keyboard shows "Buscar" (`enterKeyHint`). With touch the
   button has the 44 px area of every control (`touch-hit`) and the group the one of a field. Under `NARROW_FIELD_REM` (14 rem,
   measured on the group, so it follows the text size) the placeholder is only "Buscar" and what it would say (the
   `placeholder` the screen gives) is a line under the field, tied to it by `aria-describedby`: a hint cut in the
   middle of a word teaches nothing. */
const NARROW_FIELD_REM = 14;
const NARROW_PLACEHOLDER = "Buscar";

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
  /** Where the line under a narrow field goes in a row that lays its children out itself (a `flex-wrap` row: `order-last basis-full`). */
  hintClassName?: string;
  /** The accessible name of the field: required, there is no visible label. */
  label: string;
  onValueChange: (value: string) => void;
  value: string;
}

/** Whether the group around `input` is narrower than `NARROW_FIELD_REM` of the current text size, followed as it changes. */
function useNarrow(input: RefObject<HTMLInputElement | null>) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const group = input.current?.parentElement;
    if (!group) {
      return;
    }
    const measure = () => {
      const root = Number.parseFloat(
        getComputedStyle(document.documentElement).fontSize
      );
      setNarrow(group.getBoundingClientRect().width < NARROW_FIELD_REM * root);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [input]);
  return narrow;
}

function SearchField({
  className,
  hintClassName,
  label,
  onValueChange,
  placeholder,
  value,
  ...props
}: SearchFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const narrow = useNarrow(ref);
  const hinted = narrow && placeholder !== undefined && placeholder !== "";
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
    [onValueChange]
  );
  const handleClear = useCallback(() => {
    onValueChange("");
    ref.current?.focus();
  }, [onValueChange]);

  const describedBy =
    [props["aria-describedby"], hinted ? hintId : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <>
      <InputGroup className={className}>
        <InputGroupAddon>
          <SearchIcon aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          autoComplete="off"
          {...props}
          aria-describedby={describedBy}
          aria-label={label}
          className="[&::-webkit-search-cancel-button]:hidden [&::-webkit-search-cancel-button]:appearance-none"
          // a search is cheap to type again: it does not hold the swap of the build (pwa/swap-guard.ts)
          data-swap-ignore=""
          enterKeyHint="search"
          onChange={handleChange}
          placeholder={hinted ? NARROW_PLACEHOLDER : placeholder}
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
      {hinted ? (
        <p
          className={cn("text-muted-foreground text-support", hintClassName)}
          id={hintId}
        >
          {placeholder}
        </p>
      ) : null}
    </>
  );
}

export { SearchField };
