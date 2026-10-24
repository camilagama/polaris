import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button, buttonVariants } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { Card, CardHeader } from "@/ui/card";
import { dialogWidth } from "@/ui/dialog";
import { menuContentWidth } from "@/ui/dropdown-menu";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/ui/field";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupInput } from "@/ui/input-group";
import { Label } from "@/ui/label";
import { Progress, ProgressValue } from "@/ui/progress";
import { Select, SelectTrigger } from "@/ui/select";
import { Skeleton } from "@/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/ui/table";

/**
 * No `tailwind-merge` (t320): `cn` is `clsx` alone, so a class that a part sets and the screen wants different never
 * wins by the order of the classes in the CSS. Each part with a property a screen changes has a variant or a prop for
 * it, and the class it replaces is not in the element. These tests read the classes of the element a part renders:
 * the right class is there and the one it replaces is not. They are the proof that a variant does not leave the two
 * classes of one property side by side (which is what `tailwind-merge` used to hide).
 */
const fromHtml = (text: string) =>
  text
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** The classes of the first element of the markup, or of the first with `data-slot="<slot>"`. */
const TAG = /<[a-z][^>]*>/g;
const CLASS_ATTRIBUTE = /class="([^"]*)"/;
const SPACES = /\s+/;
const classesOf = (node: React.ReactElement, slot?: string) => {
  const markup = renderToStaticMarkup(node);
  const tags = markup.match(TAG) ?? [];
  const tag =
    (slot
      ? tags.find((item) => item.includes(`data-slot="${slot}"`))
      : tags[0]) ?? "";
  const value = tag.match(CLASS_ATTRIBUTE)?.[1] ?? "";
  return new Set(fromHtml(value).split(SPACES).filter(Boolean));
};

/** The classes of an element as `[present, absent]` lists. */
const expectClasses = (
  node: React.ReactElement,
  present: string[],
  absent: string[],
  slot?: string
) => {
  const classes = classesOf(node, slot);
  for (const name of present) {
    expect(classes, `has ${name}`).toContain(name);
  }
  for (const name of absent) {
    expect(classes, `has not ${name}`).not.toContain(name);
  }
};

describe("cn", () => {
  it("only joins: a later class never takes another out", () => {
    expect(cn("h-ctl-md", "h-auto")).toBe("h-ctl-md h-auto");
    expect(cn("text-sm", false, undefined, ["text-support"])).toBe(
      "text-sm text-support"
    );
  });
});

describe("Button", () => {
  it("has the border of its variant alone", () => {
    expectClasses(
      <Button variant="outline">x</Button>,
      ["border-border"],
      ["border-transparent"]
    );
    expectClasses(
      <Button>x</Button>,
      ["border-transparent"],
      ["border-border"]
    );
    // an anchor styled with the variants gets the same
    expect(buttonVariants({ variant: "outline" })).not.toContain(
      "border-transparent"
    );
  });

  it("has the gap, the icon and the type size of its size alone", () => {
    expectClasses(
      <Button size="sm">x</Button>,
      ["gap-1", "text-sm", "[&_svg:not([class*='size-'])]:size-3.5"],
      ["gap-1.5", "text-xs", "[&_svg:not([class*='size-'])]:size-4"]
    );
    expectClasses(
      <Button size="xs">x</Button>,
      ["text-xs", "gap-1", "h-ctl-xs"],
      ["text-sm", "gap-1.5", "h-ctl-sm"]
    );
    expectClasses(
      <Button size="icon-sm">x</Button>,
      ["size-ctl-sm", "[&_svg:not([class*='size-'])]:size-3.5"],
      ["size-ctl-md", "[&_svg:not([class*='size-'])]:size-4"]
    );
  });

  it("is `h-auto` and not a height of the size as a link", () => {
    expectClasses(
      <Button size="sm" variant="link">
        x
      </Button>,
      ["h-auto", "px-0", "rounded-sm", "gap-1"],
      ["h-ctl-sm", "px-2.5", "rounded-md"]
    );
  });

  it("grows from the height of its size when it wraps", () => {
    expectClasses(
      <Button size="lg" wrap>
        x
      </Button>,
      ["h-auto", "min-h-ctl-lg", "whitespace-normal", "px-4"],
      ["h-ctl-lg", "whitespace-nowrap"]
    );
    expectClasses(
      <Button>x</Button>,
      ["h-ctl-md", "whitespace-nowrap"],
      ["h-auto", "min-h-ctl-md", "whitespace-normal"]
    );
  });

  it("has the color of the ghost variant that was asked for", () => {
    expectClasses(
      <Button variant="ghost-muted">x</Button>,
      ["text-muted-foreground", "hover:bg-accent"],
      ["text-foreground", "text-destructive"]
    );
    expectClasses(
      <Button variant="ghost-destructive">x</Button>,
      ["text-destructive", "hover:bg-destructive/10"],
      ["text-foreground", "hover:bg-accent", "text-muted-foreground"]
    );
    expectClasses(
      <Button variant="ghost">x</Button>,
      ["text-foreground", "hover:bg-accent"],
      ["text-muted-foreground", "text-destructive"]
    );
  });

  it("has one type size and one disabled opacity", () => {
    expectClasses(
      <Button size="sm" text="support" variant="link">
        x
      </Button>,
      ["text-support"],
      ["text-sm", "text-xs"]
    );
    expectClasses(
      <Button size="sm" text="13" variant="link">
        x
      </Button>,
      ["text-[0.8125rem]"],
      ["text-sm", "text-support"]
    );
    expectClasses(
      <Button busy>x</Button>,
      ["disabled:opacity-70"],
      ["disabled:opacity-50"]
    );
    expectClasses(
      <Button>x</Button>,
      ["disabled:opacity-50"],
      ["disabled:opacity-70"]
    );
  });

  it("is `shrink-0` unless it gives way in a flex row", () => {
    expectClasses(<Button>x</Button>, ["shrink-0"], []);
    expectClasses(<Button shrink>x</Button>, [], ["shrink-0"]);
  });
});

