import TriangleAlertIcon from "lucide-react/dist/esm/icons/triangle-alert";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, buttonVariants } from "@/ui/button";
import { reportRenderError } from "../observability/sentry";
import { StatePanel } from "./state-panel";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** The failure of the whole app, outside the shell: the panel stands alone on the page. */
  fullPage?: boolean;
  /** Shown above the actions; the technical error is never displayed. */
  message?: string;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a failing screen from blanking the whole app. It explains the failure
 * in plain language and offers a retry; it never shows stack traces.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Reported only when the build has a Sentry DSN (ADR 0098); the fallback below is the contract either way.
    reportRenderError(error, info);
  }

  readonly handleRetry = () => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <StatePanel
        actions={
          <>
            <Button onClick={this.handleRetry} type="button">
              Tentar novamente
            </Button>
            <a
              className={buttonVariants({ variant: "outline" })}
              data-slot="button"
              href="/"
            >
              Ir para o Início
            </a>
          </>
        }
        fullPage={this.props.fullPage ?? false}
        icon={
          <TriangleAlertIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-destructive"
          />
        }
        title="Algo deu errado nesta tela"
        titleId="app-error-title"
      >
        <p className="text-muted-foreground" role="alert">
          {this.props.message ??
            "Não foi possível exibir esta tela. Tente novamente; se continuar, recarregue a página."}
        </p>
      </StatePanel>
    );
  }
}
