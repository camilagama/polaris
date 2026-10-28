import { type ChangeEvent, useState } from "react";
import CheckIcon from "lucide-react/dist/esm/icons/check";
import { ChartStates } from "./chart-states";
import CloudOffIcon from "lucide-react/dist/esm/icons/cloud-off";
import InfoIcon from "lucide-react/dist/esm/icons/info";
import MinusIcon from "lucide-react/dist/esm/icons/minus";
import PlusIcon from "lucide-react/dist/esm/icons/plus";
import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { OnDemandCalendar } from "@/ui/calendar-on-demand";
import { OnDemandSparkline } from "@/ui/charts/on-demand";
import { Checkbox } from "@/ui/checkbox";
import { DatePicker } from "@/ui/date-picker";
import { DateRangePicker } from "@/ui/date-range-picker";
import {
  type DateRange,
  type IsoDate,
  parseIsoDate,
  toIsoDate,
} from "@/ui/date-values";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "@/ui/collapsible";
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
import { HelpTip } from "@/ui/help-tip";
import { HideValuesButton, MoneyText } from "@/ui/hidden-values";
import { DeltaChip, HeroValue, KpiCard } from "@/ui/kpi-card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/ui/field";
import { FilterBar, type FilterField, type FilterRule } from "@/ui/filter-bar";
import { Input } from "@/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from "@/ui/input-group";
import { Label } from "@/ui/label";
import { Logo } from "@/ui/logo";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/ui/popover";
import { Progress, ProgressLabel, ProgressValue } from "@/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { SearchField } from "@/ui/search-field";
import { ScrollArea } from "@/ui/scroll-area";
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
import { Textarea } from "@/ui/textarea";
import { ThemeSegmented } from "@/ui/theme-segmented";
import { ThemeSwitch } from "@/ui/theme-switch";
import { ToastProvider, toastManager } from "@/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/ui/tooltip";

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

const LONG_LIST = Array.from(
  { length: 40 },
  (_, index) => `Movimento de estoque ${index + 1}`
);

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
  { id: "periodo", label: "Período", today: TODAY, type: "date-range" },
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
                  <InputGroup className="h-auto items-stretch">
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
            <div aria-hidden="true" className="grid gap-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
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

          <Section title="Cartão de KPI e Esconder valores">
            <div className="flex flex-wrap items-center gap-3">
              <HideValuesButton />
              <span className="text-support">
                <MoneyText text="Melhor dia: 18/10, R$ 1.840,00" />
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <KpiCard
                chip={
                  <DeltaChip
                    delta={{ money: false, text: "+19,1%", trend: "up" }}
                  />
                }
                date="1 a 25/10"
                entity="sales"
                footer="41 vendas no mês"
                id="galeria-kpi-vendas"
                note="vs. 1 a 25/09"
                spark={
                  <OnDemandSparkline
                    color="var(--chart-sales)"
                    domain="zero"
                    height={64}
                    values={GALLERY_KPI_SERIES}
                  />
                }
                title="Vendas em outubro"
                value={<HeroValue amount="2660.60" />}
              />
              <KpiCard
                chip={
                  <DeltaChip
                    delta={{ money: true, text: "-R$ 12,00", trend: "down" }}
                  />
                }
                date="1 a 25/10"
                entity="result"
                footer="Não é lucro líquido nem dinheiro já recebido."
                id="galeria-kpi-resultado"
                note="vs. 1 a 25/09"
                title="Resultado estimado"
                value={<HeroValue amount="-48.30" size="md" />}
              />
            </div>
          </Section>

          <ChartStates />

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
