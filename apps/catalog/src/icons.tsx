/** Inline icons, written by hand: `currentColor`, no style attribute, no external reference (ADR 0103). */
const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
  viewBox: "0 0 24 24",
} as const;

export function WhatsAppIcon() {
  return (
    <svg aria-hidden="true" {...LINE}>
      <path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 21l2.1-5.5A8.4 8.4 0 1 1 21 11.5Z" />
    </svg>
  );
}

export function InstagramIcon() {
  return (
    <svg aria-hidden="true" {...LINE}>
      <rect height="20" rx="5" width="20" x="2" y="2" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" />
    </svg>
  );
}

export function ChevronLeftIcon() {
  return (
    <svg aria-hidden="true" {...LINE}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg aria-hidden="true" {...LINE}>
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}
