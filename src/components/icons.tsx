import type { SVGProps } from "react";

const base: SVGProps<SVGSVGElement> = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export const PenIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 20l4-1L19 8a2 2 0 0 0-3-3L5 16l-1 4z" />
    <path d="M14.5 6.5l3 3" />
  </svg>
);

export const CursorIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M5 4l6.5 15 2-6 6-2L5 4z" />
  </svg>
);

export const ArrowIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 12h14" />
    <path d="M13 7l6 5-6 5" />
  </svg>
);

export const LineIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 12h16" />
  </svg>
);

export const UndoIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M9 7L4 12l5 5" />
    <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
  </svg>
);

export const ClearIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 7h16" />
    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    <path d="M6 7l1 13h10l1-13" />
  </svg>
);

export const ExportIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 4v11" />
    <path d="M8 8l4-4 4 4" />
    <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
  </svg>
);

export const ImageIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="M5 18l5-5 4 4 2-2 3 3" />
  </svg>
);

export const SampleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="12" r="2.5" />
    <rect x="14" y="5" width="6" height="5" rx="1" />
    <rect x="14" y="14" width="6" height="5" rx="1" />
    <path d="M8.3 11l5.7-3.5" />
    <path d="M8.3 13l5.7 3.5" />
  </svg>
);

export const HandIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M11 11V5.5a1.5 1.5 0 0 1 3 0V11" />
    <path d="M14 11V6.5a1.5 1.5 0 0 1 3 0V13" />
    <path d="M8 12v-1a1.5 1.5 0 0 0-3 0v3a6 6 0 0 0 6 6h1a6 6 0 0 0 6-6" />
  </svg>
);
