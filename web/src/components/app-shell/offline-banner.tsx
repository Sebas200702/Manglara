import { WifiOff } from "lucide-react";
import { useSyncExternalStore } from "react";
import { createOnlineStatusSource } from "./online-status";

const onlineStatus = createOnlineStatusSource(window, navigator);

/** Fixed banner shown while the browser reports no network connection. */
export function OfflineBanner() {
  const online = useSyncExternalStore(
    onlineStatus.subscribe,
    onlineStatus.getSnapshot,
    onlineStatus.getServerSnapshot,
  );

  if (online) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-status-warning px-4 py-2 text-sm font-semibold text-navy-900 shadow-md"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden />
      Sin conexión a internet. Revisa tu red.
    </div>
  );
}
