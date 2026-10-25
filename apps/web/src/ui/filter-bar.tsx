"use client";

import CheckIcon from "lucide-react/dist/esm/icons/check";
import FunnelIcon from "lucide-react/dist/esm/icons/funnel";
import XIcon from "lucide-react/dist/esm/icons/x";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DateRangePanel } from "@/ui/date-range-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  editLabel,
  type FilterField,
  type FilterOption,
  type FilterRule,
  type FilterRuleValue,
  lockedLabel,
  PENDING_TEXT,
  pillMotion,
  removeLabel,
  removeRule,
  type SelectFilterField,
  setRule,
  showClearAll,
  type TextFilterField,
  visibleRules,
} from "@/ui/filter-bar-model";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { ScrollArea } from "@/ui/scroll-area";

export type {
  FilterField,
  FilterRule,
  FilterRuleValue,
} from "@/ui/filter-bar-model";

export interface FilterBarProps {
  /** The screen's `role="status"` line ("3 vendas com esse filtro"): it goes inside the `<search>`, under the bar. */
  children?: ReactNode;
  className?: string | undefined;
  /** The fields that can be a filter, in the order the menu lists them. */
  fields: readonly FilterField[];
  /** The name of the `<search>`: "Filtrar vendas". */
  label: string;
  /** Called with the next list of filters (the order they were added in). */
  onChange: (rules: FilterRule[]) => void;
  /** The filters there are. */
  value: readonly FilterRule[];
}

type Commit = (value: FilterRuleValue | null) => void;

/** One option of a choice: touching it chooses it. */
function OptionButton({
  onCommit,
  option,
  selected,
}: {
  onCommit: Commit;
  option: FilterOption;
  selected: boolean;
}) {
  const choose = useCallback(() => onCommit(option.value), [onCommit, option]);
  return (
    <button
      aria-pressed={selected}
      className="focus-ring flex min-h-8 touch:min-h-11 w-full items-center justify-between gap-2 rounded-sm px-2 text-start text-sm hover:bg-accent aria-pressed:font-medium"
      onClick={choose}
      type="button"
    >
      {option.label}
      {selected ? (
        <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
      ) : null}
    </button>
  );
}

/** A choice among a few options: touching one chooses it and closes the editor. */
function SelectEditor({
  field,
  onCommit,
  value,
}: {
  field: SelectFilterField;
  onCommit: Commit;
  value: string;
}) {
  return (
    <fieldset
      aria-label={field.label}
      className="m-0 grid min-w-0 border-0 p-0"
    >
      {field.options.map((option) => (
        <OptionButton
          key={option.value}
          onCommit={onCommit}
          option={option}
          selected={option.value === value}
        />
      ))}
    </fieldset>
  );
}

/** A text: Enter or "Pronto" applies it, an empty one takes the filter out, Escape leaves it as it was. */
function TextEditor({
  field,
  onCommit,
  value,
}: {
  field: TextFilterField;
  onCommit: Commit;
  value: string;
}) {
  const [text, setText] = useState(value);
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setText(event.target.value),
    []
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onCommit(text);
    },
    [onCommit, text]
  );
  const clear = useCallback(() => onCommit(null), [onCommit]);
  return (
    <form className="grid gap-2" onSubmit={submit}>
      <Input
        aria-label={field.label}
        autoComplete="off"
        enterKeyHint="done"
        onChange={type}
        placeholder={field.placeholder}
        value={text}
      />
      <div className="flex justify-end gap-2">
        {value === "" ? null : (
          <Button onClick={clear} type="button" variant="ghost">
            Limpar
          </Button>
        )}
        <Button type="submit">
          <CheckIcon aria-hidden="true" data-icon="inline-start" />
          Pronto
        </Button>
      </div>
    </form>
  );
}

