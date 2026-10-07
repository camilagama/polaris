import type { RequestIdVariables } from "hono/request-id";

interface HyperdriveBinding {
  connectionString: string;
}

export interface WorkerBindings {
  DB_POC_ENABLED: string;
  DB_RLS_POC_ENABLED: string;
  HYPERDRIVE: HyperdriveBinding;
}

export interface ServerEnv {
  Bindings: WorkerBindings;
  Variables: RequestIdVariables;
}
