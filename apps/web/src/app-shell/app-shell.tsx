import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type CurrentOrganization,
  useOrganizationLoad,
} from "../lib/current-organization";
import { currentReturnPath } from "../lib/sign-in-path";
import { OrganizationSetup } from "../organization/organization-setup";
import "./app-shell.css";
import { LogoutControl } from "../offline/runtime/logout-control";
import {
  OfflineAccessGate,
  useOfflineAccessExpired,
} from "../offline/runtime/offline-access-expired";
import { useOfflineRuntime } from "../offline/runtime/runtime-context";
import { leaveSessionOver } from "../offline/runtime/session-over";
import { useSessionOver } from "../offline/runtime/session-ended";
import { SyncStatus, SyncStatusMenuLine } from "../offline/runtime/sync-status";
import { OFFLINE_RUNTIME_ENABLED } from "../offline/runtime/enabled";
import { NAV_ITEMS, type NavId, OFFLINE_NAV_ITEMS } from "./navigation-model";
import { SessionEndedNotice } from "./session-ended-notice";

interface OrganizationSwitcherProps {
  current: CurrentOrganization;
}

/** One organization is shown as context; more than one can be switched. */
function OrganizationSwitcher({ current }: OrganizationSwitcherProps) {
  const { organization, organizations, select } = current;
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => select(event.target.value),
    [select]
  );

  if (organizations.length < 2) {
    return (
      <p className="app-org-single">
        <span aria-hidden="true" className="app-org-dot" />
        <span className="visually-hidden">Organização: </span>
        <span className="app-org-name">{organization.name}</span>
      </p>
    );
  }
  return (
    <div className="app-org">
      <label className="app-org-label" htmlFor="app-organization">
        Organização
      </label>
      <select
        id="app-organization"
        onChange={handleChange}
        value={organization.id}
      >
        {organizations.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  );
}

interface AppHeaderProps {
  navId: NavId | null;
  organization: CurrentOrganization | null;
}

function AppHeader({ navId, organization }: AppHeaderProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const handleToggle = useCallback(() => setOpen((value) => !value), []);
  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <header className="app-header">
      <div className="app-header-bar">
        <a aria-label="Polaris, início" className="app-brand" href="/">
          <span aria-hidden="true" className="app-brand-mark">
            P
          </span>
          <span>Polaris</span>
        </a>
        <SyncStatus />
        <button
          aria-controls="app-navigation"
          aria-expanded={open}
          className="app-menu-toggle"
          onClick={handleToggle}
          ref={toggleRef}
          type="button"
        >
          <span aria-hidden="true" className="app-menu-icon" />
          Menu
        </button>
      </div>
      <div
        className={open ? "app-nav-wrap is-open" : "app-nav-wrap"}
        id="app-navigation"
      >
        <SyncStatusMenuLine />
        <nav aria-label="Principal">
          <ul className="app-nav-list">
            {[
              ...NAV_ITEMS,
              ...(OFFLINE_RUNTIME_ENABLED ? OFFLINE_NAV_ITEMS : []),
            ].map((item) => (
              <li key={item.id}>
                <a
                  aria-current={item.id === navId ? "page" : undefined}
                  className="app-nav-link"
                  href={item.href}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {organization ? <OrganizationSwitcher current={organization} /> : null}
        <LogoutControl />
      </div>
    </header>
  );
}

const OPENING_SIGN_IN_TEXT = "Sua sessão acabou. Abrindo a tela de entrada…";

/**
 * The session was refused. When it is the read that opens the app, nothing is on screen to protect
 * and the app goes to `/entrar?motivo=sessao&voltar=<this page>` by itself (AC-16), without showing
 * the protected screen with an error. Later (a refusal found while a screen is in use) it only says so.
 */
function SessionEndedGate({ atOpen }: { atOpen: boolean }) {
  const runtime = useOfflineRuntime();
  useEffect(() => {
    if (atOpen) {
      leaveSessionOver(runtime, currentReturnPath(window.location));
    }
  }, [atOpen, runtime]);
  return atOpen ? (
    <p className="app-status" role="status">
      {OPENING_SIGN_IN_TEXT}
    </p>
  ) : (
    <SessionEndedNotice alone />
  );
}

function OrganizationGate({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();

  if (load.status === "loading") {
    return (
      <p className="app-status" role="status">
        Carregando sua organização…
      </p>
    );
  }
  if (load.status === "session_ended") {
    return <SessionEndedGate atOpen={load.atOpen} />;
  }
  if (load.status === "error") {
    return (
      <section aria-labelledby="app-gate-error" className="app-gate">
        <h1 id="app-gate-error">Não foi possível abrir o Polaris</h1>
        <p className="categories-message is-error" role="alert">
          {load.message}
        </p>
        <button className="primary-button" onClick={reload} type="button">
          Tentar novamente
        </button>
      </section>
    );
  }
  if (load.status === "empty") {
    return <OrganizationSetup onOpened={reload} />;
  }
  // Remounts the page when another organization is chosen, so no screen keeps
  // data of the previous one.
  return <div key={load.current.id}>{children}</div>;
}

interface AppShellProps {
  children: ReactNode;
  navId: NavId | null;
  /** Pages that need data of an organization wait for it to be resolved. */
  requiresOrganization?: boolean;
}

/**
 * The single frame of every screen: brand, one menu with the current area
 * marked, the organization (switchable when there is more than one) and the
 * main landmark. Narrow screens get a disclosure menu with 44 px targets.
 */
export function AppShell({
  children,
  navId,
  requiresOrganization = true,
}: AppShellProps) {
  const { load, select } = useOrganizationLoad();
  const sessionOver = useSessionOver();
  // the remembered organizations only draw the screen: with the offline access expired they are hidden, not deleted
  const accessExpired = useOfflineAccessExpired();
  // the devices screen has its own panels for this (with the same button); the gate says it itself
  const showNotice =
    sessionOver && navId !== "devices" && load.status !== "session_ended";
  const organization: CurrentOrganization | null =
    load.status === "ready" && !accessExpired
      ? {
          organization: load.current,
          organizationId: load.current.id,
          organizations: load.organizations,
          select,
        }
      : null;
  return (
    <div className="ui-root app-shell-root">
      <a className="app-skip-link" href="#conteudo">
        Ir para o conteúdo
      </a>
      <AppHeader navId={navId} organization={organization} />
      <main className="categories-content" id="conteudo">
        {showNotice ? <SessionEndedNotice /> : null}
        <OfflineAccessGate>
          {requiresOrganization ? (
            <OrganizationGate>{children}</OrganizationGate>
          ) : (
            children
          )}
        </OfflineAccessGate>
      </main>
    </div>
  );
}
