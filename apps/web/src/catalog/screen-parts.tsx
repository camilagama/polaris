import { type ReactNode, useCallback } from "react";
import { Card } from "@/ui/card";

/* The parts the list screens of the catalog area share (Categorias, Clientes): the state choice under the title, the
   card that says loading, empty or no result, and the date as the lists write it. */

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" });

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

const TAB =
  "focus-ring touch-hit relative -mb-px inline-flex h-ctl-lg items-center border-transparent border-b-2 font-medium text-muted-foreground transition-colors hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground disabled:pointer-events-none disabled:opacity-50";

interface StatusTabProps<T extends string> {
  disabled: boolean;
  label: string;
  onSelect: (value: T) => void;
  selected: boolean;
  value: T;
}

function StatusTab<T extends string>({
  disabled,
  label,
  onSelect,
  selected,
  value,
}: StatusTabProps<T>) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <button
      aria-pressed={selected}
      className={TAB}
      data-status={value}
      disabled={disabled}
      onClick={handleClick}
      type="button"
    >
      {label}
    </button>
  );
}

interface StatusNavProps<T extends string> {
  /** The tabs cannot change while an action runs. */
  disabled?: boolean | undefined;
  label: string;
  onSelect: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
  value: T;
}

/** The states of a list: a line under the selected one, the buttons say which is pressed. */
export function StatusNav<T extends string>({
  disabled = false,
  label,
  onSelect,
  options,
  value,
}: StatusNavProps<T>) {
  return (
    <nav aria-label={label} className="flex gap-4 border-border border-b">
      {options.map(([option, text]) => (
        <StatusTab
          disabled={disabled}
          key={option}
          label={text}
          onSelect={onSelect}
          selected={value === option}
          value={option}
        />
      ))}
    </nav>
  );
}

/** Loading, empty or no result of a list: a card with a few words, and what to do next when there is one. */
export function ListNotice({ children }: { children: ReactNode }) {
  return (
    <Card className="py-6">
      <div className="grid justify-items-center gap-3 px-4 text-center">
        {children}
      </div>
    </Card>
  );
}
