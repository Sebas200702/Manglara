/**
 * Stylized mangrove backdrop — same graphic language as the previous
 * "Organic Landscape" SVG (flat vector, brand greens, low opacity, subtle
 * motion). Sits behind the avatar as a bottom band: mangrove clumps with the
 * iconic arching prop-roots over a shimmering waterline, framed toward the
 * sides so the character stays clear in the center.
 */

type Clump = {
  x: number; // horizontal center in viewBox units
  s: number; // scale
  tone: string; // canopy fill
  toneBack: string; // back-canopy fill
  root: string; // trunk + root stroke
  dur: number; // sway duration (s)
  delay: number; // sway delay (s)
  o: number; // layer opacity
};

// Back-to-front, sides-weighted so the avatar's center stays uncluttered.
const CLUMPS: Clump[] = [
  { x: 120, s: 1.15, tone: "#9ebf1b", toneBack: "#c3d55a", root: "#4f6018", dur: 7.5, delay: 0, o: 0.9 },
  { x: 880, s: 1.05, tone: "#86a417", toneBack: "#b6cd28", root: "#425017", dur: 8.5, delay: 1.2, o: 0.9 },
  { x: 250, s: 0.7, tone: "#b6cd28", toneBack: "#dde8b7", root: "#667d16", dur: 9, delay: 0.6, o: 0.6 },
  { x: 760, s: 0.62, tone: "#c3d55a", toneBack: "#dde8b7", root: "#667d16", dur: 10, delay: 1.8, o: 0.55 },
  { x: 500, s: 0.5, tone: "#dde8b7", toneBack: "#eef3d8", root: "#86a417", dur: 11, delay: 0.3, o: 0.4 },
];

function MangroveClump({ x, s, tone, toneBack, root, dur, delay, o }: Clump) {
  // Local space: trunk base sits at (0, 250) = the waterline.
  return (
    <g transform={`translate(${x} 0) scale(${s})`} opacity={o}>
      {/* faint reflection under the waterline */}
      <g transform="translate(0 500) scale(1 -1)" opacity="0.16">
        <ellipse cx="0" cy="150" rx="70" ry="42" fill={tone} />
      </g>

      {/* prop / stilt roots fanning into the water (mangrove signature) */}
      <g fill="none" stroke={root} strokeWidth="3" strokeLinecap="round">
        <path d="M0,250 C-34,236 -52,262 -58,286" />
        <path d="M0,250 C-16,240 -22,266 -24,290" />
        <path d="M0,250 C16,240 24,264 26,289" />
        <path d="M0,250 C34,236 54,260 60,285" />
        <path d="M0,250 C4,238 6,266 4,292" />
      </g>

      {/* trunk + canopy sway together, pivoting at the waterline */}
      <g
        className="animate-mangrove-sway"
        style={{
          transformBox: "fill-box",
          transformOrigin: "50% 92%",
          animationDuration: `${dur}s`,
          animationDelay: `${delay}s`,
        }}
      >
        {/* trunks */}
        <g fill="none" stroke={root} strokeWidth="5" strokeLinecap="round">
          <path d="M0,252 C-6,210 -10,190 -14,168" />
          <path d="M0,252 C6,208 12,188 16,166" />
        </g>
        {/* back canopy */}
        <ellipse cx="-6" cy="150" rx="66" ry="40" fill={toneBack} />
        {/* front canopy blobs */}
        <ellipse cx="-26" cy="146" rx="38" ry="28" fill={tone} />
        <ellipse cx="22" cy="140" rx="42" ry="30" fill={tone} />
        <ellipse cx="0" cy="120" rx="34" ry="26" fill={tone} />
      </g>
    </g>
  );
}

export function MangroveBackdrop({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1000 400"
      preserveAspectRatio="xMidYMax slice"
      className={`pointer-events-none select-none ${className}`}
      aria-hidden
    >
      {/* water band */}
      <rect x="0" y="250" width="1000" height="150" fill="#9ebf1b" opacity="0.1" />
      <rect x="0" y="250" width="1000" height="150" fill="#1d436f" opacity="0.05" />

      {/* distant canopy line for depth */}
      <path
        d="M0,232 C120,214 200,236 320,222 C460,206 560,234 700,220 C820,208 920,232 1000,222 L1000,252 L0,252 Z"
        fill="#dde8b7"
        opacity="0.5"
      />

      {/* water shimmer */}
      <g stroke="#f7f9ec" strokeLinecap="round" opacity="0.5">
        <line
          className="animate-water-shimmer"
          x1="120" y1="286" x2="240" y2="286" strokeWidth="2"
          style={{ animationDuration: "6s" }}
        />
        <line
          className="animate-water-shimmer"
          x1="640" y1="300" x2="800" y2="300" strokeWidth="2"
          style={{ animationDuration: "7.5s", animationDelay: "1s" }}
        />
        <line
          className="animate-water-shimmer"
          x1="420" y1="326" x2="540" y2="326" strokeWidth="1.5"
          style={{ animationDuration: "8.5s", animationDelay: "2s" }}
        />
      </g>

      {CLUMPS.map((c) => (
        <MangroveClump key={c.x} {...c} />
      ))}
    </svg>
  );
}
