import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
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

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // There is no error reporting service yet; the fallback is the contract.
  }

  readonly handleRetry = () => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <section aria-labelledby="app-error-title" className="app-gate">
        <h1 id="app-error-title">Algo deu errado nesta tela</h1>
        <p role="alert">
          {this.props.message ??
            "Não foi possível exibir esta tela. Tente novamente; se continuar, recarregue a página."}
        </p>
        <div className="app-actions">
          <button
            className="primary-button"
            onClick={this.handleRetry}
            type="button"
          >
            Tentar novamente
          </button>
          <a className="quiet-button" href="/sales">
            Ir para Vender
          </a>
        </div>
      </section>
    );
  }
}
