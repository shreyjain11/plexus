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

export const RectIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="4" y="6" width="16" height="12" rx="2" />
  </svg>
);

export const EllipseIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="12" rx="8" ry="6" />
  </svg>
);

export const DiamondIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 4l8 8-8 8-8-8 8-8z" />
  </svg>
);

export const TextIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M5 6h14" />
    <path d="M12 6v13" />
    <path d="M9 19h6" />
  </svg>
);

export const RedoIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M15 7l5 5-5 5" />
    <path d="M20 12H9a5 5 0 0 0 0 10h1" />
  </svg>
);

export const SaveIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 15V4" />
    <path d="M8 11l4 4 4-4" />
    <path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" />
    <circle cx="12" cy="15" r="0.1" />
  </svg>
);

export const OpenIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 4v11" />
    <path d="M16 11l-4 4-4-4" />
    <path d="M5 19h14" />
  </svg>
);

export const HelpIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.9c-.8.4-1 .9-1 1.7" />
    <circle cx="12" cy="17" r="0.4" fill="currentColor" />
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

export const WriteIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 16c2-6 4-9 5-9s-1 10 0 10 2.5-5 3.5-5 .5 5 1.5 5 2-3 6-3" />
    <path d="M4 20h16" strokeDasharray="2.5 2.5" />
  </svg>
);

export const TriangleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M12 5l8 14H4l8-14z" />
  </svg>
);

export const HexagonIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M8 5h8l4 7-4 7H8l-4-7 4-7z" />
  </svg>
);

export const ParallelogramIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M8.5 6H21l-5.5 12H3L8.5 6z" />
  </svg>
);

export const CylinderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <ellipse cx="12" cy="6" rx="7" ry="2.6" />
    <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
  </svg>
);

export const SunIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" />
  </svg>
);

export const MoonIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </svg>
);

export const CommandIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M9 9V6a3 3 0 1 0-3 3h3zm0 0v6m0-6h6m-6 6H6a3 3 0 1 0 3 3v-3zm6-6V6a3 3 0 1 1 3 3h-3zm0 0v6m0 0h3a3 3 0 1 1-3 3v-3z" />
  </svg>
);

export const ReplayIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M4 5v5h5" />
    <path d="M4.6 13a8 8 0 1 0 1.7-6L4 10" />
  </svg>
);
