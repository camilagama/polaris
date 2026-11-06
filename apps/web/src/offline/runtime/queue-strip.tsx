import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import LoaderCircleIcon from "lucide-react/dist/esm/icons/loader-circle";
import { useEffect, useRef, useState } from "react";
import { type MotionLevel, useMotionLevel } from "@/lib/motion-level";
import { cn } from "@/lib/utils";
import { Alert } from "@/ui/alert";
import { useTabActive } from "../../app-shell/screen-title";
import { useRuntimeSnapshot } from "./runtime-context";
import { type QueueStripText, queueStripText } from "./sync-status";

/** How long the strip takes to fade out when the queue empties, where the interface moves at all. */
const FADE_MS = 150;

/**
 * What to draw now: with the queue emptied the strip keeps the last text while it fades out, and with no motion it
 * goes in the same frame.
 */
export function fadeState(
  text: QueueStripText | null,
  last: QueueStripText | null,
  gone: boolean,
  level: MotionLevel
): { leaving: boolean; shown: QueueStripText | null } {
  const shown = text ?? (gone || level !== "full" ? null : last);
  return { leaving: text === null && shown !== null, shown };
}

function useFadeOut(text: QueueStripText | null, level: MotionLevel) {
  const last = useRef(text);
  if (text) {
    last.current = text;
  }
  const [gone, setGone] = useState(text === null);
  const present = text !== null;
  useEffect(() => {
    if (present) {
      setGone(false);
      return;
    }
    if (level !== "full") {
      setGone(true);
      return;
    }
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [present, level]);
  return fadeState(text, last.current, gone, level);
}

export interface Spoken {
  key: string;
  sentence: string;
}

/**
 * What the screen reader says changes only when the state changes: the count of a sending queue going down gives back
 * the same object, so the live region does not speak again.
 */
export function spokenFor(previous: Spoken, text: QueueStripText): Spoken {
  const key = text.tone === "busy" ? "busy" : text.title;
  return previous.key === key
    ? previous
    : {
        key,
        sentence: [text.title, text.consequence].filter(Boolean).join(". "),
      };
}

/** The visible text is hidden from assistive technology and this one stands for it. */
function useSpokenOnce(text: QueueStripText | null): string {
  const spoken = useRef<Spoken>({ key: "", sentence: "" });
  if (text) {
    spoken.current = spokenFor(spoken.current, text);
  }
  return spoken.current.sentence;
}

const TONE_CLASS: Record<QueueStripText["tone"], string> = {
  busy: "border-border bg-muted/60 text-foreground",
  offline: "",
};

export function QueueStripView({
  level,
  text,
}: {
  level: MotionLevel;
  text: QueueStripText | null;
}) {
  const { leaving, shown } = useFadeOut(text, level);
  const spoken = useSpokenOnce(shown);
  if (!shown) {
    return null;
  }
  const Icon = shown.tone === "busy" ? LoaderCircleIcon : CloudOffIcon;
  return (
    <Alert
      className={cn(
        "queue-strip min-h-9 items-center py-1.5 font-sans motion-full:transition-opacity motion-full:duration-150",
        TONE_CLASS[shown.tone],
        leaving && "opacity-0"
      )}
      data-leaving={leaving ? "" : undefined}
      data-tone={shown.tone}
      variant={shown.tone === "offline" ? "warning" : "default"}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "row-span-1! translate-y-0!",
          shown.tone === "busy" && "motion-full:animate-spin"
        )}
      />
      <span className="sr-only">{spoken}</span>
      <div
        aria-hidden="true"
        className="flex min-w-0 flex-col min-[480px]:flex-row min-[480px]:flex-wrap min-[480px]:items-baseline min-[480px]:gap-x-2"
      >
        <span className="font-medium">{shown.title}</span>
        {shown.consequence ? (
          <span className="text-muted-foreground text-support">
            {shown.consequence}
          </span>
        ) : null}
      </div>
    </Alert>
  );
}

/**
 * The strip at the top of the sale screens (Vender and Histórico), while the queue of this device holds work the
 * server has not taken: it says whether it waits for the connection or is being sent. It does not exist with an empty
 * queue, and on a screen that is a tab it speaks only for the open one. It reads the state the runtime already has.
 */
export function QueueStrip() {
  const snapshot = useRuntimeSnapshot();
  const active = useTabActive();
  const level = useMotionLevel();
  const text = active && snapshot ? queueStripText(snapshot) : null;
  return <QueueStripView level={level} text={text} />;
}
