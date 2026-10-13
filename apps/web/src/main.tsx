import { createRoot } from "react-dom/client";
import { CategoriesPage } from "./catalog/categories-page";
import { ProductsPage } from "./catalog/products-page";
import { CustomersPage } from "./customers/customers-page";
import { PaymentProfilesPage } from "./payment-profiles/payment-profiles-page";
import { SaleCustomerPage } from "./sales/sale-customer-page";
import { SaleDetailPage } from "./sales/sale-detail-page";
import { SaleHistoryPage } from "./sales/sale-history-page";
import { SalePage } from "./sales/sale-page";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("O elemento raiz da aplicação não foi encontrado.");
}

const root = createRoot(rootElement);
const isOfflinePocEnabled =
  import.meta.env.DEV ||
  import.meta.env.MODE === "offline-poc" ||
  import.meta.env.VITE_OFFLINE_POC_ENABLED === "true";
const isOfflinePocRoute =
  isOfflinePocEnabled && window.location.pathname === "/offline-poc";

if (isOfflinePocRoute) {
  root.render(
    <main className="app-shell">Carregando laboratório offline…</main>
  );
  const loadOfflineLab = async () => {
    try {
      const { OfflinePersistenceLab } = await import(
        "./offline-poc/offline-persistence-lab"
      );
      root.render(<OfflinePersistenceLab />);
    } catch (error: unknown) {
      root.render(
        <main className="app-shell" role="alert">
          <h1>Falha ao abrir o laboratório offline</h1>
          <p>{error instanceof Error ? error.message : "Erro desconhecido."}</p>
        </main>
      );
    }
  };
  loadOfflineLab().catch(() => undefined);
} else {
  switch (window.location.pathname) {
    case "/products":
      root.render(<ProductsPage />);
      break;
    case "/customers":
      root.render(<CustomersPage />);
      break;
    case "/payment-profiles":
      root.render(<PaymentProfilesPage />);
      break;
    case "/sales/history":
      root.render(<SaleHistoryPage />);
      break;
    case "/sales/detail":
      root.render(<SaleDetailPage />);
      break;
    case "/sales/customer":
      root.render(<SaleCustomerPage />);
      break;
    case "/sales":
      root.render(<SalePage />);
      break;
    default:
      root.render(<CategoriesPage />);
  }
}
