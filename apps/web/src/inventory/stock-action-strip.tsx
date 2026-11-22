import { type MouseEvent, useCallback } from "react";
import { ActionStrip } from "../app-shell/action-strip";
import type { StockAttentionLink } from "./stock-list-model";
import { TextLink } from "@/ui/text-link";

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
      <TextLink inline href={link.href} onClick={handleClick}>
        {link.text}
      </TextLink>
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
