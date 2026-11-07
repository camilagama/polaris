import { type MouseEvent, useCallback } from "react";
import { ActionStrip } from "../app-shell/action-strip";
import type { StockAttentionLink } from "./stock-list-model";

/** A link inside a sentence: no touch area of its own (a line of text), only the focus ring. */
export const LINK =
  "focus-ring rounded-sm underline decoration-input underline-offset-4 hover:decoration-foreground";

function AttentionLink({
  first,
  link,
  onApply,
}: {
  first: boolean;
  link: StockAttentionLink;
  onApply: (
    event: MouseEvent<HTMLAnchorElement>,
    link: StockAttentionLink
  ) => void;
}) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => onApply(event, link),
    [link, onApply]
  );
  return (
    <>
      {first ? null : " · "}
      <a className={LINK} href={link.href} onClick={handleClick}>
        {link.text}
      </a>
    </>
  );
}

export function StockActionStrip({
  links,
  onApply,
  unavailable,
}: {
  links: StockAttentionLink[];
  unavailable: boolean;
  onApply: (
    event: MouseEvent<HTMLAnchorElement>,
    link: StockAttentionLink
  ) => void;
}) {
  if (unavailable) {
    return (
      <p className="text-muted-foreground text-support">
        Avisos do estoque indisponíveis agora.
      </p>
    );
  }
  if (links.length === 0) {
    return null;
  }
  return (
    <ActionStrip>
      {links.map((link, position) => (
        <AttentionLink
          first={position === 0}
          key={link.id}
          link={link}
          onApply={onApply}
        />
      ))}
    </ActionStrip>
  );
}
