import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false
};

export const ArrowUp = () => (
  <svg {...base} strokeWidth={2.4}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);
export const ArrowDown = () => (
  <svg {...base}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);
export const Stop = () => (
  <svg {...base} stroke="none" fill="currentColor">
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </svg>
);
export const Close = () => (
  <svg {...base}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
export const Pencil = () => (
  <svg {...base}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
export const Check = () => (
  <svg {...base}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
export const Alert = () => (
  <svg {...base}>
    <path d="M12 9v4M12 17h.01" />
    <circle cx="12" cy="12" r="9.5" />
  </svg>
);
export const Chevron = () => (
  <svg {...base}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);
export const ChevronUp = () => (
  <svg {...base}>
    <path d="m6 15 6-6 6 6" />
  </svg>
);
export const Copy = () => (
  <svg {...base}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
);
export const Clock = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const Paperclip = () => (
  <svg {...base}>
    <path d="m21.4 11.1-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
  </svg>
);
export const FileIcon = () => (
  <svg {...base}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const Download = () => (
  <svg {...base}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);
export const Spinner = () => <span className="wasp-spinner" aria-hidden="true" />;
