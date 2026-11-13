/**
 * Holds one transient value (toast) that clears itself after `ms`.
 * Showing a new value cancels the previous timer, so a replaced toast is
 * never erased early by the timer of the one before it.
 */
export function createAutoClear<T>(apply: (value: T | null) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    show(value: T) {
      cancel();
      apply(value);
      timer = setTimeout(() => {
        timer = null;
        apply(null);
      }, ms);
    },
    clear() {
      cancel();
      apply(null);
    },
  };
}
