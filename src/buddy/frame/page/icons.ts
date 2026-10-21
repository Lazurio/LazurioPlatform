// Icons of Buddy's frame: Iconoir (MIT, https://iconoir.com; licence in
// src/shell/vendor/LICENSE-iconoir.txt), the set the Lazurio design system
// mandates, with the path data of iconoir-react 7.12.1 the prototype's
// BuddyWidget draws (prototypes-lazurio `app/v1/src/Icon.tsx`), at the
// shell's stroke of 1.6. Stop is a plain filled square.

const round =
  'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

const paths = {
  image: `<path d="M21 3.6V20.4C21 20.7314 20.7314 21 20.4 21H3.6C3.26863 21 3 20.7314 3 20.4V3.6C3 3.26863 3.26863 3 3.6 3H20.4C20.7314 3 21 3.26863 21 3.6Z" ${round}/><path d="M3 16L10 13L21 18" ${round}/><path d="M16 10C14.8954 10 14 9.10457 14 8C14 6.89543 14.8954 6 16 6C17.1046 6 18 6.89543 18 8C18 9.10457 17.1046 10 16 10Z" ${round}/>`,
  attach: `<path d="M21.4383 11.6622L12.2483 20.8522C11.1225 21.9781 9.59552 22.6106 8.00334 22.6106C6.41115 22.6106 4.88418 21.9781 3.75834 20.8522C2.63249 19.7264 2 18.1994 2 16.6072C2 15.015 2.63249 13.4881 3.75834 12.3622L12.9483 3.17222C13.6989 2.42166 14.7169 2 15.7783 2C16.8398 2 17.8578 2.42166 18.6083 3.17222C19.3589 3.92279 19.7806 4.94077 19.7806 6.00222C19.7806 7.06368 19.3589 8.08166 18.6083 8.83222L9.40834 18.0222C9.03306 18.3975 8.52406 18.6083 7.99334 18.6083C7.46261 18.6083 6.95362 18.3975 6.57834 18.0222C6.20306 17.6469 5.99222 17.138 5.99222 16.6072C5.99222 16.0765 6.20306 15.5675 6.57834 15.1922L15.0683 6.71222" ${round}/>`,
  pin: `<path d="M20 10C20 14.4183 12 22 12 22C12 22 4 14.4183 4 10C4 5.58172 7.58172 2 12 2C16.4183 2 20 5.58172 20 10Z" stroke="currentColor"/><path d="M12 11C12.5523 11 13 10.5523 13 10C13 9.44772 12.5523 9 12 9C11.4477 9 11 9.44772 11 10C11 10.5523 11.4477 11 12 11Z" fill="currentColor" ${round}/>`,
  send: `<path d="M22.1525 3.55321L11.1772 21.0044L9.50686 12.4078L2.00002 7.89795L22.1525 3.55321Z" ${round}/><path d="M9.45557 12.4436L22.1524 3.55321" ${round}/>`,
  enlarge: `<path d="M15 9L20 4M20 4V8M20 4H16" ${round}/><path d="M9 15L4 20M4 20V16M4 20H8" ${round}/>`,
  reduce: `<path d="M4 20L9 15M9 15V19M9 15H5" ${round}/><path d="M20 4L15 9M15 9V5M15 9H19" ${round}/>`,
  x: `<path d="M6.75827 17.2426L12.0009 12M17.2435 6.75736L12.0009 12M12.0009 12L6.75827 6.75736M12.0009 12L17.2435 17.2426" ${round}/>`,
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
} as const;

export type FrameIcon = keyof typeof paths;

/** One icon of `size` pixels in the current colour, hidden from assistive
 * technology: its control names itself. */
export function icon(name: FrameIcon, size = 18): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("aria-hidden", "true");
  // Fixed path data of this module, never data from a message.
  svg.innerHTML = paths[name];
  return svg;
}
