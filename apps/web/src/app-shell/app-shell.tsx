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
import { OrganizationSetup } from "../organization/organization-setup";
import "./app-shell.css";
import { LogoutControl } from "../offline/runtime/logout-control";
import { SyncStatus } from "../offline/runtime/sync-status";
import { NAV_ITEMS, type NavId } from "./navigation-model";

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
        <nav aria-label="Principal">
          <ul className="app-nav-list">
            {NAV_ITEMS.map((item) => (
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

function OrganizationGate({ children }: { children: ReactNode }) {
  const { load, reload } = useOrganizationLoad();

  if (load.status === "loading") {
    return (
      <p className="app-status" role="status">
        Carregando sua organização…
      </p>
    );
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
  const organization: CurrentOrganization | null =
    load.status === "ready"
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
        {requiresOrganization ? (
          <OrganizationGate>{children}</OrganizationGate>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
