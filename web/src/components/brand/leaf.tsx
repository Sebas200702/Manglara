import type { SVGProps } from "react";

/**
 * Leaf mark from the Habilidades Verdes Ya identity — the recurring motif that
 * fills the "D" of the wordmark. Used as a small logo glyph and as a large,
 * low-opacity decorative element on brand surfaces.
 */
export function Leaf(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      {...props}
    >
      <path d="M20.5 3.5c0 8.5-4.2 14.3-11.4 15.6a7.9 7.9 0 0 1-5.6-1 .9.9 0 0 1-.2-1.3C6.5 12 9.8 8.9 15 6.7c.4-.2.6-.6.4-1a.8.8 0 0 0-1-.4C8.7 7.7 5.2 11 2.3 15.9 1 12.4 1.6 8 4.5 5.2 7.8 2 12.9 2.4 17 2.1c1.4-.1 2.6-.3 3.5-.5a.8.8 0 0 1 1 .9c0 .3-.1.7-1 1Z" />
    </svg>
  );
}
