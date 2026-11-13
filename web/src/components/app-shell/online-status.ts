/**
 * Browser connectivity as a `useSyncExternalStore` source. Kept free of React
 * and of globals so it can be unit-tested with a fake event target.
 */
export interface OnlineStatusSource {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
  getServerSnapshot: () => boolean;
}

export function createOnlineStatusSource(
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  nav: { onLine: boolean } | undefined,
): OnlineStatusSource {
  return {
    subscribe(onChange) {
      target.addEventListener("online", onChange);
      target.addEventListener("offline", onChange);
      return () => {
        target.removeEventListener("online", onChange);
        target.removeEventListener("offline", onChange);
      };
    },
    // Unknown connectivity is treated as online so we never show a false alarm.
    getSnapshot: () => nav?.onLine ?? true,
    getServerSnapshot: () => true,
  };
}
