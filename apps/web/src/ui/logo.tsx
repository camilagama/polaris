/** The provisional mark (v5.1): an "i" whose dot is emerald, one of the few uses of the color. */
export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} viewBox="0 0 24 24">
      <rect
        fill="currentColor"
        height="13"
        rx="1.2"
        width="2.4"
        x="10.8"
        y="9.2"
      />
      <circle cx="12" cy="4.4" fill="var(--mark)" r="2.7" />
    </svg>
  );
}