describe("Badge", () => {
  it("has the border of its variant alone", () => {
    expectClasses(
      <Badge variant="warning">x</Badge>,
      ["border-warning/30"],
      ["border-transparent", "border-border"]
    );
    expectClasses(
      <Badge variant="outline">x</Badge>,
      ["border-border"],
      ["border-transparent"]
    );
    expectClasses(
      <Badge variant="ink">x</Badge>,
      ["border-transparent"],
      ["border-border"]
    );
  });

  it("is one line of 20 px, or grows from 20 px when it wraps", () => {
    expectClasses(
      <Badge>x</Badge>,
      ["h-5", "whitespace-nowrap", "leading-none"],
      ["h-auto", "min-h-5", "whitespace-normal", "leading-4"]
    );
    expectClasses(
      <Badge wrap>x</Badge>,
      ["h-auto", "min-h-5", "whitespace-normal", "leading-4"],
      ["h-5", "whitespace-nowrap", "leading-none"]
    );
  });
});

describe("Card", () => {
  it("has the gap, the padding and the tone that were asked for alone", () => {
    expectClasses(
      <Card>x</Card>,
      ["gap-(--card-spacing)", "py-(--card-spacing)", "bg-card", "shadow-xs"],
      ["gap-0", "py-0", "bg-muted/30", "shadow-none"]
    );
    expectClasses(
      <Card gap="none" pad="none">
        x
      </Card>,
      ["gap-0", "py-0"],
      ["gap-(--card-spacing)", "py-(--card-spacing)"]
    );
    expectClasses(
      <Card gap="3" pad="6">
        x
      </Card>,
      ["gap-3", "py-6"],
      ["gap-(--card-spacing)", "py-(--card-spacing)"]
    );
    expectClasses(
      <Card tone="quiet">x</Card>,
      ["bg-muted/30", "shadow-none"],
      ["bg-card", "shadow-xs"]
    );
  });

  it("lays the header out in one way alone", () => {
    expectClasses(
      <CardHeader>x</CardHeader>,
      ["grid", "items-start", "gap-0.5"],
      ["flex", "gap-3"]
    );
    expectClasses(
      <CardHeader layout="row">x</CardHeader>,
      ["flex", "items-center", "gap-3"],
      ["grid", "items-start", "gap-0.5"]
    );
    expectClasses(
      <CardHeader layout="wide-row">x</CardHeader>,
      ["flex", "gap-x-4", "gap-y-2"],
      ["grid", "items-start", "gap-0.5", "gap-3"]
    );
    expectClasses(
      <CardHeader layout="action">x</CardHeader>,
      ["grid", "items-center", "grid-cols-[minmax(0,1fr)_auto]"],
      ["items-start", "flex"]
    );
  });
});