/** The editor of a pill, by the kind of its field, in the Popover the pill opens. */
function EditorContent({
  field,
  onCommit,
  value,
}: {
  field: FilterField;
  onCommit: Commit;
  value: FilterRuleValue | undefined;
}) {
  switch (field.type) {
    case "text":
      return (
        <TextEditor
          field={field}
          onCommit={onCommit}
          value={typeof value === "string" ? value : ""}
        />
      );
    case "select":
      return (
        <SelectEditor
          field={field}
          onCommit={onCommit}
          value={typeof value === "string" ? value : ""}
        />
      );
    case "date-range":
      return (
        <DateRangePanel
          onCommit={onCommit}
          today={field.today}
          value={value && typeof value !== "string" ? value : null}
        />
      );
    default:
      return field satisfies never;
  }
}

/** What each kind of editor needs of its Popover: the period takes the width of its month, a choice is a short list. */
const POPUP_CLASS = {
  "date-range": "w-auto max-w-[calc(100vw-1rem)] gap-3 p-2",
  select: "w-56 gap-0 p-1",
  text: "",
} as const;

const PILL_BUTTON =
  "touch-hit focus-ring flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-s-full ps-3 pe-2 text-start hover:bg-accent aria-expanded:bg-accent aria-disabled:cursor-default aria-disabled:opacity-70 aria-disabled:hover:bg-transparent";

interface PillProps {
  field: FilterField;
  /** Whether the editor of this pill is open. */
  isEditing: boolean;
  onCommit: (field: FilterField, value: FilterRuleValue | null) => void;
  onEditingChange: (field: FilterField, open: boolean, reason: string) => void;
  onRemove: (field: FilterField) => void;
  reduced: boolean | null;
  /** Absent on the pill of a field just chosen in the menu, which has no value yet. */
  rule: FilterRule | undefined;
  text: string;
}

