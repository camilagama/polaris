"use client";

import CheckIcon from "lucide-react/dist/esm/icons/check";
import FunnelIcon from "lucide-react/dist/esm/icons/funnel";
import XIcon from "lucide-react/dist/esm/icons/x";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PHONE_QUERY } from "@/lib/breakpoints";
import { type MotionLevel, useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DateRangePanel } from "@/ui/date-range-picker";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  type EditableFilterField,
  editLabel,
  type FilterField,
  type FilterOption,
  type FilterRule,
  type FilterRuleValue,
  lockedLabel,
  PENDING_TEXT,
  type PillMotion,
  pillMotion,
  removeLabel,
  removeRule,
  type SelectFilterField,
  setRule,
  showClearAll,
  TOGGLE_ON,
  type TextFilterField,
  type ToggleFilterField,
  visibleRules,
} from "@/ui/filter-bar-model";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

export type {
  FilterField,
  FilterRule,
  FilterRuleValue,
} from "@/ui/filter-bar-model";

export interface FilterBarProps {
  /** Below 760 px "Filtrar" is only the icon, named by `label`: the first line keeps room for what `leading` brings. */
  addIconOnPhone?: boolean;
  /** The screen's `role="status"` line ("3 vendas com esse filtro"): it goes inside the `<search>`, under the bar. */
  children?: ReactNode;
  className?: string | undefined;
  /** The fields that can be a filter, in the order the menu lists them. */
  fields: readonly FilterField[];
  /** The name of the `<search>`: "Filtrar vendas". */
  label: string;
  /** A search box that shares the first line with "Filtrar": the bar wraps the pills under it, so the screen needs no line of its own for either. */
  leading?: ReactNode;
  /** Called with the next list of filters (the order they were added in). */
  onChange: (rules: FilterRule[]) => void;
  /** The filters there are. */
  value: readonly FilterRule[];
}

type Commit = (value: FilterRuleValue | null) => void;

type MotionLayer = typeof import("./filter-bar-motion");

let loadedLayer: MotionLayer | null = null;
let loadingLayer: Promise<MotionLayer> | null = null;

function loadMotionLayer(): Promise<MotionLayer> {
  if (!loadingLayer) {
    loadingLayer = import("./filter-bar-motion").then(
      (layer) => {
        loadedLayer = layer;
        return layer;
      },
      (error: unknown) => {
        // a failed download (offline before the chunk was cached) is tried again by the next bar; until then nothing moves
        loadingLayer = null;
        throw error;
      }
    );
  }
  return loadingLayer;
}

/**
 * The animated layer of the pills, only at the `full` level of motion: it comes by `import()`, so a phone never asks
 * for the `motion` chunk. Until it arrives (and if it cannot) the pills are drawn still, with the same DOM and the same
 * final state; the first paint does not animate anyway. Changing between the two remounts the pills, so it waits while
 * an editor is open or the focus is in the bar (`busy`): the focus and the text being typed are never lost to it.
 */
function useMotionLayer(level: MotionLevel, busy: boolean): MotionLayer | null {
  const [loaded, setLoaded] = useState(loadedLayer);
  useEffect(() => {
    if (level !== "full" || loaded) {
      return;
    }
    let current = true;
    loadMotionLayer().then(
      (layer) => current && setLoaded(layer),
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [level, loaded]);
  const wanted = level === "full" ? loaded : null;
  const [shown, setShown] = useState(wanted);
  if (!busy && shown !== wanted) {
    setShown(wanted);
  }
  return shown;
}

/** A pill with no motion: the frame the animated layer draws as `motion.div`, as a plain element. */
function StillPillFrame({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
  motion: PillMotion;
}) {
  return (
    <div className={className} data-slot="filter-pill">
      {children}
    </div>
  );
}

/** The list of pills with no motion: no presence to wait for an exit. */
function StillPillList({ children }: { children: ReactNode }) {
  return children;
}

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
    // a filter goes in the address once applied: it does not hold the swap of the build (pwa/swap-guard.ts)
    <form className="grid gap-2" data-swap-ignore="" onSubmit={submit}>
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
  field: EditableFilterField;
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
          endsToday={field.endsToday}
          onCommit={onCommit}
          today={field.today}
          value={value && typeof value !== "string" ? value : null}
        />
      );
    default:
      return field satisfies never;
  }
}

const noPhone = () => false;
const noUnsubscribe = () => undefined;
const hasMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function";

