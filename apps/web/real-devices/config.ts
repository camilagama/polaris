/** Aparelhos reais e portas da suíte do Gate 5 (valores sobrescrevíveis por ambiente, sem segredos). */
interface DeviceTarget {
  readonly browserName: "chrome" | "safari";
  readonly deviceName: string;
  readonly osVersion: string;
  readonly platformName: "android" | "ios";
}

const ALL_DEVICES: readonly DeviceTarget[] = [
  {
    browserName: "safari",
    deviceName: process.env.GATE5_IOS_DEVICE ?? "iPhone 18 Pro Max",
    osVersion: process.env.GATE5_IOS_VERSION ?? "27",
    platformName: "ios",
  },
  {
    browserName: "chrome",
    deviceName: process.env.GATE5_ANDROID_DEVICE ?? "Google Pixel 11 Pro",
    osVersion: process.env.GATE5_ANDROID_VERSION ?? "17.0",
    platformName: "android",
  },
];

/**
 * O Safari do iPhone real redireciona `localhost` para `http://bs-local.com`, que não é contexto
 * seguro (sem OPFS nem service worker). Por isso o app é servido em HTTPS (certificado
 * autoassinado e descartável) em `bs-local.com`, com `acceptInsecureCerts`.
 */
export const LAB_PORT = Number(process.env.GATE5_LAB_PORT ?? 4443);
export const SHELL_PORT = Number(process.env.GATE5_SHELL_PORT ?? 4444);
export const ORIGIN_HOST = "bs-local.com";
export const labUrl = (path: string) =>
  `https://${ORIGIN_HOST}:${LAB_PORT}${path}`;
export const shellUrl = (path: string) =>
  `https://${ORIGIN_HOST}:${SHELL_PORT}${path}`;

export const HUB = {
  hostname: "hub.browserstack.com",
  path: "/wd/hub",
  port: 443,
  protocol: "https",
} as const;
export const REST = "https://api.browserstack.com/automate";

const FLOW_COUNT = 6;

function listOf(name: string) {
  const raw = process.env[name]?.trim();
  return raw ? raw.split(",").map((item) => item.trim()) : null;
}

const platformFilter = listOf("GATE5_PLATFORMS");
const flowFilter = listOf("GATE5_FLOWS");
const platformNames = ALL_DEVICES.map((device) => device.platformName);
if (platformFilter?.some((name) => !platformNames.some((p) => p === name))) {
  throw new Error(
    `GATE5_PLATFORMS inválido: use ${platformNames.join(" e/ou ")}, separados por vírgula.`
  );
}
const flowNumbers = flowFilter?.map(Number) ?? null;
if (flowNumbers?.some((n) => !Number.isInteger(n) || n < 1 || n > FLOW_COUNT)) {
  throw new Error(
    `GATE5_FLOWS inválido: use números de 1 a ${FLOW_COUNT}, separados por vírgula.`
  );
}

/** `GATE5_PLATFORMS=android` (ou `ios`) restringe a execução, útil para depurar um aparelho. */
export const DEVICES = ALL_DEVICES.filter(
  (device) => !platformFilter || platformFilter.includes(device.platformName)
);
/** `GATE5_FLOWS=2` (ou `1,3`) roda só esses fluxos. */
export const SELECTED_FLOWS = Array.from(
  { length: FLOW_COUNT },
  (_, index) => index + 1
).filter((n) => !flowNumbers || flowNumbers.includes(n));
export const IS_PARTIAL =
  DEVICES.length !== ALL_DEVICES.length || SELECTED_FLOWS.length !== FLOW_COUNT;
