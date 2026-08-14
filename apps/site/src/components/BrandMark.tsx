export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="djbooth.ai"
    >
      <rect width="64" height="64" rx="16" fill="currentColor" opacity="0.1" />
      <circle cx="32" cy="32" r="20" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.35" />
      <circle cx="32" cy="32" r="5" fill="#050505" stroke="currentColor" strokeWidth="3" />
      <g fill="currentColor">
        <rect x="12" y="29" width="4" height="6" rx="2" />
        <rect x="19" y="23" width="4" height="18" rx="2" />
        <rect x="26" y="17" width="4" height="30" rx="2" />
        <rect x="34" y="20" width="4" height="24" rx="2" />
        <rect x="41" y="25" width="4" height="14" rx="2" />
        <rect x="48" y="29" width="4" height="6" rx="2" />
      </g>
    </svg>
  );
}
