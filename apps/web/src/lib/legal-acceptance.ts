import { useSyncExternalStore } from "react";
import { parseReturnPath } from "./return-path";

/** The acceptance screen: outside the shell, like the sign-in screen and the legal pages (ADR 0100). */
const LEGAL_ACCEPTANCE_PATH = "/aceite";

const trailingSlashes = /\/+$/;
const CHANNEL_NAME = "polaris:legal-acceptance";

export function isLegalAcceptancePath(pathname: string): boolean {
  return (
    (pathname.replace(trailingSlashes, "") || "/") === LEGAL_ACCEPTANCE_PATH
  );
}

/** For the address bar: a slash needs no escape in a query value, and it keeps `voltar=/sales` readable. */
function encodeForAddress(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

/**
 * The acceptance screen with the page to come back to. `returnTo` goes through the same validation as
 * `voltar` on the sign-in screen; one that does not pass, or the acceptance screen itself, is left out.
 */
export function legalAcceptancePath(returnTo?: string | undefined): string {
  const destination = parseReturnPath(returnTo);
  if (!destination || isLegalAcceptancePath(destination.split("?")[0] ?? "")) {
    return LEGAL_ACCEPTANCE_PATH;
  }
  return `${LEGAL_ACCEPTANCE_PATH}?voltar=${encodeForAddress(destination)}`;
}

/** Where `/aceite` goes once accepted: a valid `voltar`, otherwise the start. Never `/aceite` again. */
export function acceptanceReturnPath(search: string): string {
  const destination = parseReturnPath(
    new URLSearchParams(search).get("voltar")
  );
  return destination && !isLegalAcceptancePath(destination.split("?")[0] ?? "")
    ? destination
    : "/";
}

// Module-level, like "the session is over": a call of this page was refused for lack of acceptance. It
// only lives in memory, and goes back to false when the acceptance is recorded (here or in another tab).
let required = false;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setRequired(value: boolean): void {
  if (required === value) {
    return;
  }
  required = value;
  notify();
}

/** Listens, once, for an acceptance recorded in another tab of this browser. */
function listenToOtherTabs(): void {
  if (channel || typeof BroadcastChannel === "undefined") {
    return;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data === "accepted") {
        setRequired(false);
      }
    };
  } catch {
    channel = null; // no cross-tab news: the next page load reads the state again
  }
}

/** A call of this page was refused for lack of the legal acceptance (the shell shows the fixed notice). */
export function markLegalAcceptanceRequired(): void {
  listenToOtherTabs();
  setRequired(true);
}

/** The acceptance was recorded: this tab and the others of the browser stop asking for it. */
export function announceLegalAcceptance(): void {
  setRequired(false);
  try {
    const sender = new BroadcastChannel(CHANNEL_NAME);
    sender.postMessage("accepted");
    sender.close();
  } catch {
    // no BroadcastChannel: the other tabs find out at their next call
  }
}

export function isLegalAcceptanceRequired(): boolean {
  return required;
}

/** Subscribes to the flag (the runtime provider syncs again when it goes back to false). */
export function subscribeLegalAcceptance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLegalAcceptanceRequired(): boolean {
  return useSyncExternalStore(
    subscribeLegalAcceptance,
    isLegalAcceptanceRequired
  );
}
