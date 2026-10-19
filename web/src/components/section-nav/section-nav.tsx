import { NavLink } from "react-router-dom";

const SECTIONS = [
  { to: "/", label: "Llamada 1:1", short: "1:1" },
  { to: "/reunion", label: "Reunión", short: "Reunión" },
] as const;

interface SectionNavProps {
  /**
   * Blocks leaving the current section. The 1:1 call lives in the page (mic,
   * avatar, socket), so navigating away mid-call would tear it down; a meeting
   * lives on the server and survives section changes.
   */
  locked?: boolean;
  lockedReason?: string;
}

export function SectionNav({ locked = false, lockedReason }: SectionNavProps) {
  return (
    <nav
      aria-label="Secciones"
      className="flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 p-1"
    >
      {SECTIONS.map((section) => (
        <NavLink
          key={section.to}
          to={section.to}
          end
          title={locked ? lockedReason : undefined}
          onClick={(e) => {
            if (locked) e.preventDefault();
          }}
          className={({ isActive }) =>
            `whitespace-nowrap rounded-full px-2.5 sm:px-3 py-1 text-[11px] font-bold uppercase tracking-wide transition-all ${
              isActive
                ? "bg-white text-navy-600 shadow-2xs border border-neutral-200"
                : locked
                  ? "text-neutral-300 cursor-not-allowed"
                  : "text-neutral-500 hover:text-navy-600"
            }`
          }
        >
          <span className="sm:hidden">{section.short}</span>
          <span className="hidden sm:inline">{section.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
