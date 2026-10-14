/**
 * The build flag of the offline runtime (VITE_OFFLINE_RUNTIME_ENABLED), off by
 * default: with it off nothing offline runs, registers a device or touches the
 * disk. Read here so everything that depends on it asks the same question.
 */
export const OFFLINE_RUNTIME_ENABLED =
  import.meta.env.VITE_OFFLINE_RUNTIME_ENABLED === "true";
