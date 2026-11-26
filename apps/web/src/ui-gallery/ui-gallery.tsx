import ChartColumnIcon from "lucide-react/dist/esm/icons/chart-column";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import MinusIcon from "lucide-react/dist/esm/icons/minus";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import ShoppingBagIcon from "lucide-react/dist/esm/icons/shopping-bag";
import SparklesIcon from "lucide-react/dist/esm/icons/sparkles";
import StoreIcon from "lucide-react/dist/esm/icons/store";
import TagIcon from "lucide-react/dist/esm/icons/tag";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import UsersIcon from "lucide-react/dist/esm/icons/users";
import WalletIcon from "lucide-react/dist/esm/icons/wallet";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { ActionStrip } from "@/ui/action-strip";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { AnimatedFigure } from "@/ui/animated-figure";
import { Badge } from "@/ui/badge";
import {
  Block,
  BlockFooter,
  BlockLink,
  BlockPanel,
  BlockHeader as FramedBlockHeader,
} from "@/ui/block";
import { BlockHeader } from "@/ui/block-header";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import { OnDemandCalendar } from "@/ui/calendar-on-demand";
import {
  Card,
  CardContent,
  CardDescription,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  CardFrameLink,
  CardFramePanel,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { OnDemandRingChart, OnDemandSparkline } from "@/ui/charts/on-demand";
import { CheckableOption } from "@/ui/checkable-option";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxFooter,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/ui/combobox";
import { DatePicker } from "@/ui/date-picker";
import { DateRangePicker } from "@/ui/date-range-picker";
import {
  type DateRange,
  type IsoDate,
  parseIsoDate,
  toIsoDate,
} from "@/ui/date-values";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/ui/empty";
import { EmptyState } from "@/ui/empty-state";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/ui/field";
import { FieldGroup } from "@/ui/field-group";
import { Figure } from "@/ui/figure";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import { HelpTip } from "@/ui/help-tip";
import { HideValuesButton, MoneyText } from "@/ui/hidden-values";
import { Input } from "@/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from "@/ui/input-group";
import { InsetBlock } from "@/ui/inset-block";
import { DeltaChip, HeroPercent, HeroValue, KpiTile } from "@/ui/kpi-card";
import { Label } from "@/ui/label";
import { ListBlock } from "@/ui/list-block";
import { ListNotice } from "@/ui/list-notice";
import { ListTotalFooter } from "@/ui/list-total-footer";
import { Logo } from "@/ui/logo";
import { Money } from "@/ui/money";
import { PaceLine, type PaceState } from "@/ui/pace-line";
import { PlanCard } from "@/ui/plan-card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/ui/popover";
import { Progress, ProgressLabel, ProgressValue } from "@/ui/progress";
import { ProgressRing } from "@/ui/progress-ring";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { RefreshButton } from "@/ui/refresh-button";
import { RowTile } from "@/ui/row-tile";
import { ScrollArea } from "@/ui/scroll-area";
import { SearchField } from "@/ui/search-field";
import { SectionTabs } from "@/ui/section-tabs";
import { SegmentedFilter } from "@/ui/segmented-filter";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { Separator } from "@/ui/separator";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/ui/sidebar";
import { Skeleton } from "@/ui/skeleton";
import { SkeletonArt, type SkeletonArtKind } from "@/ui/skeleton-art";
import { StepTile } from "@/ui/step-tile";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { TextLink } from "@/ui/text-link";
import { Textarea } from "@/ui/textarea";
import { ThemeSegmented } from "@/ui/theme-segmented";
import { ThemeSwitch } from "@/ui/theme-switch";
import { Thumbnail, type ThumbnailSize } from "@/ui/thumbnail";
import { ToastProvider, toastManager } from "@/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";
import { ChartStates } from "./chart-states";

/**
 * Every interface primitive of src/ui/ on one page, for the browser checks (ADR 0103, condition 2): each one
 * opens here under the shell's CSP, in both themes. Never in the production build (see main.tsx) and no
 * screen uses it. Synthetic text only. The last section has the characters of the Portuguese text the app
 * shows (accents and symbols), in each font face, so a face that were inlined as `data:` would show up.
 */
const METHODS = [
  { label: "Dinheiro", value: "dinheiro" },
  { label: "Pix", value: "pix" },
  { label: "Cartão de crédito", value: "credito" },
  { label: "Cartão de débito", value: "debito" },
];

const PROFILES = [
  { label: "Sem perfil", value: "sem-perfil" },
  { label: "Maquininha balcão", value: "maquininha" },
];

const FONT_SAMPLE = [
  "áàâãä éêë íï óôõö úü ç ñ ÁÀÂÃÄ ÉÊË ÍÏ ÓÔÕÖ ÚÜ Ç Ñ",
  "R$ 1.234,56 · 12% · nº 3 · 1ª · 2º · 25 °C · § 4",
  "“aspas” ‘simples’ «angulares» — travessão – meia-risca … reticências • ponto",
  "× ÷ ± ½ ¼ ¾ € £ © ® ™ → ↑ ↓ − ∕ ‰ ′ ″",
  "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz",
];

const SALE_METHODS = [
  { label: "Pix", value: "pix" },
  { label: "Dinheiro", value: "dinheiro" },
  { label: "Crédito", value: "credito" },
  { label: "Débito", value: "debito" },
  { label: "Transferência", value: "transferencia" },
  { label: "Outro", value: "outro" },
];

const GROUP_ACTIONS = [
  { Icon: PlusIcon, name: "Aumentar" },
  { Icon: MinusIcon, name: "Diminuir" },
  { Icon: CheckIcon, name: "Confirmar" },
] as const;

const LONG_LIST = Array.from(
  { length: 40 },
  (_, index) => `Movimento de estoque ${index + 1}`
);

/** The state filter of a list: the strip of the tabs with no panel; the list below is the screen's. */
function GallerySegmentedFilter() {
  const [state, setState] = useState<"active" | "archived">("active");
  const [status, setStatus] = useState<"active" | "voided">("active");
  const [rows, setRows] = useState("all");
  return (
    <div className="grid gap-4">
      <SegmentedFilter
        label="Estado dos produtos"
        onSelect={setState}
        options={[
          ["active", "Ativos"],
          ["archived", "Arquivados"],
        ]}
        value={state}
      />
      <SegmentedFilter
        compact
        label="Situação"
        onSelect={setStatus}
        options={[
          ["active", "Ativas"],
          ["voided", "Anuladas"],
        ]}
        value={status}
      />
      <div className="w-60 max-w-full">
        <SegmentedFilter
          label="Linhas do arquivo"
          onSelect={setRows}
          options={[
            ["all", "Todas (9)"],
            ["error", "Com erro (1)"],
            ["exists", "Já existem (2)"],
            ["no_category", "Sem categoria (1)"],
            ["over_limit", "Fora do limite (3)"],
          ]}
          value={rows}
        />
      </div>
    </div>
  );
}

/** The search box of the lists, with text so that "Limpar busca" shows; it empties and gives the focus back. */
function GallerySearch() {
  const [text, setText] = useState("Camiseta");
  return (
    <SearchField
      label="Buscar produto"
      onValueChange={setText}
      placeholder="Nome do produto"
      value={text}
    />
  );
}

const GALLERY_VARIANTS = [
  { detail: "Saldo 6 · SKU CAM-P", id: "preta", label: "Camiseta · Preta" },
  { detail: "Saldo 0", id: "branca", label: "Camiseta · Branca" },
  { detail: "Saldo 14", id: "caneca", label: "Caneca esmaltada" },
] as const;
type GalleryVariant = (typeof GALLERY_VARIANTS)[number];
const galleryVariantLabel = (item: GalleryVariant) => item.label;

/** The search of the sale: suggestions in a popup anchored to the field, the chosen one marked. */
function GalleryCombobox() {
  const [chosen, setChosen] = useState<GalleryVariant | null>(
    GALLERY_VARIANTS[0]
  );
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div className="grid max-w-sm gap-1.5">
      <Label htmlFor="galeria-variante">Produto ou variante</Label>
      <Combobox
        items={[...GALLERY_VARIANTS]}
        itemToStringLabel={galleryVariantLabel}
        onValueChange={setChosen}
        value={chosen}
      >
        <InputGroup ref={anchor}>
          <ComboboxInput
            id="galeria-variante"
            placeholder="Buscar por nome, variante ou SKU"
          />
        </InputGroup>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>Nenhuma variante encontrada.</ComboboxEmpty>
          <ComboboxList aria-label="Variantes encontradas">
            {(item: GalleryVariant) => (
              <ComboboxItem key={item.id} value={item}>
                <span className="font-medium">{item.label}</span>
                <span className="text-muted-foreground text-support">
                  {item.detail}
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxFooter>Digite para refinar a busca.</ComboboxFooter>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}

function showToast() {
  toastManager.add({
    description: "O comprovante está no histórico.",
    title: "Venda registrada",
    type: "success",
  });
}

/** The accumulated sales of a month, sample data for the KPI card of the gallery. */
const GALLERY_KPI_SERIES = [
  120, 180, 180, 260, 410, 410, 520, 690, 760, 760, 880, 1010, 1200, 1340,
] as const;

const PACE_WORDS: Record<PaceState, string> = {
  ahead: "Adiantada",
  behind: "Atrasada",
  on_pace: "No ritmo",
};

/** Where the mark of the pace stands in the examples: 60% of the period is over. */
const PACE_MARKER = 60;

const PACE_EXAMPLES: readonly {
  color: "var(--chart-result)" | "var(--chart-sales)";
  progress: number;
  state: PaceState;
  track: string;
}[] = [
  {
    color: "var(--chart-sales)",
    progress: 20,
    state: "behind",
    track: "var(--chart-heat-1)",
  },
  {
    color: "var(--chart-sales)",
    progress: 60,
    state: "on_pace",
    track: "var(--chart-heat-1)",
  },
  {
    color: "var(--chart-sales)",
    progress: 100,
    state: "ahead",
    track: "var(--chart-heat-1)",
  },
  {
    color: "var(--chart-result)",
    progress: 20,
    state: "behind",
    track: "color-mix(in oklch, var(--chart-result) 18%, var(--card))",
  },
  {
    color: "var(--chart-result)",
    progress: 60,
    state: "on_pace",
    track: "color-mix(in oklch, var(--chart-result) 18%, var(--card))",
  },
  {
    color: "var(--chart-result)",
    progress: 100,
    state: "ahead",
    track: "color-mix(in oklch, var(--chart-result) 18%, var(--card))",
  },
];

/** The mark of the pace on the ring and on the bar, in the three states and in both entity colors. */
function PaceExamples() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {PACE_EXAMPLES.map((example) => (
        <li
          className="grid gap-2 rounded-lg p-3 ring-1 ring-foreground/[0.06]"
          data-pace-example={`${example.state}-${example.progress}`}
          key={`${example.color}-${example.progress}`}
        >
          <div className="flex items-center gap-4">
            <div
              aria-label={`${example.progress}% da meta. ${PACE_WORDS[example.state]}: o esperado até hoje era ${PACE_MARKER}%.`}
              className="relative size-28 shrink-0"
              role="img"
            >
              <OnDemandRingChart
                color={example.color}
                marker={PACE_MARKER / 100}
                progress={example.progress / 100}
                size={112}
                strokeWidth={10}
                track={example.track}
              />
            </div>
            <PaceLine label={PACE_WORDS[example.state]} state={example.state} />
          </div>
          <Progress
            aria-label="Progresso da meta"
            aria-valuetext={`${example.progress}%. ${PACE_WORDS[example.state]}: o esperado até hoje era ${PACE_MARKER}%.`}
            marker={PACE_MARKER}
            value={example.progress}
          >
            <ProgressLabel>Meta de vendas</ProgressLabel>
            <ProgressValue />
          </Progress>
        </li>
      ))}
    </ul>
  );
}

const SKELETON_ART_SAMPLES: readonly {
  caption: string;
  kind: SkeletonArtKind;
}[] = [
  {
    caption: "Lista de produtos: Primeiros passos e vazio de Produtos.",
    kind: "products",
  },
  {
    caption: "Tela de venda: Primeiros passos e Venda sem produto.",
    kind: "sale",
  },
  { caption: "Início com números: página não encontrada.", kind: "home" },
];

/** The block of the Início as `HomeBlock` composes it out of the frame pieces: the reference `Block` is measured against. */
function ReferenceBlock({ id }: { id: string }) {
  return (
    <CardFrame
      aria-labelledby={id}
      className="min-w-0"
      data-gallery-block="reference"
      role="region"
    >
      <CardFrameHeader>
        <BlockHeader
          action={<p className="text-support">Ação</p>}
          className="md:flex-nowrap"
          id={id}
          title="Bloco do Início"
        />
      </CardFrameHeader>
      <CardFramePanel>
        <p className="text-muted-foreground">O painel guarda o conteúdo.</p>
      </CardFramePanel>
      <CardFrameFooter>
        <CardFrameLink href="/dashboard">Ver o resultado</CardFrameLink>
      </CardFrameFooter>
    </CardFrame>
  );
}

function BlockExample({ id }: { id: string }) {
  return (
    <Block aria-labelledby={id} className="min-w-0" data-gallery-block="block">
      <FramedBlockHeader
        action={<p className="text-support">Ação</p>}
        id={id}
        title="Bloco do Início"
      />
      <BlockPanel>
        <p className="text-muted-foreground">O painel guarda o conteúdo.</p>
      </BlockPanel>
      <BlockFooter>
        <BlockLink href="/dashboard">Ver o resultado</BlockLink>
      </BlockFooter>
    </Block>
  );
}

const LIST_ROWS = [
  { name: "Camiseta lisa", support: "12 em estoque", value: "R$ 59,90" },
  { name: "Boné de aba reta", support: "4 em estoque", value: "R$ 39,90" },
  { name: "Meia esportiva", support: "30 em estoque", value: "R$ 12,00" },
] as const;

const WIDE_ROW = "min-w-[40rem]";

function ListRowShape({ wide }: { wide: boolean }) {
  return (
    <div className={cn("flex items-center gap-3", wide && WIDE_ROW)}>
      <Skeleton className="size-9 shrink-0 rounded-md" />
      <div className="grid flex-1 gap-1.5">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3.5 w-1/3" />
      </div>
      <Skeleton className="h-4 w-16 shrink-0" />
    </div>
  );
}

const LIST_COUNTS = {
  "filtered-empty": "0 produtos",
  loading: "",
  rows: "3 produtos",
} as const;

/** One `ListBlock` of the gallery: a state, with or without the total, and the wide table that scrolls inside the panel. */
function ListBlockExample({
  state,
  title,
  total,
  wide = false,
}: {
  state: "rows" | "loading" | "filtered-empty";
  title: string;
  total: boolean;
  wide?: boolean;
}) {
  const sized = wide ? WIDE_ROW : undefined;
  return (
    <ListBlock
      action={
        <Button size="sm" variant="outline">
          Exportar
        </Button>
      }
      className={wide ? "lg:col-span-2" : undefined}
      count={LIST_COUNTS[state]}
      emptyNotice={<p>Nenhum produto com essa busca.</p>}
      skeleton={<ListRowShape wide={wide} />}
      state={state}
      title={title}
    >
      <ListBlock.Header className={sized}>
        <span className="min-w-0 flex-1">Produto</span>
        <span className="shrink-0">Preço</span>
      </ListBlock.Header>
      {LIST_ROWS.map((row) => (
        <ListBlock.Row
          className={sized}
          key={row.name}
          tile={<ShoppingBagIcon />}
        >
          <div className="grid min-w-0 flex-1 gap-0.5">
            <p className="font-medium">{row.name}</p>
            <p className="text-muted-foreground text-support">{row.support}</p>
          </div>
          <p className="shrink-0 font-semibold">
            <MoneyText text={row.value} />
          </p>
          {wide ? (
            <Button size="sm" variant="ghost">
              Editar
            </Button>
          ) : null}
        </ListBlock.Row>
      ))}
      {total ? (
        <ListBlock.Total
          className={sized}
          count={LIST_COUNTS[state] || "Lendo…"}
          value={state === "rows" ? "R$ 111,80" : "R$ 0,00"}
          valueLoading={state === "loading"}
        />
      ) : null}
    </ListBlock>
  );
}

const LONG_OPTION =
  "Uma combinação com um nome bem comprido, para provar que o texto quebra dentro da borda e não passa dela";

const OPTION_NAMES = [
  "Azul / P",
  "Azul / M",
  "Vermelho / M",
  LONG_OPTION,
] as const;

/** The options of the image of a product, as the tab "Imagens" lists them: each one on its own, two of them off (unmarked and marked). */
function CheckableOptionExamples() {
  const [marked, setMarked] = useState<string[]>(["Azul / M"]);
  const toggle = useCallback(
    (name: string) =>
      setMarked((current) =>
        current.includes(name)
          ? current.filter((item) => item !== name)
          : [...current, name]
      ),
    []
  );
  return (
    <div className="grid gap-2">
      {OPTION_NAMES.map((name) => (
        <GalleryOption
          checked={marked.includes(name)}
          key={name}
          name={name}
          onToggle={toggle}
        />
      ))}
      <GalleryOption
        checked={false}
        disabled
        name="Desligada, sem imagem para enviar"
      />
      <GalleryOption
        checked
        disabled
        name="Desligada e marcada, durante o envio"
      />
    </div>
  );
}

function GalleryOption({
  checked,
  disabled,
  name,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  name: string;
  onToggle?: (name: string) => void;
}) {
  const handleChange = useCallback(() => onToggle?.(name), [name, onToggle]);
  return (
    <CheckableOption
      checked={checked}
      disabled={disabled}
      onCheckedChange={handleChange}
    >
      {name}
    </CheckableOption>
  );
}

const LOOSE_BOXES = [
  { checked: false, disabled: false, name: "Solta, ligada, desmarcada" },
  { checked: true, disabled: false, name: "Solta, ligada, marcada" },
  { checked: false, disabled: true, name: "Solta, desligada, desmarcada" },
  { checked: true, disabled: true, name: "Solta, desligada, marcada" },
] as const;

/** The check box, the radio and the switch off: each root is a span, so they fade through `data-disabled`, once and never inside a faded card or field. */
function DisabledControlExamples() {
  return (
    <div className="grid items-start gap-4 md:grid-cols-2">
      <div className="grid gap-8" data-gallery-panel="loose-boxes">
        {LOOSE_BOXES.map((box) => (
          <div className="flex items-center gap-2" key={box.name}>
            <Checkbox
              aria-label={box.name}
              defaultChecked={box.checked}
              disabled={box.disabled}
            />
            <span aria-hidden="true">{box.name}</span>
          </div>
        ))}
        <Field data-disabled="true" orientation="horizontal">
          <Checkbox
            aria-describedby="galeria-campo-desligado-ajuda"
            defaultChecked
            disabled
            id="galeria-campo-desligado"
          />
          <FieldContent>
            <FieldLabel htmlFor="galeria-campo-desligado">
              Dentro de um campo desligado
            </FieldLabel>
            <FieldDescription id="galeria-campo-desligado-ajuda">
              O campo apaga o texto; a caixa apaga uma vez só.
            </FieldDescription>
          </FieldContent>
        </Field>
      </div>
      <div className="grid gap-5" data-gallery-panel="off-choices">
        <RadioGroup
          aria-label="Forma desligada"
          defaultValue="pix"
          disabled
          name="galeria-forma-desligada"
        >
          <FieldLabel htmlFor="galeria-forma-desligada-pix">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>Cartão desligado</FieldTitle>
              </FieldContent>
              <RadioGroupItem id="galeria-forma-desligada-pix" value="pix" />
            </Field>
          </FieldLabel>
        </RadioGroup>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="galeria-chave-desligada">
              Chave desligada
            </FieldLabel>
          </FieldContent>
          <Switch defaultChecked disabled id="galeria-chave-desligada" />
        </Field>
        <div className="grid gap-8">
          <Label>
            <Checkbox defaultChecked disabled />
            Caixa dentro do rótulo
          </Label>
          <Label>
            <Switch defaultChecked disabled />
            Chave dentro do rótulo
          </Label>
        </div>
      </div>
    </div>
  );
}

const STEP_EXAMPLES = [
  { Icon: StoreIcon, label: "Loja criada", state: "done" },
  { Icon: TagIcon, label: "Cadastrar o 1º produto", state: "current" },
  { Icon: ShoppingBagIcon, label: "Fazer a 1ª venda", state: "todo" },
] as const;

function StepTileExamples() {
  return (
    <ol className="grid gap-2">
      {STEP_EXAMPLES.map(({ Icon, label, state }) => (
        <li
          aria-current={state === "current" ? "step" : undefined}
          className="flex items-center gap-2.5"
          key={state}
        >
          <StepTile state={state}>
            <Icon />
          </StepTile>
          <span>
            {label}
            {state === "done" ? (
              <span className="sr-only"> (feito)</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlainBlockExamples() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Block
        action={
          <Button size="sm" variant="outline">
            Imprimir
          </Button>
        }
        description="Pago em 2 vezes, no cartão."
        title="Comprovante"
        variant="plain"
      >
        <p className="text-muted-foreground">O corpo do bloco.</p>
      </Block>
      <Block variant="plain">
        <p className="text-muted-foreground">O mesmo bloco sem título.</p>
      </Block>
    </div>
  );
}

const LOCAL_TABS = [
  {
    content: <p className="text-muted-foreground">Painel da aba Dados.</p>,
    label: "Dados",
    value: "dados",
  },
  {
    content: <p className="text-muted-foreground">Painel da aba Ajustes.</p>,
    label: "Ajustes",
    value: "ajustes",
  },
] as const;

const ROUTED_TABS = [
  { label: "Resultado", value: "resultado" },
  { label: "Metas", value: "metas" },
] as const;

const ROUTED_PARAMETER = "aba-galeria";

/** The open tab in the address (`?aba-galeria=`), as a screen keeps its own: the tab belongs to the caller. */
function RoutedSectionTabsExample() {
  const [value, setValue] = useState(() => {
    const named = new URLSearchParams(window.location.search).get(
      ROUTED_PARAMETER
    );
    return ROUTED_TABS.some((tab) => tab.value === named)
      ? (named as string)
      : "resultado";
  });
  const select = useCallback((next: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set(ROUTED_PARAMETER, next);
    window.history.replaceState(window.history.state, "", url);
    setValue(next);
  }, []);
  return (
    <SectionTabs
      label="Abas com rota"
      onValueChange={select}
      tabs={ROUTED_TABS}
      value={value}
    >
      <TabsContent className="text-muted-foreground" value="resultado">
        Painel da aba Resultado.
      </TabsContent>
      <TabsContent className="text-muted-foreground" value="metas">
        Painel da aba Metas.
      </TabsContent>
    </SectionTabs>
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/[0.06]"
    >
      <h2 className="text-section">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The thumbnail of a product (`@/ui/thumbnail`, used by `ProductThumbnail` of the catalog) in the states a list will
 * show, at 40 px (Produtos, Estoque) and 32 px (Venda). The states differ in where the picture comes from (the cache,
 * the network, nothing); for the box they are a picture or the marker ("Erro" is the marker: bytes that do not
 * decode are proved in e2e/offline-thumbnails.e2e.ts, outside the shell's CSP, where Chrome reports their blob URL
 * under `connect-src`). Plus a very wide and a very tall picture, for the crop. The pictures are drawn here in the
 * chart tokens. Synthetic only.
 */
const THUMBNAIL_STATES = [
  { key: "cache", label: "Em cache", picture: [320, 320] },
  { key: "sem-imagem", label: "Sem imagem", picture: null },
  { key: "carregando", label: "Carregando", picture: null },
  { key: "erro", label: "Erro", picture: null },
  { key: "offline-cache", label: "Offline com cache", picture: [320, 320] },
  { key: "offline-vazio", label: "Offline sem cache", picture: null },
  { key: "larga", label: "Foto larga (1200×300)", picture: [1200, 300] },
  { key: "alta", label: "Foto alta (300×1200)", picture: [300, 1200] },
] as const;

type ThumbnailPicture = (typeof THUMBNAIL_STATES)[number]["picture"];

function drawPicture(picture: ThumbnailPicture): Promise<Blob | null> {
  if (picture === null) {
    return Promise.resolve(null);
  }
  const [width, height] = picture;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return Promise.resolve(null);
  }
  const token = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  context.fillStyle = token("--chart-1");
  context.fillRect(0, 0, width, height / 2);
  context.fillStyle = token("--chart-2");
  context.fillRect(0, height / 2, width, height / 2);
  context.fillStyle = token("--chart-4");
  context.beginPath();
  context.arc(
    width / 2,
    height / 2,
    Math.min(width, height) / 3,
    0,
    Math.PI * 2
  );
  context.fill();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp"));
}

function ThumbnailCell({
  picture,
  size,
}: {
  picture: ThumbnailPicture;
  size: ThumbnailSize;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let current = true;
    drawPicture(picture).then((blob) => {
      if (current && blob) {
        url = URL.createObjectURL(blob);
        setSrc(url);
      }
    });
    return () => {
      current = false;
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [picture]);
  return <Thumbnail marker="CA" size={size} src={src} />;
}

function ThumbnailStates() {
  return (
    <Section title="Miniatura do produto">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {THUMBNAIL_STATES.map((state) => (
          <li
            className="grid justify-items-start gap-2"
            data-testid={`miniatura-${state.key}`}
            key={state.key}
          >
            <span className="flex items-center gap-3">
              <ThumbnailCell picture={state.picture} size={40} />
              <ThumbnailCell picture={state.picture} size={32} />
            </span>
            <span className="text-muted-foreground text-support">
              {state.label}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The date pickers, as a screen uses them: the month grid alone, one date (empty, chosen, limited to today, with
 * its error) and a period. "Hoje" is fixed at `24/10/2026`, so the browser checks and the captures see the same month on
 * any day. The calendar comes through the on-demand loader, as in the app.
 */
const TODAY = "2026-10-24";
const TODAY_DATE = parseIsoDate(TODAY) as Date;

function InlineCalendar() {
  const [day, setDay] = useState<Date | undefined>(parseIsoDate("2026-10-20"));
  return (
    <div className="grid w-fit gap-2">
      <div className="w-fit rounded-lg p-2 ring-1 ring-foreground/[0.06]">
        <OnDemandCalendar
          aria-label="Calendário de exemplo"
          // inside the section and its frame (6.5 rem of padding at 360 px) the week still fits the window
          className="touch:[--cell-size:min(2.75rem,calc((100vw_-_6.5rem)/7))]"
          defaultMonth={TODAY_DATE}
          disabled={{ after: TODAY_DATE }}
          disabledReason="Só até hoje"
          mode="single"
          onSelect={setDay}
          selected={day}
          today={TODAY_DATE}
        />
      </div>
      <p
        className="text-muted-foreground text-support"
        data-testid="calendario-escolhido"
      >
        {day ? `Escolhido: ${toIsoDate(day)}` : "Nenhum dia escolhido"}
      </p>
    </div>
  );
}

function DatePickerStates() {
  const [empty, setEmpty] = useState<IsoDate | null>(null);
  const [chosen, setChosen] = useState<IsoDate | null>("2026-10-24");
  const [limited, setLimited] = useState<IsoDate | null>(null);
  const [upcoming, setUpcoming] = useState<IsoDate | null>(null);
  const [required, setRequired] = useState<IsoDate | null>(null);
  const [period, setPeriod] = useState<DateRange | null>({
    from: "2026-10-01",
    to: TODAY,
  });
  const [emptyPeriod, setEmptyPeriod] = useState<DateRange | null>(null);
  return (
    <>
      <Section title="Calendário">
        <InlineCalendar />
      </Section>

      <Section title="Data">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="galeria-data-vazia">
              Data da despesa
            </FieldLabel>
            <DatePicker
              id="galeria-data-vazia"
              label="Data da despesa"
              onValueChange={setEmpty}
              today={TODAY}
              value={empty}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="galeria-data-escolhida">
              Data de competência
            </FieldLabel>
            <DatePicker
              id="galeria-data-escolhida"
              label="Data de competência"
              onValueChange={setChosen}
              today={TODAY}
              value={chosen}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="galeria-data-limite">
              Data do pagamento
            </FieldLabel>
            <DatePicker
              disabledReason="Só até hoje"
              id="galeria-data-limite"
              label="Data do pagamento"
              max={TODAY}
              min="2026-10-05"
              onValueChange={setLimited}
              today={TODAY}
              value={limited}
            />
            <FieldDescription>De 05/10 até hoje.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="galeria-data-futura">
              Data de entrega
            </FieldLabel>
            <DatePicker
              disabledReason="Só depois de hoje"
              id="galeria-data-futura"
              label="Data de entrega"
              min="2026-10-25"
              onValueChange={setUpcoming}
              today={TODAY}
              value={upcoming}
            />
            <FieldDescription>A partir de amanhã.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="galeria-data-erro">Vencimento</FieldLabel>
            <DatePicker
              error={required === null}
              id="galeria-data-erro"
              label="Vencimento"
              onValueChange={setRequired}
              today={TODAY}
              value={required}
            />
          </Field>
        </div>
      </Section>

      <Section title="Período">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="galeria-periodo">Período</FieldLabel>
            <DateRangePicker
              endsToday
              id="galeria-periodo"
              label="Período"
              onValueChange={setPeriod}
              today={TODAY}
              value={period}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="galeria-periodo-vazio">
              Período das vendas
            </FieldLabel>
            <DateRangePicker
              id="galeria-periodo-vazio"
              label="Período das vendas"
              onValueChange={setEmptyPeriod}
              today={TODAY}
              value={emptyPeriod}
            />
          </Field>
        </div>
      </Section>
    </>
  );
}

/**
 * The filter bar, as the sales history will use it: a period, a choice, a text and a field that needs the
 * connection (aria-disabled, with its reason). "Hoje" is the same fixed day as the pickers. The status line is the
 * screen's own, inside the bar's `<search>`.
 */
const FILTER_FIELDS: FilterField[] = [
  {
    endsToday: true,
    id: "periodo",
    label: "Período",
    today: TODAY,
    type: "date-range",
  },
  {
    id: "situacao",
    label: "Situação",
    options: [
      { label: "Paga", value: "paga" },
      { label: "Cancelada", value: "cancelada" },
      { label: "Devolvida", value: "devolvida" },
    ],
    type: "select",
  },
  {
    id: "cliente",
    label: "Cliente",
    placeholder: "Nome do cliente",
    type: "text",
  },
  {
    disabledReason: "Só com conexão",
    id: "produto",
    label: "Produto vendido",
    placeholder: "Nome do produto",
    type: "text",
  },
];

const FILTER_START: FilterRule[] = [
  { fieldId: "periodo", value: { from: "2026-10-01", to: TODAY } },
  { fieldId: "situacao", value: "paga" },
  { fieldId: "cliente", value: "Maria Souza" },
];

/** With no connection the history already filtered by a product: that pill cannot be edited, only taken out. */
const FILTER_OFFLINE_START: FilterRule[] = [
  { fieldId: "produto", value: "Camiseta" },
];

function GalleryFilterBar({
  label,
  start,
  testId,
}: {
  label: string;
  start: FilterRule[];
  testId: string;
}) {
  const [rules, setRules] = useState<FilterRule[]>(start);
  return (
    <FilterBar
      fields={FILTER_FIELDS}
      label={label}
      onChange={setRules}
      value={rules}
    >
      <p
        className="text-muted-foreground text-support"
        data-testid={testId}
        role="status"
      >
        {rules.length === 1
          ? "1 filtro ativo"
          : `${rules.length} filtros ativos`}
      </p>
    </FilterBar>
  );
}

function FilterBarExample() {
  return (
    <Section title="Filtros">
      <GalleryFilterBar
        label="Filtrar vendas"
        start={FILTER_START}
        testId="filtros-contagem"
      />
      <GalleryFilterBar
        label="Filtrar vendas sem conexão"
        start={FILTER_OFFLINE_START}
        testId="filtros-contagem-sem-conexao"
      />
    </Section>
  );
}

/**
 * The form dialog, with a second one opened from inside it: on a phone each has its entry in the history, and the step
 * back closes the top one first (`e2e-pwa/dialog-voltar.e2e.ts`). What was typed lives here, as a screen keeps its
 * draft, so a dialog closed by the step back opens again with it.
 */
function GalleryFormDialog() {
  const [fields, setFields] = useState<Record<string, string>>({});
  const fieldProps = (id: string) => ({
    id,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      setFields((current) => ({ ...current, [id]: value }));
    },
    value: fields[id] ?? "",
  });
  return (
    <Dialog disablePointerDismissal>
      <DialogTrigger render={<Button variant="outline" />}>
        Abrir formulário
      </DialogTrigger>
      <DialogContent layout="form">
        <DialogForm>
          <DialogHeader>
            <DialogTitle>Novo cadastro</DialogTitle>
            <DialogDescription>
              No celular ocupa a tela inteira; só o meio rola.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((number) => (
              <div className="grid gap-1.5" key={number}>
                <Label htmlFor={`galeria-form-${number}`}>Campo {number}</Label>
                <Input {...fieldProps(`galeria-form-${number}`)} />
              </div>
            ))}
            <Dialog disablePointerDismissal>
              <DialogTrigger render={<Button variant="outline" />}>
                Abrir outro formulário
              </DialogTrigger>
              <DialogContent layout="form">
                <DialogHeader>
                  <DialogTitle>Outro cadastro</DialogTitle>
                  <DialogDescription>
                    Aberto por cima do primeiro.
                  </DialogDescription>
                </DialogHeader>
                <DialogBody>
                  <div className="grid gap-1.5">
                    <Label htmlFor="galeria-form-outro">Observação</Label>
                    <Input {...fieldProps("galeria-form-outro")} />
                  </div>
                </DialogBody>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline" />}>
                    Cancelar
                  </DialogClose>
                  <DialogClose render={<Button />}>Salvar</DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              Cancelar
            </DialogClose>
            <Button type="submit">Salvar</Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}

export function UiGallery() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <main className="mx-auto grid min-h-dvh max-w-[76rem] gap-4 bg-background p-(--gutter) font-sans text-foreground text-sm antialiased">
          <header className="flex items-center justify-between gap-3">
            <h1 className="text-title">Galeria da interface</h1>
            <ThemeSwitch />
          </header>

          <Section title="Botões">
            <div className="flex flex-wrap gap-3">
              <Button>Confirmar venda</Button>
              <Button variant="outline">Cancelar</Button>
              <Button variant="secondary">Adicionar item</Button>
              <Button variant="ghost">Limpar</Button>
              <Button variant="destructive">Excluir</Button>
              <Button variant="link">Ver detalhes</Button>
              <Button disabled>Indisponível</Button>
            </div>
          </Section>

          <Section title="Link no texto">
            <p className="max-w-prose text-muted-foreground">
              Para ir a outro lugar a partir de uma frase, como em{" "}
              <TextLink href="/ajuda" inline>
                Ajuda e contato
              </TextLink>
              . A ação de um bloco é botão, não este link.
            </p>
          </Section>

          <Section title="Tamanho por papel">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-4">
              <div className="grid content-start gap-2" data-papel="comum">
                <p className="text-muted-foreground text-support">
                  Controle comum
                </p>
                <Button className="w-fit" variant="outline">
                  Cancelar
                </Button>
              </div>
              <div className="grid content-start gap-2" data-papel="principal">
                <p className="text-muted-foreground text-support">
                  Ação principal
                </p>
                <Button className="w-fit" size="xl">
                  Nova venda
                </Button>
              </div>
              <div className="grid content-start gap-2" data-papel="grupo">
                <p className="text-muted-foreground text-support">
                  Controles em grupo
                </p>
                <div className="flex gap-2" data-target-group="">
                  {GROUP_ACTIONS.map(({ Icon, name }) => (
                    <Button
                      aria-label={name}
                      className="size-6 before:content-none!"
                      key={name}
                      size="icon-xs"
                      variant="outline"
                    >
                      <Icon aria-hidden="true" />
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid content-start gap-2" data-papel="campo">
                <p className="text-muted-foreground text-support">
                  Campo de texto
                </p>
                <Input aria-label="Campo de texto" placeholder="Busca" />
              </div>
            </div>
          </Section>

          <Section title="Campos">
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor="galeria-nome">Nome do produto</Label>
              <Input id="galeria-nome" placeholder="Ex.: Camiseta azul" />
            </div>
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor="galeria-preco">Preço (R$)</Label>
              <Input
                aria-invalid="true"
                id="galeria-preco"
                inputMode="decimal"
              />
            </div>
            <div className="grid max-w-sm gap-1.5">
              <Label htmlFor="galeria-descricao">Descrição</Label>
              <Textarea
                id="galeria-descricao"
                placeholder="Material, corte, cuidados"
              />
            </div>
            <GalleryCombobox />
          </Section>

          <Section title="Sobreposições">
            <div className="flex flex-wrap items-center gap-3">
              <Dialog>
                <DialogTrigger render={<Button variant="outline" />}>
                  Abrir diálogo
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Cancelar a venda?</DialogTitle>
                    <DialogDescription>
                      A venda continua registrada e o estoque volta ao saldo
                      anterior.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>
                      Voltar
                    </DialogClose>
                    <DialogClose render={<Button />}>
                      Cancelar a venda
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <GalleryFormDialog />

              <Popover>
                <PopoverTrigger render={<Button variant="outline" />}>
                  Abrir popover
                </PopoverTrigger>
                <PopoverContent>
                  <PopoverHeader>
                    <PopoverTitle>Custo desconhecido</PopoverTitle>
                    <PopoverDescription>
                      Informe o custo do item para ver a margem.
                    </PopoverDescription>
                  </PopoverHeader>
                </PopoverContent>
              </Popover>

              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  Abrir menu
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Produto</DropdownMenuLabel>
                    <DropdownMenuItem>Editar</DropdownMenuItem>
                    <DropdownMenuItem>Duplicar</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem defaultChecked>
                    Mostrar no catálogo
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuItem variant="destructive">
                    Arquivar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Tooltip>
                {/* An icon trigger is named by the text of its tooltip, so a screen reader hears it too. */}
                <TooltipTrigger
                  aria-label="Saldo confirmado pelo servidor"
                  render={<Button size="icon" variant="outline" />}
                >
                  <InfoIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>Saldo confirmado pelo servidor</TooltipContent>
              </Tooltip>

              <Button onClick={showToast} variant="outline">
                Mostrar aviso
              </Button>
            </div>

            <div className="grid max-w-sm gap-1.5">
              <Label id="galeria-metodo-rotulo">Método de pagamento</Label>
              <Select items={METHODS}>
                <SelectTrigger
                  aria-labelledby="galeria-metodo-rotulo"
                  className="w-full"
                >
                  <SelectValue placeholder="Escolha o método" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>Métodos</SelectLabel>
                    {METHODS.map((method) => (
                      <SelectItem key={method.value} value={method.value}>
                        {method.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </Section>

          <Section title="Ajuda (i)">
            {/* The cards clip their overflow, as in the app: the popup is in a portal and must come out whole. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-1">
                    <CardTitle aria-level={3} role="heading">
                      Resultado estimado
                    </CardTitle>
                    <HelpTip about="Resultado estimado">
                      Vendas menos custos, taxas e despesas de 1 a 23/10.
                      Compara com 1 a 23/09.
                    </HelpTip>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-support">
                    1 a 23/10
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <div className="flex items-center gap-1">
                    <CardTitle aria-level={3} role="heading">
                      Ticket médio
                    </CardTitle>
                    <HelpTip
                      about="Ticket médio"
                      link={{ href: "/dashboard", label: "Ver o resultado" }}
                    >
                      Vendas líquidas divididas pelo número de vendas.
                    </HelpTip>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground text-support">
                    1 a 23/10
                  </p>
                </CardContent>
              </Card>
            </div>
          </Section>

          <Section title="Componentes da venda">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>
                <CheckIcon aria-hidden="true" data-icon="inline-start" />
                Sincronizado
              </Badge>
              <Badge variant="warning">
                <CloudOffIcon aria-hidden="true" data-icon="inline-start" />
                Offline · 3
              </Badge>
              <Badge variant="destructive">
                <TriangleAlertIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                Atenção: 1
              </Badge>
            </div>

            <Alert variant="warning">
              <CloudOffIcon aria-hidden="true" />
              <AlertTitle>Sem internet.</AlertTitle>
              <AlertDescription>
                Pode vender. 3 vendas aguardam envio.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>Não deu para carregar os perfis.</AlertTitle>
              <AlertDescription>
                Confira a conexão e tente de novo.
              </AlertDescription>
            </Alert>
            <Alert>
              <InfoIcon aria-hidden="true" />
              <AlertDescription>
                Esta venda ainda não foi enviada.
              </AlertDescription>
            </Alert>

            <Card>
              <CardHeader>
                <CardTitle aria-level={3} role="heading">
                  Itens
                </CardTitle>
                <CardDescription>2 itens</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
                  <Field>
                    <FieldLabel htmlFor="galeria-quantidade">
                      Quantidade
                    </FieldLabel>
                    <ButtonGroup aria-label="Quantidade" className="w-auto">
                      <Button
                        aria-label="Diminuir a quantidade"
                        size="icon"
                        variant="outline"
                      >
                        <MinusIcon aria-hidden="true" />
                      </Button>
                      <Input
                        className="w-14"
                        defaultValue="2"
                        id="galeria-quantidade"
                        inputMode="decimal"
                      />
                      <Button
                        aria-label="Aumentar a quantidade"
                        size="icon"
                        variant="outline"
                      >
                        <PlusIcon aria-hidden="true" />
                      </Button>
                    </ButtonGroup>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="galeria-preco-cobrado">
                      Preço cobrado
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>R$</InputGroupAddon>
                      <InputGroupInput
                        aria-describedby="galeria-preco-cobrado-ajuda"
                        defaultValue="50,00"
                        id="galeria-preco-cobrado"
                        inputMode="decimal"
                      />
                    </InputGroup>
                    <FieldDescription id="galeria-preco-cobrado-ajuda">
                      Tabela: R$ 50,00 por unidade
                    </FieldDescription>
                  </Field>
                </div>
                <Separator />
                <Field data-invalid="true">
                  <FieldLabel htmlFor="galeria-preco-vazio">
                    Preço do segundo item
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>R$</InputGroupAddon>
                    <InputGroupInput
                      aria-describedby="galeria-preco-vazio-erro"
                      aria-invalid="true"
                      id="galeria-preco-vazio"
                      inputMode="decimal"
                    />
                  </InputGroup>
                  <FieldError id="galeria-preco-vazio-erro">
                    Informe um preço maior que zero.
                  </FieldError>
                </Field>
                <GallerySearch />
                <Field>
                  <FieldLabel htmlFor="galeria-observacao">
                    Observação (opcional)
                  </FieldLabel>
                  <InputGroup className="h-auto touch:h-auto items-stretch">
                    <InputGroupTextarea id="galeria-observacao" rows={3} />
                  </InputGroup>
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle aria-level={3} role="heading">
                  Pagamento
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <FieldSet>
                  <FieldLegend id="galeria-forma-rotulo" variant="label">
                    Forma de pagamento
                  </FieldLegend>
                  <RadioGroup
                    aria-labelledby="galeria-forma-rotulo"
                    className="grid-cols-1 md:grid-cols-3 min-[22rem]:grid-cols-2"
                    defaultValue="pix"
                  >
                    {SALE_METHODS.map((method) => (
                      <FieldLabel
                        htmlFor={`galeria-forma-${method.value}`}
                        key={method.value}
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldTitle>{method.label}</FieldTitle>
                          </FieldContent>
                          <RadioGroupItem
                            id={`galeria-forma-${method.value}`}
                            value={method.value}
                          />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                </FieldSet>
                <Separator />
                <Field>
                  <FieldLabel id="galeria-perfil-rotulo">
                    Perfil de pagamento
                  </FieldLabel>
                  <Select defaultValue="sem-perfil" items={PROFILES}>
                    <SelectTrigger
                      aria-describedby="galeria-perfil-ajuda"
                      aria-labelledby="galeria-perfil-rotulo"
                      className="w-full"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {PROFILES.map((profile) => (
                          <SelectItem key={profile.value} value={profile.value}>
                            {profile.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription id="galeria-perfil-ajuda">
                    Sem perfil, taxas e prazo ficam como estimativa.
                  </FieldDescription>
                </Field>
                <Separator />
                <Field orientation="horizontal">
                  <Checkbox
                    aria-describedby="galeria-antecipar-ajuda"
                    id="galeria-antecipar"
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="galeria-antecipar">
                      Pretendo antecipar este recebimento
                    </FieldLabel>
                    <FieldDescription id="galeria-antecipar-ajuda">
                      É uma intenção registrada na venda; não indica que a
                      antecipação ocorreu.
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <Separator />
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="galeria-dicas">
                      Dicas para começar
                    </FieldLabel>
                    <FieldDescription id="galeria-dicas-ajuda">
                      Até 3 e-mails nos primeiros 14 dias de uma loja nova.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    aria-describedby="galeria-dicas-ajuda"
                    defaultChecked
                    id="galeria-dicas"
                  />
                </Field>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle aria-level={3} role="heading">
                  Formulário em seções
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4">
                <FieldSet>
                  <FieldLegend>Produto</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="galeria-secao-nome">Nome</FieldLabel>
                    <Input id="galeria-secao-nome" />
                  </Field>
                </FieldSet>
                <FieldSeparator />
                <FieldSet>
                  <FieldLegend>Preço e estoque</FieldLegend>
                  <Field>
                    <FieldLabel htmlFor="galeria-secao-preco">
                      Preço de tabela
                    </FieldLabel>
                    <Input id="galeria-secao-preco" inputMode="decimal" />
                  </Field>
                </FieldSet>
              </CardContent>
            </Card>
          </Section>

          <Section title="Shell">
            <div className="flex flex-wrap items-start gap-6">
              <p className="m-0 flex items-center gap-2.5 font-semibold tracking-tight">
                <Logo />
                Polaris
              </p>
              <div className="w-60">
                <ThemeSegmented />
              </div>
            </div>
            {/* the parts of the sidebar that are not fixed to the window (the column itself is in the shell) */}
            <div className="w-60 rounded-lg bg-sidebar text-sidebar-foreground">
              <SidebarGroup>
                <SidebarGroupLabel>Catálogo</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton href="#estoque">
                        <span>Estoque</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-current="page"
                        href="#produtos"
                        isActive
                      >
                        <span>Produtos</span>
                        <span
                          aria-hidden="true"
                          className="ml-auto size-1.5 shrink-0 rounded-full bg-mark"
                        />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </div>
            <div className="flex flex-wrap items-start gap-6">
              {(
                [
                  { art: true, label: "Aberto", used: 12 },
                  { art: false, label: "Compacto (celular)", used: 12 },
                  { art: true, label: "No limite", used: 50 },
                ] as const
              ).map(({ art, label, used }) => (
                <figure className="m-0 grid w-60 gap-2" key={label}>
                  <figcaption className="text-muted-foreground text-xs">
                    {label}
                  </figcaption>
                  <div className="rounded-lg bg-sidebar p-2 text-sidebar-foreground">
                    <PlanCard
                      art={art}
                      buttonLabel="Conhecer o Pro"
                      href="#assinatura"
                      pitch="Catálogo público no ar, vendas sem internet e mais variantes, imagens e metas."
                      usage={{
                        share: used / 50,
                        text: `Você usa ${used} de 50 variantes no plano Free.`,
                      }}
                    />
                  </div>
                </figure>
              ))}
              <figure className="m-0 grid w-fit gap-2">
                <figcaption className="text-muted-foreground text-xs">
                  Recolhido
                </figcaption>
                <div
                  className="group rounded-lg bg-sidebar p-1 text-sidebar-foreground"
                  data-collapsible="icon"
                >
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        aria-label="Plano Free, 12 de 50 variantes, conhecer o Pro"
                        href="#assinatura"
                      >
                        <SparklesIcon aria-hidden />
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </div>
              </figure>
            </div>
          </Section>

          <Section title="Tabela, bloco que abre e progresso">
            <Table>
              <TableCaption>Metas do mês, dados de exemplo.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Meta</TableHead>
                  <TableHead className="text-right">Realizado</TableHead>
                  <TableHead className="text-right">Alvo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Vendas</TableCell>
                  <TableCell className="text-right tabular-nums">
                    R$ 4.200,00
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    R$ 6.000,00
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Margem</TableCell>
                  <TableCell className="text-right tabular-nums">38%</TableCell>
                  <TableCell className="text-right tabular-nums">40%</TableCell>
                </TableRow>
              </TableBody>
              <TableFooter>
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    R$ 4.200,00
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    R$ 6.000,00
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
            <Collapsible>
              <CollapsibleTrigger
                render={<Button size="sm" variant="outline" />}
              >
                Despesas recorrentes
              </CollapsibleTrigger>
              <CollapsiblePanel className="pt-2 text-muted-foreground">
                Aluguel e internet, todo dia 5.
              </CollapsiblePanel>
            </Collapsible>
            <Collapsible className="mt-2" defaultOpen>
              <CollapsibleTrigger
                render={<Button size="sm" variant="outline" />}
              >
                Despesas fixas
              </CollapsibleTrigger>
              <CollapsiblePanel className="pt-2 text-muted-foreground">
                Condomínio, todo dia 10.
              </CollapsiblePanel>
            </Collapsible>
            <Progress value={70}>
              <ProgressLabel>Meta de vendas</ProgressLabel>
              <ProgressValue />
            </Progress>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 text-muted-foreground tabular-nums">
              {[1, 2].map((done) => (
                <li className="flex items-center gap-1.5" key={done}>
                  <ProgressRing done={done} total={3} />
                  {done} de 3
                </li>
              ))}
            </ul>
            <div aria-hidden="true" className="grid gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          </Section>

          <Section title="Ritmo da meta">
            <PaceExamples />
          </Section>

          <Section title="Área de rolagem">
            <ScrollArea
              aria-label="Movimentos"
              className="h-40 rounded-lg ring-1 ring-foreground/[0.06]"
            >
              <ul className="grid gap-1 p-3">
                {LONG_LIST.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </ScrollArea>
          </Section>

          <Section title="Abas">
            <Tabs defaultValue="7">
              <TabsList aria-label="Período">
                <TabsTrigger value="7">7 dias</TabsTrigger>
                <TabsTrigger value="30">30 dias</TabsTrigger>
              </TabsList>
              <TabsContent className="text-muted-foreground" value="7">
                Os últimos 7 dias, dados de exemplo.
              </TabsContent>
              <TabsContent className="text-muted-foreground" value="30">
                Os últimos 30 dias, dados de exemplo.
              </TabsContent>
            </Tabs>
          </Section>

          <Section title="Aba de tela em linha">
            <Tabs defaultValue="resultado">
              <TabsList aria-label="Seção em linha" variant="line">
                <TabsTrigger value="resultado">Resultado</TabsTrigger>
                <TabsTrigger value="metas">Metas</TabsTrigger>
              </TabsList>
              <TabsContent className="text-muted-foreground" value="resultado">
                A aba de tela em linha: o traço de 2 px em tinta, dados de
                exemplo.
              </TabsContent>
              <TabsContent className="text-muted-foreground" value="metas">
                Painel da aba Metas, dados de exemplo.
              </TabsContent>
            </Tabs>
          </Section>

          <Section title="SectionTabs: com e sem rota">
            <p className="max-w-prose text-muted-foreground text-support">
              Uma peça só, com rota (a aba aberta vai para o endereço) e sem
              rota (a aba é local, no diálogo ou no bloco).
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div data-gallery-tabs="routed">
                <RoutedSectionTabsExample />
              </div>
              <div data-gallery-tabs="local">
                <SectionTabs label="Abas sem rota" tabs={LOCAL_TABS} />
              </div>
            </div>
          </Section>

          <Section title="Filtro segmentado">
            <GallerySegmentedFilter />
          </Section>

          <Section title="Número principal dos cartões">
            <p className="text-support">
              O valor do cartão aparece pronto e, quando muda (outro período,
              atualizar), o novo entra com um fade curto no desktop; o dia lido
              no minigráfico troca na hora, e no celular e com movimento
              reduzido toda troca é sem animação. A variação, a meta e a margem
              nunca animam.
            </p>
            <p className="font-mono font-semibold text-value-lg tabular-nums">
              <AnimatedFigure text="R$ 1.234,56">
                <Money split text="R$ 1.234,56" />
              </AnimatedFigure>
            </p>
          </Section>

          <Section title="Cartão com moldura">
            <p className="max-w-prose text-muted-foreground text-support">
              Só em bloco de painel, a partir de 760 px: moldura em muted com o
              título, painel em card e, quando há destino, um pé com uma ação.
              Abaixo de 760 px é o cartão simples, sem pé.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {[
                { foot: true, icon: true },
                { foot: false, icon: true },
                { foot: true, icon: false },
                { foot: false, icon: false },
              ].map(({ foot, icon }) => (
                <CardFrame
                  aria-labelledby={`gallery-frame-${icon}-${foot}`}
                  key={`${icon}-${foot}`}
                  role="region"
                >
                  <CardFrameHeader>
                    <BlockHeader
                      aside={
                        <p className="text-muted-foreground text-support">
                          Ação de cabeçalho
                        </p>
                      }
                      help={{
                        about: "Cartão com moldura",
                        text: "O (i) fica ao lado do título, na moldura.",
                      }}
                      id={`gallery-frame-${icon}-${foot}`}
                      level={3}
                      title={
                        <span className="flex items-center gap-2">
                          {icon ? (
                            <ChartColumnIcon
                              aria-hidden="true"
                              className="size-4 shrink-0"
                            />
                          ) : null}
                          {foot ? "Com pé" : "Sem pé"}
                          {icon ? ", com ícone" : ", sem ícone"}
                        </span>
                      }
                    />
                  </CardFrameHeader>
                  <CardFramePanel>
                    <p className="font-semibold text-value-lg tabular-nums tracking-[-0.035em]">
                      <Money split text="R$ 1.234,56" />
                    </p>
                    <p className="text-muted-foreground">
                      O painel guarda o conteúdo, com o raio da moldura menos a
                      folga e sem sombra própria.
                    </p>
                  </CardFramePanel>
                  {foot ? (
                    <CardFrameFooter>
                      <CardFrameLink href="/dashboard">
                        Ver o resultado
                      </CardFrameLink>
                    </CardFrameFooter>
                  ) : null}
                </CardFrame>
              ))}
            </div>
          </Section>

          <Section title="Block">
            <p className="max-w-prose text-muted-foreground text-support">
              O <code>Block</code> desenha como o bloco do Início: à esquerda a
              composição de hoje, à direita a peça, nas mesmas medidas.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <ReferenceBlock id="gallery-block-reference" />
              <BlockExample id="gallery-block-piece" />
            </div>
          </Section>

          <Section title="ListBlock">
            <p className="max-w-prose text-muted-foreground text-support">
              Lista e tabela na moldura do Início: o título e a contagem na
              moldura, o painel sem respiro com as linhas de borda a borda, e o
              total sempre por último. Os três estados, com e sem total, e a
              tabela larga, que rola por dentro do painel.
            </p>
            <div className="grid items-start gap-4 lg:grid-cols-2">
              <ListBlockExample state="rows" title="Produtos com total" total />
              <ListBlockExample
                state="rows"
                title="Produtos sem total"
                total={false}
              />
              <ListBlockExample
                state="loading"
                title="Carregando com total"
                total
              />
              <ListBlockExample
                state="loading"
                title="Carregando sem total"
                total={false}
              />
              <ListBlockExample
                state="filtered-empty"
                title="Busca com total"
                total
              />
              <ListBlockExample
                state="filtered-empty"
                title="Busca sem total"
                total={false}
              />
              <ListBlockExample state="rows" title="Tabela larga" total wide />
            </div>
          </Section>

          <Section title="Peças soltas da lista">
            <p className="max-w-prose text-muted-foreground text-support">
              O aviso, o quadro do ícone e o total que o <code>ListBlock</code>{" "}
              compõe. As telas que ainda não migraram os usam soltos, e a trava
              (R4) não deixa entrar tela nova com eles.
            </p>
            <div className="grid items-start gap-4 md:grid-cols-2">
              <ListNotice>
                <p>Nenhum cliente com essa busca.</p>
              </ListNotice>
              <div className="grid gap-4">
                <RowTile>
                  <UsersIcon />
                </RowTile>
                <ListTotalFooter count="3 vendas" value="R$ 111,80" />
              </div>
            </div>
          </Section>

          <Section title="Painéis internos">
            <p className="max-w-prose text-muted-foreground text-support">
              Os dois únicos painéis dentro de um bloco, de um cartão ou de um
              diálogo. O bloco rebaixado (<code>InsetBlock</code>) é o cinza
              cheio, sem borda, para o dado que se lê (com{" "}
              <code>tone="destructive"</code>, a confirmação do que não tem
              volta, na própria linha: o mesmo cinza com um anel de 1 px em
              perigo); o grupo de campos (<code>FieldGroup</code>) é o{" "}
              <code>fieldset</code> com borda de 1 px e sem fundo, para os
              campos de um formulário.
            </p>
            <div className="grid items-start gap-4 md:grid-cols-2">
              <InsetBlock data-gallery-panel="inset">
                <dl className="grid gap-1 text-sm">
                  <dt className="text-muted-foreground">Pagamento</dt>
                  <dd>Pix, R$ 111,80</dd>
                </dl>
              </InsetBlock>
              <InsetBlock
                data-gallery-panel="inset-destructive"
                tone="destructive"
              >
                <p className="text-sm">
                  Anonimizar não dá para desfazer. Confirmação na própria linha:
                  o mesmo cinza, com anel de perigo.
                </p>
              </InsetBlock>
              <FieldGroup data-gallery-panel="group">
                <FieldLegend>Contato</FieldLegend>
                <Field>
                  <FieldLabel htmlFor="gallery-group-email">E-mail</FieldLabel>
                  <Input id="gallery-group-email" type="email" />
                </Field>
                <Field>
                  <FieldLabel htmlFor="gallery-group-phone">
                    Telefone
                  </FieldLabel>
                  <Input id="gallery-group-phone" type="tel" />
                </Field>
              </FieldGroup>
            </div>
          </Section>

          <Section title="Opção marcável e caixa do passo">
            <p className="max-w-prose text-muted-foreground text-support">
              A opção marcável (<code>CheckableOption</code>) é uma linha com
              borda e uma caixa de marcar, para escolher várias entre poucas. A
              caixa do passo (<code>StepTile</code>) é o quadro de 28 px do
              ícone de cada passo de uma lista de tarefas, igual nos três
              estados.
            </p>
            <div className="grid items-start gap-4 md:grid-cols-2">
              <CheckableOptionExamples />
              <StepTileExamples />
            </div>
          </Section>

          <Section title="Aviso de ação">
            <p className="max-w-prose text-muted-foreground text-support">
              O aviso <code>ActionStrip</code> ("Precisa de ação") fica sob o
              título da tela: o triângulo, o nome e uma linha com os números,
              cada um um link quando leva a uma lista, ou só o texto quando não
              leva. Só existe quando há o que fazer.
            </p>
            <ActionStrip>
              <TextLink href="/ajuda" inline>
                3 sem custo
              </TextLink>
              {" · 2 sem saldo"}
            </ActionStrip>
          </Section>

          <Section title="Controles desligados">
            <p className="max-w-prose text-muted-foreground text-support">
              Caixa de marcar, botão de rádio e chave desligados ficam a 50 % e
              mostram o cursor de bloqueio, soltos ou dentro de um campo ou
              cartão que já apaga o texto.
            </p>
            <DisabledControlExamples />
          </Section>

          <Section title="Block sem moldura">
            <p className="max-w-prose text-muted-foreground text-support">
              <code>Block variant="plain"</code>: o mesmo cabeçalho e o mesmo
              ritmo, sem a moldura de fora. O título é o único que se omite.
            </p>
            <PlainBlockExamples />
          </Section>

          <Section title="Cartão de KPI e Esconder valores">
            <div className="flex flex-wrap items-center gap-3">
              <HideValuesButton />
              <RefreshButton />
              <span className="text-support">
                <MoneyText text="18/10 · R$ 1.840,00" />
              </span>
            </div>
            <KpiTile
              entity="sales"
              help={{
                about: "Vendas hoje",
                text: "Vendas líquidas de hoje. Compara com a média das 4 sextas-feiras anteriores.",
              }}
              hero
              id="galeria-kpi-hoje"
              note="3 vendas"
              title="Vendas hoje"
              value={<HeroValue amount="320.10" size="xl" tile />}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <KpiTile
                chip={
                  <DeltaChip
                    delta={{
                      basis: "em relação a 1 a 25/09",
                      money: false,
                      spoken: "subiu 19,1 por cento",
                      text: "+19,1%",
                      trend: "up",
                    }}
                  />
                }
                entity="sales"
                help={{
                  about: "Vendas",
                  text: "Vendas líquidas de 1 a 25/10. Compara com 1 a 25/09.",
                }}
                id="galeria-kpi-vendas"
                note="41 vendas"
                spark={
                  <OnDemandSparkline
                    color="var(--chart-sales)"
                    domain="zero"
                    height={36}
                    values={GALLERY_KPI_SERIES}
                  />
                }
                title="Vendas"
                value={<HeroValue amount="2660.60" tile />}
              />
              <KpiTile
                chip={
                  <DeltaChip
                    delta={{
                      basis: "em relação a 1 a 25/09",
                      money: true,
                      spoken: "caiu R$ 12,00",
                      text: "-R$ 12,00",
                      trend: "down",
                    }}
                  />
                }
                entity="result"
                help={{
                  about: "Resultado estimado",
                  text: "Vendas menos custos, taxas e despesas de 1 a 25/10. Compara com 1 a 25/09.",
                }}
                id="galeria-kpi-resultado"
                note="Não é lucro líquido nem caixa"
                title="Resultado estimado"
                value={<HeroValue amount="-48.30" tile />}
              />
            </div>
          </Section>

          <Section title="Estado vazio">
            <EmptyState
              afterRead
              icon={UsersIcon}
              title="Nenhum cliente ainda."
            >
              <Button type="button">
                <PlusIcon aria-hidden="true" data-icon="inline-start" />
                Novo cliente
              </Button>
            </EmptyState>
            <EmptyState
              afterRead
              icon={CheckIcon}
              support="Tudo o que foi feito sem internet foi aceito."
              title="Nenhuma pendência de envio."
            />
            <EmptyState
              afterRead
              icon={[ShoppingBagIcon, WalletIcon, ChartColumnIcon]}
              support="Escolha outro período ou registre vendas e despesas."
              title="Sem vendas nem despesas em 1 a 31 de outubro"
            >
              <Button type="button">Nova venda</Button>
              <Button type="button" variant="outline">
                Nova despesa
              </Button>
            </EmptyState>
            <EmptyState
              afterRead
              support="Escolha outro período ou registre vendas e despesas."
              title="Sem vendas nem despesas em 1 a 31 de outubro"
            >
              <Button type="button">Nova venda</Button>
            </EmptyState>
            <ul className="grid list-none gap-4 p-0 sm:grid-cols-3">
              {SKELETON_ART_SAMPLES.map((sample) => (
                <li key={sample.kind}>
                  <figure className="m-0 grid gap-2">
                    <SkeletonArt kind={sample.kind} />
                    <figcaption className="text-muted-foreground text-support">
                      {sample.caption}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ul>
            <Card>
              <CardContent>
                <Empty>
                  <EmptyMedia variant="icon">
                    <CloudOffIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>As peças, montadas à mão</EmptyTitle>
                    <EmptyDescription>
                      Quadro, frase e apoio, sem o cartão do EmptyState.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </CardContent>
            </Card>
          </Section>

          <Section title="Dinheiro">
            <div className="grid gap-2" data-gallery-money="">
              {(["sm", "md", "lg", "xl"] as const).map((size) => (
                <p className="flex flex-wrap items-baseline gap-x-3" key={size}>
                  <span className="w-8 text-muted-foreground text-support">
                    {size}
                  </span>
                  <Money size={size} text="R$ 234,50" />
                  <span aria-hidden="true" className="basis-full sm:hidden" />
                  <Money size={size} text="-R$ 6,35" />
                </p>
              ))}
            </div>
          </Section>

          <Section title="Quantidade, taxa e prazo">
            <p className="flex flex-wrap items-baseline gap-x-3 text-sm">
              <span>Estoque</span>
              <Figure>1.234</Figure>
              <span>Taxa</span>
              <Figure>3,5%</Figure>
              <span>Prazo</span>
              <Figure>30</Figure>
              <span>dias</span>
            </p>
          </Section>

          <Section title="Visor em Geist Mono">
            <p className="text-support">
              O número dos cartões de KPI (o dinheiro, acima) e os percentuais
              leem como visor: o mesmo avanço em cada dígito, então o número não
              muda de largura quando os dígitos mudam. O dinheiro em lg e xl e
              toda quantidade (Figure) leem assim; data, hora, telefone e
              documento seguem em Geist.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <DeltaChip
                delta={{
                  money: false,
                  spoken: "subiu 12 por cento",
                  text: "+12%",
                  trend: "up",
                }}
              />
              <DeltaChip
                delta={{
                  against: "vs. setembro",
                  money: false,
                  spoken: "caiu 4,5 por cento",
                  text: "-4,5%",
                  trend: "down",
                }}
              />
              <DeltaChip
                delta={{
                  money: true,
                  spoken: "subiu R$ 436,86",
                  text: "+R$ 436,86",
                  trend: "up",
                }}
              />
            </div>
            <Progress value={53.4}>
              <ProgressLabel>Meta de vendas</ProgressLabel>
              <ProgressValue className="font-medium font-mono text-foreground">
                {() => "53,4%"}
              </ProgressValue>
            </Progress>
            <div className="grid gap-3 sm:max-w-xs">
              <KpiTile
                entity="result"
                id="galeria-kpi-margem"
                note="Margem"
                title="Margem"
                value={<HeroPercent text="41,2%" />}
              />
            </div>
          </Section>

          <ChartStates />

          <ThumbnailStates />

          <DatePickerStates />

          <FilterBarExample />

          <Section title="Caracteres das fontes">
            <div className="grid gap-2" data-testid="font-sample">
              {FONT_SAMPLE.map((line) => (
                <p className="font-sans" key={`sans-${line}`}>
                  {line}
                </p>
              ))}
              {FONT_SAMPLE.map((line) => (
                <p className="font-sans font-semibold" key={`bold-${line}`}>
                  {line}
                </p>
              ))}
              {FONT_SAMPLE.map((line) => (
                <p className="font-mono" key={`mono-${line}`}>
                  {line}
                </p>
              ))}
            </div>
          </Section>
        </main>
      </TooltipProvider>
    </ToastProvider>
  );
}
