// The Armada mark (design/dashboard-v4/logo.dc.html, "Formation"): five agents in a V, the first leads.
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="sh-logo">
      <path d="M16 4.5L20 11.5H12Z" fill="#b6f15a" />
      <path d="M10 13L14 20H6Z" fill="#f0efec" />
      <path d="M22 13L26 20H18Z" fill="#f0efec" />
      <path d="M4 21.5L8 28.5H0Z" fill="#f0efec" fillOpacity=".45" />
      <path d="M28 21.5L32 28.5H24Z" fill="#f0efec" fillOpacity=".45" />
    </svg>
  );
}

/** The search glass of the sidebar and the palette. */
export function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden style={{ flex: "none" }}>
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
