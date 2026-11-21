import { buttonVariants } from "@/ui/button";
import { SkeletonArt } from "@/ui/skeleton-art";
import { StatePanel } from "./state-panel";

interface NotFoundPageProps {
  pathname: string;
}

/** Unknown addresses end here instead of silently opening another screen. */
export function NotFoundPage({ pathname }: NotFoundPageProps) {
  return (
    <StatePanel
      actions={
        <>
          <a className={buttonVariants()} data-slot="button" href="/">
            Ir para o Início
          </a>
          <a
            className={buttonVariants({ variant: "outline" })}
            data-slot="button"
            href="/sales/history"
          >
            Ver o histórico
          </a>
        </>
      }
      eyebrow="Erro 404"
      title="Página não encontrada"
      titleId="app-not-found-title"
    >
      <SkeletonArt className="mb-3 hidden w-44 md:block" kind="home" />
      <p className="text-muted-foreground">
        O endereço{" "}
        <code className="break-all rounded-sm bg-muted px-1 font-mono text-foreground text-support">
          {pathname}
        </code>{" "}
        não existe no Polaris. Use o menu ou volte para uma das áreas abaixo.
      </p>
    </StatePanel>
  );
}
