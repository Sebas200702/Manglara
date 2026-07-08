import type { SVGProps } from "react";

export function PartnerLogos({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-center gap-6 md:gap-10 py-4 ${className}`}>
      {/* EU Logo */}
      <div className="flex items-center gap-2 h-9 text-neutral-800 dark:text-neutral-200">
        <svg viewBox="0 0 30 20" className="h-7 border border-neutral-300 bg-[#003399]" aria-hidden>
          {/* EU Flag stars */}
          <g fill="#FFCC00" transform="translate(15, 10)">
            <g id="star">
              <path d="M0,-2.5 L0.7,-0.7 L2.5,-0.7 L1,-0.2 L1.5,1.5 L0,0.5 L-1.5,1.5 L-1,0.2 L-2.5,-0.7 L-0.7,-0.7 Z" />
            </g>
            <use href="#star" transform="rotate(30) translate(0, -6) rotate(-30)" />
            <use href="#star" transform="rotate(60) translate(0, -6) rotate(-60)" />
            <use href="#star" transform="rotate(90) translate(0, -6) rotate(-90)" />
            <use href="#star" transform="rotate(120) translate(0, -6) rotate(-120)" />
            <use href="#star" transform="rotate(150) translate(0, -6) rotate(-150)" />
            <use href="#star" transform="rotate(180) translate(0, -6) rotate(-180)" />
            <use href="#star" transform="rotate(210) translate(0, -6) rotate(-210)" />
            <use href="#star" transform="rotate(240) translate(0, -6) rotate(-240)" />
            <use href="#star" transform="rotate(270) translate(0, -6) rotate(-270)" />
            <use href="#star" transform="rotate(300) translate(0, -6) rotate(-300)" />
            <use href="#star" transform="rotate(330) translate(0, -6) rotate(-330)" />
            <use href="#star" transform="translate(0, -6)" />
          </g>
        </svg>
        <div className="flex flex-col text-[8px] font-bold leading-none tracking-tight uppercase">
          <span className="text-neutral-500">Co-funded by the</span>
          <span className="text-[9.5px] text-neutral-850">European Union</span>
        </div>
      </div>

      {/* CINOP Logo */}
      <div className="flex items-center h-9">
        <span className="text-xl font-black tracking-tighter text-neutral-900 uppercase">
          CINOP
        </span>
      </div>

      {/* Politeknika Txorierri */}
      <div className="flex items-center gap-1.5 h-9 text-neutral-800">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden>
          <circle cx="12" cy="12" r="10" stroke="#FF5A5F" strokeWidth="2.5" />
          <path d="M12 5 C15.5 5, 17 8.5, 17 12 C17 15.5, 13.5 17, 12 17 C10.5 17, 7 15.5, 7 12 C7 8.5, 8.5 5, 12 5 Z" fill="#9EBF1B" opacity="0.85" />
          <circle cx="12" cy="12" r="2.5" fill="#FFFFFF" />
        </svg>
        <div className="flex flex-col text-[8px] font-extrabold leading-none tracking-wide text-neutral-900 uppercase">
          <span className="text-[9px]">Politeknika</span>
          <span className="text-neutral-550 font-bold">Txorierri</span>
        </div>
      </div>

      {/* Fundación Colombia Incluyente */}
      <div className="flex items-center gap-1.5 h-9">
        <svg viewBox="0 0 32 32" fill="none" className="h-7 w-7" aria-hidden>
          <path d="M16 4C9.37 4 4 9.37 4 16C4 22.63 9.37 28 16 28C22.63 28 28 22.63 28 16C28 9.37 22.63 4 16 4ZM16 25C11.03 25 7 20.97 7 16C7 11.03 11.03 7 16 7C20.97 7 25 11.03 25 16C25 20.97 20.97 25 16 25Z" fill="#1D436F" />
          <path d="M16 9C12.13 9 9 12.13 9 16C9 19.87 12.13 23 16 23C19.87 23 23 19.87 23 16" stroke="#9EBF1B" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="16" cy="16" r="3" fill="#FFAB4D" />
        </svg>
        <div className="flex flex-col text-[7px] font-extrabold leading-[1.1] text-navy-600 uppercase">
          <span className="font-normal text-neutral-500 text-[6.5px] tracking-wider">Fundación</span>
          <span className="text-[9px] tracking-tight font-black text-[#1D436F]">Colombia</span>
          <span className="text-[9.5px] tracking-tighter text-[#9EBF1B]">Incluyente</span>
        </div>
      </div>

      {/* Plan International */}
      <div className="flex items-center gap-1.5 h-9">
        <svg viewBox="0 0 24 24" className="h-6 w-6 text-[#005CA9]" fill="currentColor" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6.5C10.6 6.5 9.5 7.6 9.5 9C9.5 10.4 10.6 11.5 12 11.5C13.4 11.5 14.5 10.4 14.5 9C14.5 7.6 13.4 6.5 12 6.5ZM12 12.5C9.5 12.5 6.5 13.8 6.5 16.2V17.5H17.5V16.2C17.5 13.8 14.5 12.5 12 12.5Z" fill="#FFFFFF" />
        </svg>
        <div className="flex flex-col leading-none text-navy-800">
          <div className="flex items-baseline gap-0.5 text-[8.5px] font-black uppercase tracking-tighter text-[#005CA9]">
            <span>Plan</span>
            <span className="text-[6.5px] font-medium tracking-normal text-[#005CA9]">International</span>
          </div>
          <span className="text-[5.5px] font-semibold text-neutral-450 leading-none">
            Hasta lograr la igualdad
          </span>
        </div>
      </div>
    </div>
  );
}
