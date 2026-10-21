import { Button } from "@/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/ui/popover";
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

const FONT_SAMPLE = [
  "áàâãä éêë íï óôõö úü ç ñ ÁÀÂÃÄ ÉÊË ÍÏ ÓÔÕÖ ÚÜ Ç Ñ",
  "R$ 1.234,56 · 12% · nº 3 · 1ª · 2º · 25 °C · § 4",
  "“aspas” ‘simples’ «angulares» — travessão – meia-risca … reticências • ponto",
  "× ÷ ± ½ ¼ ¾ € £ © ® ™ → ↑ ↓ − ∕ ‰ ′ ″",
  "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz",
];

const LONG_LIST = Array.from(
  { length: 40 },
  (_, index) => `Movimento de estoque ${index + 1}`
);

function showToast() {
  toastManager.add({
    description: "O comprovante está no histórico.",
    title: "Venda registrada",
    type: "success",
  });
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

export function UiGallery() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <main
          className="mx-auto grid min-h-dvh max-w-[76rem] gap-4 bg-background p-(--gutter) font-sans text-foreground text-sm antialiased"
          data-ui=""
        >
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
                <TooltipTrigger render={<Button variant="outline" />}>
                  Passe o mouse
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