describe("Alert", () => {
  it("has the ground and the text color of its variant alone", () => {
    expectClasses(
      <Alert variant="muted">x</Alert>,
      ["bg-muted/60", "text-foreground"],
      ["bg-card", "text-card-foreground"]
    );
    expectClasses(
      <Alert variant="outline">x</Alert>,
      ["border-foreground/15", "bg-card", "text-foreground"],
      ["text-card-foreground", "bg-muted/60"]
    );
    expectClasses(
      <Alert>x</Alert>,
      ["bg-card", "text-card-foreground"],
      ["bg-muted/60", "text-foreground"]
    );
  });

  it("has the tone, the size and the paragraph space of the description alone", () => {
    expectClasses(
      <AlertDescription tone="foreground">x</AlertDescription>,
      ["text-foreground", "text-support"],
      ["text-muted-foreground"]
    );
    expectClasses(
      <AlertDescription size="reading">x</AlertDescription>,
      ["text-sm/5", "touch:text-base/6", "text-muted-foreground"],
      ["text-support"]
    );
    expectClasses(
      <AlertDescription paragraphs="tight">x</AlertDescription>,
      ["[&_p:not(:last-child)]:mb-0"],
      ["[&_p:not(:last-child)]:mb-4"]
    );
    expectClasses(
      <AlertDescription>x</AlertDescription>,
      ["[&_p:not(:last-child)]:mb-4", "text-muted-foreground", "text-support"],
      ["[&_p:not(:last-child)]:mb-0", "text-foreground"]
    );
  });
});

describe("Field and its parts", () => {
  it("has one width, one gap and one alignment", () => {
    expectClasses(
      <Field>x</Field>,
      ["w-full", "gap-1.5", "flex-col"],
      ["w-auto", "gap-4", "items-center", "items-start"]
    );
    expectClasses(<Field width="auto">x</Field>, ["w-auto"], ["w-full"]);
    expectClasses(
      <Field align="start" gap="wide" orientation="horizontal">
        x
      </Field>,
      ["items-start", "gap-4", "flex-row"],
      ["items-center", "gap-1.5"]
    );
    expectClasses(
      <Field orientation="horizontal">x</Field>,
      ["items-center", "gap-1.5"],
      ["items-start", "gap-4"]
    );
  });

  it("has one space under the legend and one gap in the set", () => {
    expectClasses(<FieldLegend>x</FieldLegend>, ["mb-1.5"], ["mb-0", "mb-3"]);
    expectClasses(
      <FieldLegend space="none">x</FieldLegend>,
      ["mb-0"],
      ["mb-1.5", "mb-3"]
    );
    expectClasses(
      <FieldLegend space="loose">x</FieldLegend>,
      ["mb-3"],
      ["mb-1.5", "mb-0"]
    );
    expectClasses(<FieldSet>x</FieldSet>, ["gap-4"], ["gap-3"]);
    expectClasses(<FieldSet gap="3">x</FieldSet>, ["gap-3"], ["gap-4"]);
  });

  it("has one display, one weight and one leading in the label", () => {
    expectClasses(
      <Label>x</Label>,
      ["flex", "font-medium", "leading-5"],
      ["block", "font-normal", "leading-snug"]
    );
    expectClasses(
      <FieldLabel>x</FieldLabel>,
      ["flex", "font-medium", "leading-snug", "w-fit"],
      ["block", "font-normal", "leading-5"]
    );
    expectClasses(
      <FieldLabel plain>x</FieldLabel>,
      ["block", "font-normal", "leading-5", "w-fit"],
      ["flex", "font-medium", "leading-snug"]
    );
  });
});

describe("InputGroup and Input", () => {
  it("has one shape, one width and one surface", () => {
    expectClasses(
      <InputGroup />,
      ["h-ctl-md", "items-center", "w-full", "min-w-0", "dark:bg-input/30"],
      ["h-auto", "items-stretch", "w-auto", "bg-card"]
    );
    expectClasses(
      <InputGroup shape="area" />,
      ["h-auto", "items-stretch"],
      ["h-ctl-md", "items-center"]
    );
    expectClasses(<InputGroup width="16" />, ["w-16", "min-w-0"], ["w-full"]);
    expectClasses(
      <InputGroup surface="raised" width="auto-40" />,
      ["w-auto", "min-w-40", "bg-card", "shadow-xs", "dark:bg-secondary/60"],
      ["w-full", "min-w-0", "dark:bg-input/30"]
    );
  });

  it("gives the width of the field to the group", () => {
    expectClasses(<Input width="20" />, ["w-20"], ["w-full"]);
  });

  it("has one space beside the text of the control", () => {
    expectClasses(<InputGroupInput />, ["px-3"], ["px-1"]);
    expectClasses(<InputGroupInput inset="tight" />, ["px-1"], ["px-3"]);
  });
});

