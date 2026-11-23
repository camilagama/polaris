import type * as React from "react";
import { cn } from "@/lib/utils";
import { BlockHeader as BlockHeading } from "./block-header";
import {
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameLink,
  CardFramePanel,
} from "./card";

/**
 * The one frame of a screen's blocks: a named region (`aria-labelledby` points at the heading of `BlockHeader`). From
 * 760 px it is a `--muted` frame holding the title, a panel in `--card` and an optional foot; below it, the plain card.
 */
function Block({ ...props }: React.ComponentProps<typeof CardFrame>) {
  return <CardFrame role="region" {...props} />;
}

/** The title row on the frame: the heading, its (i), what the block shows at its side and its one action. */
function BlockHeader({
  className,
  ...props
}: React.ComponentProps<typeof BlockHeading>) {
  return (
    <CardFrameHeader>
      <BlockHeading className={cn("md:flex-nowrap", className)} {...props} />
    </CardFrameHeader>
  );
}

function BlockPanel(props: React.ComponentProps<typeof CardFramePanel>) {
  return <CardFramePanel {...props} />;
}

/** One line on the frame under the panel, from 760 px; it holds the `BlockLink`. */
function BlockFooter(props: React.ComponentProps<typeof CardFrameFooter>) {
  return <CardFrameFooter {...props} />;
}

function BlockLink(props: React.ComponentProps<typeof CardFrameLink>) {
  return <CardFrameLink {...props} />;
}

export { Block, BlockFooter, BlockHeader, BlockLink, BlockPanel };
