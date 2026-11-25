import { type ReactNode, useId } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { BlockHeader as BlockHeading } from "./block-header";
import {
  Card,
  CardContent,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameLink,
  CardFramePanel,
  CardHeader,
} from "./card";

type HeadingProps = React.ComponentProps<typeof BlockHeading>;

type FramedBlockProps = React.ComponentProps<typeof CardFrame> & {
  "aria-labelledby": string;
  title?: never;
  variant?: "framed";
};

type PlainBlockProps = Omit<React.ComponentProps<"div">, "title"> &
  Pick<HeadingProps, "action" | "aside" | "help"> & {
    description?: ReactNode;
    title?: ReactNode;
    variant: "plain";
  };

type BlockProps = FramedBlockProps | PlainBlockProps;

/**
 * The one frame of a screen's blocks: a named region (`aria-labelledby` points at the heading of `BlockHeader`). From
 * 760 px it is a `--muted` frame holding the title, a panel in `--card` and an optional foot; below it, the plain card.
 * `variant="plain"` is the same block without the outer frame (a receipt, a summary): the same heading row and rhythm,
 * and the title is the only thing that may be left out, since then there is no region to name.
 */
function Block(props: BlockProps) {
  const id = useId();
  if (props.variant === "plain") {
    return <PlainBlock {...props} headingId={id} />;
  }
  const { variant: _variant, ...frame } = props;
  return <CardFrame role="region" {...frame} />;
}

function PlainBlock({
  action,
  aside,
  children,
  className,
  description,
  headingId,
  help,
  title,
  variant: _variant,
  ...props
}: PlainBlockProps & { headingId: string }) {
  const named =
    title !== undefined && title !== null && title !== false && title !== "";
  const hasRow = named || description || action || aside;
  return (
    <Card
      aria-labelledby={named ? headingId : undefined}
      className={cn("min-w-0", className)}
      data-block="plain"
      role={named ? "region" : undefined}
      {...props}
    >
      {hasRow ? (
        <CardHeader className="gap-1">
          {named ? (
            <BlockHeading
              action={action}
              aside={aside}
              className="md:flex-nowrap"
              help={help}
              id={headingId}
              title={title}
            />
          ) : (
            <div className="flex min-w-0 items-center justify-end gap-x-3">
              {aside}
              {action}
            </div>
          )}
          {description ? (
            <p className="text-muted-foreground text-support">{description}</p>
          ) : null}
        </CardHeader>
      ) : null}
      {children === undefined || children === null ? null : (
        <CardContent className="flex min-w-0 flex-col gap-(--card-spacing)">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

/** The title row on the frame: the heading, its (i), what the block shows at its side and its one action. */
function BlockHeader({ className, ...props }: HeadingProps) {
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