function subscribePhone(onChange: () => void): () => void {
  if (!hasMatchMedia()) {
    return noUnsubscribe;
  }
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const readPhone = () =>
  hasMatchMedia() && window.matchMedia(PHONE_QUERY).matches;

/** Below 760 px, the line the form Dialog is the whole screen at: there the editor of a pill is that Dialog, not a Popover. */
function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, readPhone, noPhone);
}

/** Why the Dialog of an editor closed with no value applied (Cancelar, ×, Esc, the step back of the phone): the reasons of Base UI are not told apart, for none of them applies. */
const DIALOG_CLOSE = "dialog-close";

/** A text in the Dialog: what is typed is a draft, "Aplicar" (or Enter) applies it, "Limpar" empties the draft. */
function TextDraftEditor({
  field,
  onDraft,
  value,
}: {
  field: TextFilterField;
  onDraft: (value: string) => void;
  value: string;
}) {
  const type = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onDraft(event.target.value),
    [onDraft]
  );
  const clear = useCallback(() => onDraft(""), [onDraft]);
  return (
    <>
      <Input
        aria-label={field.label}
        autoComplete="off"
        enterKeyHint="done"
        onChange={type}
        placeholder={field.placeholder}
        value={value}
      />
      {value === "" ? null : (
        <Button
          className="justify-self-end"
          onClick={clear}
          type="button"
          variant="ghost"
        >
          Limpar
        </Button>
      )}
    </>
  );
}

/** The body of the Dialog by the kind of the field: the same editors as the Popover, writing a draft instead of the filter. */
function DraftContent({
  draft,
  field,
  onDraft,
  onHalfChange,
  statusId,
}: {
  draft: FilterRuleValue | null;
  field: EditableFilterField;
  onDraft: Commit;
  onHalfChange: (half: boolean) => void;
  statusId: string;
}) {
  const text = typeof draft === "string" ? draft : "";
  switch (field.type) {
    case "text":
      return <TextDraftEditor field={field} onDraft={onDraft} value={text} />;
    case "select":
      return <SelectEditor field={field} onCommit={onDraft} value={text} />;
    case "date-range":
      return (
        <DateRangePanel
          endsToday={field.endsToday}
          onCommit={onDraft}
          onHalfChange={onHalfChange}
          statusId={statusId}
          today={field.today}
          value={draft && typeof draft !== "string" ? draft : null}
        />
      );
    default:
      return field satisfies never;
  }
}

/**
 * The editor of a pill on a phone, inside the form Dialog (the whole screen): the title is the name of the filter, the
 * body is the editor of the Popover and the footer, fixed, has "Aplicar" and "Cancelar". Nothing is applied until
 * "Aplicar": a choice, a text or a day only change the draft, which lives with the content, so closing
 * (Cancelar, ×, Esc, the step back) drops it. A draft with no value (an empty text, no choice, "Limpar") applies as
 * taking the filter out, as in the Popover. With only the first day of a period marked "Aplicar" is `aria-disabled`
 * (described by the line that asks for the last day), so the day touched is never dropped by applying the old range.
 * In a period a shortcut applies and closes at once, and "Aplicar" shows only after a day was touched or typed, or
 * "Limpar" was pressed: until then there is no draft to confirm.
 */
function PhoneEditorContent({
  field,
  onApply,
  value,
}: {
  field: EditableFilterField;
  onApply: Commit;
  value: FilterRuleValue | undefined;
}) {
  const [draft, setDraft] = useState<FilterRuleValue | null>(value ?? null);
  const [half, setHalf] = useState(false);
  const [picked, setPicked] = useState(false);
  const statusId = useId();
  const isPeriod = field.type === "date-range";
  const showApply = !isPeriod || picked || half;
  const draftPeriod = useCallback(
    (next: FilterRuleValue | null, shortcut?: string) => {
      if (shortcut) {
        onApply(next);
        return;
      }
      setDraft(next);
      setPicked(true);
    },
    [onApply]
  );
  const apply = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!half) {
        onApply(draft);
      }
    },
    [draft, half, onApply]
  );
  return (
    <DialogForm onSubmit={apply}>
      <DialogHeader>
        <DialogTitle>{field.label}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DraftContent
          draft={draft}
          field={field}
          onDraft={isPeriod ? draftPeriod : setDraft}
          onHalfChange={setHalf}
          statusId={statusId}
        />
      </DialogBody>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>
          Cancelar
        </DialogClose>
        {showApply ? (
          <Button
            aria-describedby={half ? statusId : undefined}
            aria-disabled={half || undefined}
            size="xl"
            type="submit"
          >
            Aplicar
          </Button>
        ) : null}
      </DialogFooter>
    </DialogForm>
  );
}

