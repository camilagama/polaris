import type { DataChannel } from "./offline-runtime";

/**
 * The browser's tab-to-tab channel for "the local rows changed": two tabs of the
 * same user and organization share one database, and a change made in one must
 * make the screens of the other read again. Carries no data, only the news.
 */
export function openBrowserDataChannel(name: string): DataChannel {
  const channel = new BroadcastChannel(name);
  return {
    close: () => channel.close(),
    post: () => channel.postMessage("changed"),
    subscribe: (listener) => {
      const onMessage = () => listener();
      channel.addEventListener("message", onMessage);
      return () => channel.removeEventListener("message", onMessage);
    },
  };
}
