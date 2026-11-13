// Must match AVATAR_URL in components/avatar/avatar-controller.ts.
const AVATAR_URL = import.meta.env.VITE_AVATAR_URL ?? "/custom_avatar.glb";

/**
 * Starts downloading the avatar GLB while the avatar route's JS chunks
 * (three.js + TalkingHead) are still loading, instead of after them.
 * `as="fetch"` + `crossorigin` matches the GLTFLoader fetch so the browser
 * reuses the preloaded response. Idempotent.
 */
export function preloadAvatar() {
  if (typeof document === "undefined") return;
  if (document.querySelector('link[data-preload="avatar"]')) return;
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "fetch";
  link.crossOrigin = "anonymous";
  link.href = AVATAR_URL;
  link.dataset.preload = "avatar";
  document.head.appendChild(link);
}
