import { useEffect, useRef } from "react";

/**
 * Keyboard and focus behavior for the panel's modal dialogs: moves focus
 * into the dialog when it opens, closes on Escape (when `canClose`), and
 * returns focus to the element that opened it when it closes.
 */
export function useDialogA11y<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  canClose = true,
) {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const canCloseRef = useRef(canClose);
  onCloseRef.current = onClose;
  canCloseRef.current = canClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    const first = container?.querySelector<HTMLElement>(
      "[data-autofocus], button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
    );
    (first ?? container)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && canCloseRef.current) {
        event.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  return containerRef;
}