function FilterPill({
  field,
  isEditing,
  onCommit,
  onEditingChange,
  onRemove,
  reduced,
  rule,
  text,
}: PillProps) {
  const reasonId = useId();
  const pillRef = useRef<HTMLDivElement>(null);
  // the row scrolls under 760 px: a pill that is off the edge comes into view before its editor opens beside it
  useEffect(() => {
    if (isEditing) {
      pillRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [isEditing]);
  // a filter that exists cannot be edited while its field cannot be used; a new one never gets here (the menu blocks it)
  const blocked = field.disabledReason !== undefined && rule !== undefined;
  const commit = useCallback<Commit>(
    (value) => onCommit(field, value),
    [field, onCommit]
  );
  const openChange = useCallback(
    (open: boolean, details: { reason: string }) =>
      onEditingChange(field, open, details.reason),
    [field, onEditingChange]
  );
  const remove = useCallback(() => onRemove(field), [field, onRemove]);
  // touching a pill that cannot open an editor still brings it, with its reason, into the row's window
  const reveal = useCallback(() => {
    pillRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  const name = blocked ? lockedLabel(field, text) : editLabel(field, text);
  // the space keeps "Período 01/10 a 24/10" as the text of the button (the name holds it: WCAG 2.5.3)
  const content = (
    <>
      <span
        className={cn(
          "text-muted-foreground",
          blocked ? "min-w-0 truncate" : "shrink-0"
        )}
      >
        {field.label}
      </span>{" "}
      <span
        className={cn(
          "min-w-0 truncate font-medium",
          blocked && "min-w-[3ch] shrink-[6]"
        )}
      >
        {text}
      </span>
    </>
  );

  return (
    <motion.div
      {...pillMotion(reduced)}
      className={cn(
        "inline-flex h-9 touch:h-11 max-w-full shrink-0 scroll-ms-1.5 items-stretch rounded-full border border-border bg-card text-sm has-[[aria-expanded=true]]:border-foreground/70 has-[[aria-expanded=true]]:ring-2 has-[[aria-expanded=true]]:ring-foreground/10",
        // the row is as wide as its pills (`w-max`), so `max-w-full` caps nothing: a pill with a reason is never wider than the
        // screen, and it is the value that gives way (it truncates) so the reason and the X stay in sight at 320 and 360 px
        blocked && "max-w-[calc(100vw-4rem)] md:max-w-full"
      )}
      data-slot="filter-pill"
      ref={pillRef}
    >
      {blocked ? (
        <>
          <button
            aria-describedby={reasonId}
            aria-disabled="true"
            aria-label={name}
            className={PILL_BUTTON}
            onClick={reveal}
            type="button"
          >
            {content}
          </button>
          {/* the reason is on the pill, in sight, and the button is described by it */}
          <span
            className="flex shrink-0 items-center pe-2 text-muted-foreground text-xs"
            id={reasonId}
          >
            {field.disabledReason}
          </span>
        </>
      ) : (
        <Popover onOpenChange={openChange} open={isEditing}>
          <PopoverTrigger
            render={
              <button aria-label={name} className={PILL_BUTTON} type="button" />
            }
          >
            {content}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label={field.label}
            className={POPUP_CLASS[field.type]}
            initialFocus={field.type === "date-range" ? false : undefined}
          >
            <EditorContent
              field={field}
              onCommit={commit}
              value={rule?.value}
            />
          </PopoverContent>
        </Popover>
      )}
      <button
        aria-label={removeLabel(field)}
        className="touch-hit focus-ring grid touch:w-12 w-9 shrink-0 place-items-center rounded-e-full border-border border-s text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={remove}
        type="button"
      >
        <XIcon aria-hidden="true" className="size-4" />
      </button>
    </motion.div>
  );
}

/**
 * A field in the "Filtrar" menu. One already used is grey with its value at the end; one that cannot be used now
 * (`disabledReason`) is grey with the reason under its name. Both are `aria-disabled` and keep the focus (a disabled
 * item that the keyboard skips would hide the reason), and touching them neither chooses nor closes the menu.
 */
function FieldItem({
  field,
  onChoose,
  used,
}: {
  field: FilterField;
  onChoose: (field: FilterField) => void;
  /** The text of the pill the field already has. */
  used: string | undefined;
}) {
  const blocked = used !== undefined || field.disabledReason !== undefined;
  const choose = useCallback(() => onChoose(field), [field, onChoose]);
  return (
    <DropdownMenuItem
      aria-disabled={blocked || undefined}
      className={cn(blocked && "text-muted-foreground")}
      closeOnClick={!blocked}
      onClick={blocked ? undefined : choose}
    >
      <span className="grid min-w-0 flex-1">
        <span>{field.label}</span>
        {field.disabledReason ? (
          <span className="text-support">{field.disabledReason}</span>
        ) : null}
      </span>
      {used === undefined ? null : (
        <span className="max-w-[55%] truncate text-xs">
          <span className="sr-only">, já usado: </span>
          {used}
        </span>
      )}
    </DropdownMenuItem>
  );
}

/**
 * The filters of a list as a row of pills, in the mold of the Araute's smart filter (no operators, no submenu, no
 * avatars, no codec of the address). Each active filter is a pill: its button opens the editor in a Popover (a text, a
 * choice among a few options, or the `DateRangePanel` of the period) and its X takes it out. "Filtrar" opens a menu with
 * the fields: those already used are grey with their value at the end, one that cannot be used now is `aria-disabled`
 * with its reason under the name ("Só com conexão"). Choosing a field adds its pill and opens the editor; closing the
 * editor with no value takes the pill back. "Limpar tudo" shows with two or more pills.
 *
 * The pills come in and go out with opacity and scale and the neighbours slide (`motion`, as the Araute has it);
 * `prefers-reduced-motion` turns all of it off. Under 760 px the row scrolls sideways in one line (`ScrollArea`), above
 * it the pills wrap. Focus: closing an editor gives it back to the pill; a pill that disappears gives it to "Filtrar".
 * The count of results is the screen's, in a `role="status"` it passes as `children`.
 */
export function FilterBar({
  children,
  className,
  fields,
  label,
  onChange,
  value,
}: FilterBarProps) {
  const reduced = useReducedMotion();
  const searchRef = useRef<HTMLElement>(null);
  /** The field chosen in the menu, whose pill waits for a value. */
  const [adding, setAdding] = useState<string | null>(null);
  /** The field whose editor is open. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Choosing a field closes the menu and opens an editor: the menu must not take the focus back from it. */
  const handOverFocus = useRef(false);

  const shown = visibleRules(fields, value);
  const addingField = fields.find((field) => field.id === adding);
  const pending =
    addingField && !shown.some((entry) => entry.field.id === addingField.id)
      ? addingField
      : undefined;

  const focusFilter = useCallback(() => {
    requestAnimationFrame(() =>
      searchRef.current
        ?.querySelector<HTMLElement>('[data-slot="filter-add"]')
        ?.focus()
    );
  }, []);

  const closeEditor = useCallback(() => {
    setAdding(null);
    setEditing(null);
  }, []);

  const commit = useCallback(
    (field: FilterField, next: FilterRuleValue | null) => {
      const rules = setRule(fields, value, field.id, next);
      closeEditor();
      onChange(rules);
      if (!rules.some((rule) => rule.fieldId === field.id)) {
        focusFilter();
      }
    },
    [closeEditor, fields, focusFilter, onChange, value]
  );

  const remove = useCallback(
    (field: FilterField) => {
      closeEditor();
      onChange(removeRule(value, field.id));
      focusFilter();
    },
    [closeEditor, focusFilter, onChange, value]
  );

  const editingChange = useCallback(
    (field: FilterField, open: boolean, reason: string) => {
      if (open) {
        setEditing(field.id);
        return;
      }
      closeEditor();
      // Escape on the pill of a field with no value takes it back, and with it the button the focus would return to
      if (reason === "escape-key" && adding === field.id) {
        focusFilter();
      }
    },
    [adding, closeEditor, focusFilter]
  );

  const choose = useCallback((field: FilterField) => {
    handOverFocus.current = true;
    setAdding(field.id);
    setEditing(field.id);
  }, []);

  const menuClosed = useCallback(() => {
    const handedOver = handOverFocus.current;
    handOverFocus.current = false;
    return !handedOver;
  }, []);

  const clearAll = useCallback(() => {
    closeEditor();
    onChange([]);
    focusFilter();
  }, [closeEditor, focusFilter, onChange]);

  const pillProps = {
    onCommit: commit,
    onEditingChange: editingChange,
    onRemove: remove,
    reduced,
  };

  return (
    <search
      aria-label={label}
      className={cn("grid grid-cols-[minmax(0,1fr)] gap-2", className)}
      ref={searchRef}
    >
      {/* The 6 px the focus ring needs: up and down as a negative margin (the bar keeps its height); sideways as padding
          of the row, because a box wider than its parent is a layout fault. Above 760 px nothing scrolls, so the viewport
          stops clipping and the padding goes. */}
      <ScrollArea
        className="md:[&>[data-slot=scroll-area-viewport]]:overflow-visible! -my-1.5 min-w-0"
        horizontal
      >
        <div className="flex w-max items-center gap-2 px-1.5 py-1.5 md:w-full md:flex-wrap md:px-0">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="shrink-0"
                  data-slot="filter-add"
                  variant="outline"
                />
              }
            >
              <FunnelIcon aria-hidden="true" data-icon="inline-start" />
              Filtrar
            </DropdownMenuTrigger>
            <DropdownMenuContent
              aria-label="Filtrar por"
              className="w-64"
              finalFocus={menuClosed}
            >
              {fields.map((field) => (
                <FieldItem
                  field={field}
                  key={field.id}
                  onChoose={choose}
                  used={
                    shown.find((entry) => entry.field.id === field.id)?.text
                  }
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <AnimatePresence initial={false}>
            {shown.map(({ field, rule, text }) => (
              <FilterPill
                {...pillProps}
                field={field}
                isEditing={editing === field.id}
                key={field.id}
                rule={rule}
                text={text}
              />
            ))}
            {pending ? (
              <FilterPill
                {...pillProps}
                field={pending}
                isEditing={editing === pending.id}
                key={pending.id}
                rule={undefined}
                text={PENDING_TEXT}
              />
            ) : null}
          </AnimatePresence>

          {showClearAll(shown.length) ? (
            <Button
              className="shrink-0 text-muted-foreground"
              onClick={clearAll}
              size="sm"
              variant="ghost"
            >
              Limpar tudo
            </Button>
          ) : null}
        </div>
      </ScrollArea>
      {children}
    </search>
  );
}