/** What each kind of editor needs of its Popover: the period takes the width of its month, a choice is a short list. */
const POPUP_CLASS = {
  "date-range":
    "max-h-(--available-height) w-auto max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto overflow-x-hidden p-2",
  select: "w-56 gap-0 p-1",
  text: "",
} as const;

const PILL_BUTTON =
  "touch-hit focus-ring flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-s-full ps-3 pe-2 text-start hover:bg-accent aria-expanded:bg-accent aria-disabled:cursor-default aria-disabled:opacity-70 aria-disabled:hover:bg-transparent";

interface PillEditorProps {
  commit: Commit;
  /** What the pill's button shows: the field and the value. */
  content: ReactNode;
  field: EditableFilterField;
  isEditing: boolean;
  /** The accessible name of the pill's button. */
  name: string;
  onEditingChange: (field: FilterField, open: boolean, reason: string) => void;
  phone: boolean;
  value: FilterRuleValue | undefined;
}

/** The button of a pill and the editor it opens: the form Dialog of the whole screen on a phone, a Popover from 760 px. */
function PillEditor({
  commit,
  content,
  field,
  isEditing,
  name,
  onEditingChange,
  phone,
  value,
}: PillEditorProps) {
  const [openings, setOpenings] = useState(0);
  const [wasEditing, setWasEditing] = useState(isEditing);
  // an editor reopened while its popup is still leaving stays mounted with the month and the draft of the last opening:
  // a new key at each opening (by the menu too, which opens it without the popup's own change) gives it the first ones
  if (wasEditing !== isEditing) {
    setWasEditing(isEditing);
    if (isEditing) {
      setOpenings((count) => count + 1);
    }
  }
  const popoverChange = useCallback(
    (open: boolean, details: { reason: string }) =>
      onEditingChange(field, open, details.reason),
    [field, onEditingChange]
  );
  const dialogChange = useCallback(
    (open: boolean) =>
      onEditingChange(field, open, open ? "trigger-press" : DIALOG_CLOSE),
    [field, onEditingChange]
  );
  const button = (
    <button aria-label={name} className={PILL_BUTTON} type="button" />
  );
  if (phone) {
    return (
      <Dialog
        disablePointerDismissal
        onOpenChange={dialogChange}
        open={isEditing}
      >
        <DialogTrigger render={button}>{content}</DialogTrigger>
        <DialogContent layout="form">
          <PhoneEditorContent
            field={field}
            key={openings}
            onApply={commit}
            value={value}
          />
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Popover onOpenChange={popoverChange} open={isEditing}>
      <PopoverTrigger render={button}>{content}</PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={field.label}
        className={POPUP_CLASS[field.type]}
        initialFocus={field.type === "date-range" ? false : undefined}
      >
        <EditorContent
          field={field}
          key={openings}
          onCommit={commit}
          value={value}
        />
      </PopoverContent>
    </Popover>
  );
}

const PILL_FRAME =
  "inline-flex h-9 touch:h-11 max-w-full shrink-0 items-stretch rounded-full border border-border bg-card text-sm has-[[aria-expanded=true]]:border-foreground/70 has-[[aria-expanded=true]]:ring-2 has-[[aria-expanded=true]]:ring-foreground/10";

/** The X of a pill: the only control of a switch's pill. */
function RemoveButton({
  field,
  onRemove,
}: {
  field: FilterField;
  onRemove: () => void;
}) {
  return (
    <button
      aria-label={removeLabel(field)}
      className="touch-hit focus-ring grid touch:w-11 w-9 shrink-0 place-items-center rounded-e-full border-border border-s text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onRemove}
      type="button"
    >
      <XIcon aria-hidden="true" className="size-4" />
    </button>
  );
}

interface PillProps {
  field: EditableFilterField;
  /** Whether the editor of this pill is open. */
  isEditing: boolean;
  /** The animated layer, at the `full` level once loaded; null draws the pill still. */
  layer: MotionLayer | null;
  level: MotionLevel;
  onCommit: (field: FilterField, value: FilterRuleValue | null) => void;
  onEditingChange: (field: FilterField, open: boolean, reason: string) => void;
  onRemove: (field: FilterField) => void;
  /** A phone: the editor is the Dialog of the whole screen, not the Popover. */
  phone: boolean;
  /** Absent on the pill of a field just chosen in the menu, which has no value yet. */
  rule: FilterRule | undefined;
  text: string;
}

/** The pill of a switch: its text alone (and the reason, when the connection it needs is missing), with only the X as a control. */
function TogglePill({
  field,
  layer,
  level,
  onRemove,
  text,
}: {
  field: ToggleFilterField;
  layer: MotionLayer | null;
  level: MotionLevel;
  onRemove: (field: FilterField) => void;
  text: string;
}) {
  const remove = useCallback(() => onRemove(field), [field, onRemove]);
  const Frame = layer?.PillFrame ?? StillPillFrame;
  return (
    <Frame className={PILL_FRAME} motion={pillMotion(level)}>
      <span className="flex min-w-0 items-center ps-3 pe-2 font-medium">
        <span className="min-w-0 truncate">{text}</span>
      </span>
      {field.disabledReason ? (
        <span className="flex shrink-0 items-center pe-2 text-muted-foreground text-xs">
          {field.disabledReason}
        </span>
      ) : null}
      <RemoveButton field={field} onRemove={remove} />
    </Frame>
  );
}

function FilterPill({
  field,
  isEditing,
  onCommit,
  onEditingChange,
  onRemove,
  layer,
  level,
  phone,
  rule,
  text,
}: PillProps) {
  const reasonId = useId();
  // a filter that exists cannot be edited while its field cannot be used; a new one never gets here (the menu blocks it)
  const blocked = field.disabledReason !== undefined && rule !== undefined;
  const commit = useCallback<Commit>(
    (value) => onCommit(field, value),
    [field, onCommit]
  );
  const remove = useCallback(() => onRemove(field), [field, onRemove]);
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

  const Frame = layer?.PillFrame ?? StillPillFrame;
  // the row wraps, so `max-w-full` is the width of the screen: a pill with a reason is never wider than it, and it is
  // the value that gives way (it truncates) so the reason and the X stay in sight at 320 and 360 px
  return (
    <Frame className={PILL_FRAME} motion={pillMotion(level)}>
      {blocked ? (
        <>
          <button
            aria-describedby={reasonId}
            aria-disabled="true"
            aria-label={name}
            className={PILL_BUTTON}
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
        <PillEditor
          commit={commit}
          content={content}
          field={field}
          isEditing={isEditing}
          name={name}
          onEditingChange={onEditingChange}
          phone={phone}
          value={rule?.value}
        />
      )}
      <RemoveButton field={field} onRemove={remove} />
    </Frame>
  );
}

/**
 * A switch in the "Filtrar" menu: a `menuitemcheckbox` that is checked while its pill exists. Touching it turns the
 * filter on or off and closes the menu, and the focus goes back to "Filtrar". Without the connection it needs
 * (`disabledReason`) it is `aria-disabled` with the reason under its name, keeps the focus, and neither changes nor closes.
 */
function ToggleItem({
  field,
  on,
  onToggle,
}: {
  field: ToggleFilterField;
  on: boolean;
  onToggle: (field: ToggleFilterField, on: boolean) => void;
}) {
  const blocked = field.disabledReason !== undefined;
  const change = useCallback(
    (checked: boolean) => onToggle(field, checked),
    [field, onToggle]
  );
  return (
    <DropdownMenuCheckboxItem
      aria-disabled={blocked || undefined}
      checked={on}
      className={cn(blocked && "text-muted-foreground")}
      closeOnClick={!blocked}
      onCheckedChange={blocked ? undefined : change}
    >
      <span className="grid min-w-0 flex-1">
        <span>{field.label}</span>
        {field.disabledReason ? (
          <span className="text-support">{field.disabledReason}</span>
        ) : null}
      </span>
    </DropdownMenuCheckboxItem>
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
 * editor with no value takes the pill back. A yes-or-no field (`type: "toggle"`) is a checkbox item instead: touching it
 * turns the filter on or off with no editor, and its pill is a text with only the X. "Limpar tudo" shows with two or more pills.
 *
 * At the `full` level of motion the pills come in and go out with opacity and scale and the neighbours slide (`motion`,
 * as the Araute has it, in `filter-bar-motion.tsx`, loaded by `import()`); on a phone and with `prefers-reduced-motion`
 * nothing of it runs and the `motion` chunk is not asked for (src/lib/motion-level.ts, ADR 0103). The pills wrap into
 * lines at every width (nothing scrolls sideways: a pill off the edge would hide the filters), "Limpar tudo" at the end.
 * Below 760 px the editor is not a Popover but the form Dialog of the whole screen (title = the field, footer "Aplicar"
 * and "Cancelar", nothing applied before "Aplicar"; `PhoneEditorContent`). Focus: closing an editor gives it back to the
 * pill; a pill that disappears gives it to "Filtrar". The count of results is the screen's, in a `role="status"` it
 * passes as `children`.
 */
export function FilterBar({
  addIconOnPhone = false,
  children,
  className,
  fields,
  label,
  leading,
  onChange,
  value,
}: FilterBarProps) {
  const level = useMotionLevel();
  const phone = usePhone();
  const iconOnly = addIconOnPhone && phone;
  const searchRef = useRef<HTMLElement>(null);
  /** The field chosen in the menu, whose pill waits for a value. */
  const [adding, setAdding] = useState<string | null>(null);
  /** The field whose editor is open. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The focus is in the bar (a pill, its X, the menu button): swapping the layer would remount it and drop the focus. */
  const [focusInside, setFocusInside] = useState(false);
  useEffect(() => {
    const bar = searchRef.current;
    if (!bar) {
      return;
    }
    const focusIn = () => setFocusInside(true);
    const focusOut = (event: FocusEvent) =>
      setFocusInside(
        event.relatedTarget instanceof Node && bar.contains(event.relatedTarget)
      );
    bar.addEventListener("focusin", focusIn);
    bar.addEventListener("focusout", focusOut);
    return () => {
      bar.removeEventListener("focusin", focusIn);
      bar.removeEventListener("focusout", focusOut);
    };
  }, []);
  const layer = useMotionLayer(
    level,
    editing !== null || adding !== null || focusInside
  );
  const PillList = layer?.PillList ?? StillPillList;
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

  // crossing 760 px with an editor open (the phone turned, the window resized) swaps the Popover for the Dialog or back:
  // the editor is closed, as the swap would drop its draft and its trigger anyway
  const [wasPhone, setWasPhone] = useState(phone);
  if (wasPhone !== phone) {
    setWasPhone(phone);
    closeEditor();
  }

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
      // (so does any close of the Dialog: Cancelar, ×, the step back)
      if (
        (reason === "escape-key" || reason === DIALOG_CLOSE) &&
        adding === field.id
      ) {
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

  const toggle = useCallback(
    (field: ToggleFilterField, on: boolean) => {
      closeEditor();
      onChange(setRule(fields, value, field.id, on ? TOGGLE_ON : null));
    },
    [closeEditor, fields, onChange, value]
  );

  const clearAll = useCallback(() => {
    closeEditor();
    onChange([]);
    focusFilter();
  }, [closeEditor, focusFilter, onChange]);

  const pills: {
    field: FilterField;
    rule: FilterRule | undefined;
    text: string;
  }[] = pending
    ? [...shown, { field: pending, rule: undefined, text: PENDING_TEXT }]
    : shown;

  const pillProps = {
    layer,
    level,
    onCommit: commit,
    onEditingChange: editingChange,
    onRemove: remove,
    phone,
  };

  return (
    <search
      aria-label={label}
      className={cn("grid grid-cols-[minmax(0,1fr)] gap-2", className)}
      ref={searchRef}
    >
      <div className="flex flex-wrap items-center gap-2 touch:gap-y-3">
        {leading}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={iconOnly ? label : undefined}
                className="shrink-0"
                data-slot="filter-add"
                size={iconOnly ? "icon" : "default"}
                variant="outline"
              />
            }
          >
            {iconOnly ? (
              <FunnelIcon aria-hidden="true" />
            ) : (
              <>
                <FunnelIcon aria-hidden="true" data-icon="inline-start" />
                Filtrar
              </>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            aria-label="Filtrar por"
            className="w-64 max-w-[calc(100vw-1rem)]"
            finalFocus={menuClosed}
          >
            {fields.map((field) => {
              const used = shown.find(
                (entry) => entry.field.id === field.id
              )?.text;
              return field.type === "toggle" ? (
                <ToggleItem
                  field={field}
                  key={field.id}
                  on={used !== undefined}
                  onToggle={toggle}
                />
              ) : (
                <FieldItem
                  field={field}
                  key={field.id}
                  onChoose={choose}
                  used={used}
                />
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* one keyed list: the pill of a field just chosen and the same pill once it has a value are one element,
              so the editor's trigger (where the focus goes back) is not remounted; `AnimatePresence` does the same */}
        <PillList>
          {pills.map(({ field, rule, text }) =>
            field.type === "toggle" ? (
              <TogglePill
                field={field}
                key={field.id}
                layer={layer}
                level={level}
                onRemove={remove}
                text={text}
              />
            ) : (
              <FilterPill
                {...pillProps}
                field={field}
                isEditing={editing === field.id}
                key={field.id}
                rule={rule}
                text={text}
              />
            )
          )}
        </PillList>

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
      {children}
    </search>
  );
}
