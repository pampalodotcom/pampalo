// Sun / Moon glyphs for the public/private metaphor that runs through the
// wallet UI. Kept tiny and inline so they snap to colour via currentColor.

type IconProps = { size?: number; className?: string };

export function SunIcon({ size = 12, className }: IconProps) {
  const rays = [0, 1, 2, 3, 4, 5, 6, 7];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      {rays.map((i) => {
        const a = (i / 8) * Math.PI * 2;
        const x1 = 8 + Math.cos(a) * 5;
        const y1 = 8 + Math.sin(a) * 5;
        const x2 = 8 + Math.cos(a) * 7;
        const y2 = 8 + Math.sin(a) * 7;
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}

export function MoonIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M12 10.5A5.5 5.5 0 015.5 4 5.5 5.5 0 1012 10.5z"
        fill="currentColor"
      />
    </svg>
  );
}