describe("Select, ButtonGroup, Progress, Skeleton and Table", () => {
  it("has one width in the select trigger", () => {
    expectClasses(
      <Select>
        <SelectTrigger>x</SelectTrigger>
      </Select>,
      ["w-fit"],
      ["w-full"]
    );
    expectClasses(
      <Select>
        <SelectTrigger width="full">x</SelectTrigger>
      </Select>,
      ["w-full"],
      ["w-fit"]
    );
  });

  it("has one width in the button group", () => {
    expectClasses(<ButtonGroup />, ["w-fit"], ["w-full", "w-auto"]);
    expectClasses(<ButtonGroup width="full" />, ["w-full"], ["w-fit"]);
    expectClasses(<ButtonGroup width="auto" />, ["w-auto"], ["w-fit"]);
  });

  it("has one gap in the progress and one color in its value", () => {
    expectClasses(<Progress value={10} />, ["gap-3"], ["gap-1.5"]);
    expectClasses(<Progress gap="1.5" value={10} />, ["gap-1.5"], ["gap-3"]);
    expectClasses(
      <Progress value={10}>
        <ProgressValue />
      </Progress>,
      ["text-muted-foreground"],
      ["text-foreground"],
      "progress-value"
    );
    expectClasses(
      <Progress value={10}>
        <ProgressValue tone="foreground" />
      </Progress>,
      ["text-foreground"],
      ["text-muted-foreground"],
      "progress-value"
    );
  });

  it("has one radius in the skeleton", () => {
    expectClasses(<Skeleton />, ["rounded-md"], ["rounded-full"]);
    expectClasses(<Skeleton circle />, ["rounded-full"], ["rounded-md"]);
  });

  it("has one alignment, one vertical alignment and one hover in the table", () => {
    expectClasses(
      <TableHead />,
      ["text-left", "h-9", "whitespace-nowrap", "align-middle", "text-xs"],
      ["text-right", "h-auto", "whitespace-normal", "align-top", "text-sm"]
    );
    expectClasses(<TableHead align="right" />, ["text-right"], ["text-left"]);
    expectClasses(
      <TableHead variant="row" />,
      [
        "h-auto",
        "whitespace-normal",
        "align-top",
        "text-foreground",
        "text-sm",
      ],
      [
        "h-9",
        "whitespace-nowrap",
        "align-middle",
        "text-xs",
        "text-muted-foreground",
      ]
    );
    expectClasses(<TableCell />, ["align-middle"], ["align-top"]);
    expectClasses(
      <TableCell vertical="top" />,
      ["align-top"],
      ["align-middle"]
    );
    expectClasses(
      <TableRow />,
      ["hover:bg-muted/60"],
      ["hover:bg-transparent"]
    );
    expectClasses(
      <TableRow hover={false} />,
      ["hover:bg-transparent"],
      ["hover:bg-muted/60"]
    );
  });
});

const MAX_WIDTH = /(?:^|\s)(?:sm:)?max-w-\S+/g;
const WIDTH = /(?:^|\s)w-\S+/g;
const MIN_WIDTH = /(?:^|\s)min-w-\S+/g;

describe("Dialog and menu widths (their popups open in a portal, so the table of widths is read)", () => {
  it("has one maximum width per size of the dialog", () => {
    expect(dialogWidth.sm.match(MAX_WIDTH)).toHaveLength(1);
    expect(dialogWidth.md.match(MAX_WIDTH)).toHaveLength(1);
    expect(dialogWidth.md).toBe("sm:max-w-md");
    expect(dialogWidth.sm).toBe("sm:max-w-sm");
  });

  it("has one width and one minimum width per width of the menu", () => {
    for (const value of Object.values(menuContentWidth)) {
      expect(value.match(WIDTH)).toHaveLength(1);
      expect(value.match(MIN_WIDTH)).toHaveLength(1);
    }
    expect(menuContentWidth.wide).toContain("min-w-44");
    expect(menuContentWidth.fixed).toContain("w-40");
  });
});

/** The folders and files of `apps/web` that the build and the checks read; `node_modules` and the builds are not. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (["node_modules", "dist", ".wrangler", "test-results"].includes(name)) {
      return [];
    }
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : [path].filter((file) => SOURCE_FILE.test(file));
  });
}

const IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']tailwind-merge["']/;
const SOURCE_FILE = /\.(?:tsx?|mjs|json)$/;

describe("no tailwind-merge in apps/web", () => {
  const web = join(import.meta.dirname, "..", "..");
  it("imports it nowhere (the build refuses it too: `tailwindMergeProblems`)", () => {
    const offenders = sourceFiles(web)
      .filter((file) => IMPORT.test(readFileSync(file, "utf8")))
      .map((file) => relative(web, file));
    expect(offenders).toEqual([]);
  });

  it("is not a dependency of the app", () => {
    const manifest = JSON.parse(
      readFileSync(join(web, "package.json"), "utf8")
    ) as Record<string, Record<string, string> | undefined>;
    for (const group of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      expect(Object.keys(manifest[group] ?? {})).not.toContain(
        "tailwind-merge"
      );
    }
  });
});
