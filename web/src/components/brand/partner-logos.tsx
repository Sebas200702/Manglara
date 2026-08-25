interface PartnerLogo {
  src: string;
  alt: string;
  /** width / height, used so each logo keeps its natural proportions at a shared height. */
  aspect: number;
}

const PARTNER_LOGOS: PartnerLogo[] = [
    { src: "/logos/plan-international.svg", alt: "Plan International — Hasta lograr la igualdad", aspect: 1.769 },
    { src: "/logos/fci.webp", alt: "Fundación Colombia Incluyente", aspect: 2.549 },
    { src: "/logos/cinop.svg", alt: "CINOP", aspect: 2.93 },
    { src: "/logos/politeknika-txorierri.svg", alt: "Politeknika Txorierri", aspect: 1.935 },
    { src: "/logos/union-europea.svg", alt: "Cofinanciado por la Unión Europea", aspect: 3.535 },
];

export function PartnerLogos({ className = "" }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center justify-center gap-6 md:gap-10 py-4 ${className}`}>
      {PARTNER_LOGOS.map((logo) => (
        <img
          key={logo.src}
          src={logo.src}
          alt={logo.alt}
          title={logo.alt}
          loading="lazy"
          decoding="async"
          className="h-8 md:h-9 w-auto object-contain"
          style={{ aspectRatio: logo.aspect }}
        />
      ))}
    </div>
  );
}
