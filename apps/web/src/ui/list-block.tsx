import {
  Children,
  type ComponentProps,
  isValidElement,
  type ReactNode,
  useId,
} from "react";
import { cn } from "@/lib/utils";
import { Block, BlockHeader, BlockPanel } from "./block";
import { ListNoticeBody } from "./list-notice";
import { ListTotalFooter } from "./list-total-footer";
import { RowTile } from "./row-tile";

/** One node, never a list of them: the block has room for one action. */
type SingleNode = Exclude<ReactNode, Iterable<ReactNode>>;

/**
 * What the panel shows. A list with nothing at all and a list that failed to load are not states of this piece: the
 * screen draws the `EmptyState` or the unframed warning in its place.
 */
type ListBlockStateProps =
  | { emptyNotice?: ReactNode; skeleton?: ReactNode; state: "rows" }
  | { emptyNotice?: ReactNode; skeleton: ReactNode; state: "loading" }
  | { emptyNotice: ReactNode; skeleton?: ReactNode; state: "filtered-empty" };

type ListBlockProps = ListBlockStateProps & {
  action?: SingleNode;
  /** The `ListBlock.Header`, the `ListBlock.Row`s and the `ListBlock.Total`, as direct children. */
  children?: ReactNode;
  className?: string | undefined;
  /** "1.248 produtos": the support text beside the title, announced when it changes. Empty while it is unknown. */
  count: string;
  help?: ComponentProps<typeof BlockHeader>["help"];
  id?: string;
  /** How many times the `skeleton` is drawn while loading. */
  skeletonRows?: number;
  title: ReactNode;
};

const EDGE = "px-2.5 md:px-4";

/** The column header: the first line of the panel, and it scrolls sideways with the rows. */
function ListBlockHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-3 bg-muted/30 py-2 font-medium text-muted-foreground text-support",
        EDGE,
        className
      )}
      data-list-block-header=""
      {...props}
    />
  );
}

/** One row of the list, edge to edge; `tile` is the 16 px icon of what the row is. */
function ListBlockRow({
  children,
  className,
  tile,
  ...props
}: Omit<ComponentProps<"li">, "role"> & { tile?: ReactNode }) {
  return (
    <li
      className={cn("flex min-w-0 items-center gap-3 py-3", EDGE, className)}
      data-list-block-row=""
      {...props}
    >
      {tile === undefined ? null : <RowTile>{tile}</RowTile>}
      {children}
    </li>
  );
}

/** The total of what is on the screen: always the last line of the panel, wherever it is among the children. */
function ListBlockTotal(props: ComponentProps<typeof ListTotalFooter>) {
  return <ListTotalFooter {...props} />;
}

function sortParts(children: ReactNode) {
  const header: ReactNode[] = [];
  const rows: ReactNode[] = [];
  const total: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    const type = isValidElement(child) ? child.type : null;
    if (type === ListBlockHeader) {
      header.push(child);
    } else if (type === ListBlockTotal) {
      total.push(child);
    } else {
      rows.push(child);
    }
  }
  return { header, rows, total };
}

function Body({
  headingId,
  props,
  rows,
}: {
  headingId: string;
  props: ListBlockStateProps & { skeletonRows: number };
  rows: ReactNode[];
}) {
  if (props.state === "loading") {
    return (
      <div aria-hidden="true" className="divide-y divide-border">
        {Array.from(new Array(props.skeletonRows).keys()).map((slot) => (
          <div className={cn("py-3", EDGE)} key={slot}>
            {props.skeleton}
          </div>
        ))}
      </div>
    );
  }
  if (props.state === "filtered-empty") {
    return (
      <div className="py-6" data-list-block-notice="">
        <ListNoticeBody>{props.emptyNotice}</ListNoticeBody>
      </div>
    );
  }
  return rows.length === 0 ? null : (
    <ul aria-labelledby={headingId} className="divide-y divide-border">
      {rows}
    </ul>
  );
}

/**
 * A list or a table on the frame of the Início: the title (an `h2` that names the region), the count at its side and
 * the one action, then a panel with no padding whose lines run edge to edge. Below 760 px it is the card as before,
 * the title and the count as its first line. The header, the rows and the total are parts, and the total is last
 * in every state, so the box keeps its height when a search empties the rows.
 */
function ListBlockRoot({
  action,
  children,
  className,
  count,
  help,
  id,
  skeletonRows = 3,
  title,
  ...stateProps
}: ListBlockProps) {
  const generated = useId();
  const headingId = id ?? generated;
  const { header, rows, total } = sortParts(children);
  return (
    <Block
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 gap-0 p-0 md:gap-(--frame-gap) md:p-(--frame-gap)",
        className
      )}
      data-list-block=""
      data-state={stateProps.state}
    >
      <BlockHeader
        action={action}
        aside={
          <p
            aria-live="polite"
            className="min-h-5 min-w-28 text-muted-foreground text-support md:text-right"
            data-list-count=""
          >
            {count}
          </p>
        }
        className="border-border border-b px-3 py-3 md:border-b-0 md:p-0"
        help={help}
        id={headingId}
        title={title}
      />
      <BlockPanel className="gap-0 overflow-hidden md:p-0">
        <p className="sr-only" role="status">
          {stateProps.state === "loading" ? "Carregando…" : ""}
        </p>
        <div className="min-w-0 overflow-x-auto" data-list-block-scroll="">
          <div className="w-fit min-w-full divide-y divide-border">
            {header}
            <Body
              headingId={headingId}
              props={{ ...stateProps, skeletonRows }}
              rows={rows}
            />
            {total}
          </div>
        </div>
      </BlockPanel>
    </Block>
  );
}

const ListBlock = Object.assign(ListBlockRoot, {
  Header: ListBlockHeader,
  Row: ListBlockRow,
  Total: ListBlockTotal,
});

export { ListBlock, type ListBlockProps };
