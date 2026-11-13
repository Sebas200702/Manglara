import type { ReactNode } from "react";
import { Logo } from "../brand";

interface StatusPageProps {
  icon: ReactNode;
  title: string;
  description: string;
  actions: ReactNode;
}

/** Full-screen centered layout shared by the error and not-found pages. */
export function StatusPage({ icon, title, description, actions }: StatusPageProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-neutral-50 px-6 text-center font-sans">
      <Logo />
      <div className="flex max-w-md flex-col items-center gap-3">
        <span className="text-navy-500" aria-hidden>
          {icon}
        </span>
        <h1 className="text-2xl font-extrabold text-navy-700">{title}</h1>
        <p className="text-neutral-600">{description}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">{actions}</div>
    </main>
  );
}

export const primaryButton =
  "inline-flex items-center gap-2 rounded-full bg-brand-500 px-5 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-500";

export const secondaryButton =
  "inline-flex items-center gap-2 rounded-full border border-navy-200 px-5 py-2.5 text-sm font-bold text-navy-600 transition hover:bg-navy-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-500";
