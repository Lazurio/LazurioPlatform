// The blue silk behind an app template's screen (plan DEV-6593): the fabric
// of the website's article images, chosen for Šablony aplikací in the
// prototype. The offer's id seeds the fold, so every card has its own; the
// colours are the design system's blue ramp, so the fabric is the same in
// light and dark mode. Keep it in step with the prototype's silk.ts.

const RAMP = [
  "var(--lz-blue-950)",
  "var(--lz-blue-800)",
  "var(--lz-blue-700)",
  "var(--lz-blue-500)",
  "var(--lz-blue-400)",
  "var(--lz-blue-300)",
  "var(--lz-blue-200)",
] as const;
const W = 640;
const H = 360;
const RIBBONS = 26;
const STEP = 20;
const SVG = "http://www.w3.org/2000/svg";

function hash(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function random(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const mix = (a: string, b: string, share: number) =>
  `color-mix(in srgb, ${a} ${share}%, ${b})`;

/** A tone on the ramp, as a mix of its two neighbours. */
function tone(t: number): string {
  const n = RAMP.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  const f = Math.round((t * n - i) * 100);
  return mix(RAMP[i] as string, RAMP[i + 1] as string, 100 - f);
}

export type Ribbon = {
  d: string;
  top: string;
  mid: string;
  bottom: string;
  y1: number;
  y2: number;
};

export type Silk = {
  viewBox: string;
  transform: string;
  ribbons: Ribbon[];
};

/** The fabric for a seed: the same seed always folds the same way. */
export function silk(seed: string): Silk {
  const r = random(hash(seed));
  const angle = -10 + r() * 6;
  const phase = r() * 6;
  const y = (k: number, x: number) =>
    -H * 0.6 +
    k * ((H * 2.2) / RIBBONS) +
    H * 0.22 * Math.sin((x / W) * Math.PI * 1.3 + k * 0.16 + phase) +
    H * 0.05 * Math.sin((x / W) * Math.PI * 3.1 + phase * 2);

  const ribbons: Ribbon[] = [];
  for (let k = 0; k < RIBBONS; k++) {
    let d = "";
    for (let x = -W; x <= 2 * W; x += STEP)
      d += `${d ? "L" : "M"}${x} ${y(k, x).toFixed(1)}`;
    for (let x = 2 * W; x >= -W; x -= STEP)
      d += `L${x} ${(y(k + 1, x) + 1).toFixed(1)}`;
    const base = tone(1 - k / (RIBBONS - 1));
    ribbons.push({
      d: `${d}Z`,
      top: mix(base, "white", 78),
      mid: base,
      bottom: mix(base, RAMP[0], 80),
      y1: Number((y(k, W / 2) - H * 0.1).toFixed(1)),
      y2: Number((y(k + 1, W / 2) + H * 0.1).toFixed(1)),
    });
  }

  return {
    viewBox: `0 0 ${W} ${H}`,
    transform: `rotate(${angle.toFixed(1)} ${W / 2} ${H / 2})`,
    ribbons,
  };
}

/** The fabric as an SVG that fills its parent (`.shot-silk`). Its gradients'
 * ids carry the seed, so two fabrics on one page never borrow each other's. */
export function silkStage(seed: string): SVGSVGElement {
  const art = silk(seed);
  const id = `shot-silk-${seed.replace(/[^a-z0-9]/gi, "")}`;
  const node = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Readonly<Record<string, string>>,
  ) => {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes))
      element.setAttribute(name, value);
    return element;
  };
  const root = node("svg", {
    class: "shot-silk",
    viewBox: art.viewBox,
    preserveAspectRatio: "xMidYMid slice",
    "aria-hidden": "true",
  });
  const defs = node("defs", {});
  const group = node("g", { transform: art.transform });
  art.ribbons.forEach((ribbon, k) => {
    const gradient = node("linearGradient", {
      id: `${id}-${k}`,
      gradientUnits: "userSpaceOnUse",
      x1: "0",
      x2: "0",
      y1: String(ribbon.y1),
      y2: String(ribbon.y2),
    });
    gradient.append(
      node("stop", { offset: "0", style: `stop-color: ${ribbon.top}` }),
      node("stop", { offset: ".55", style: `stop-color: ${ribbon.mid}` }),
      node("stop", { offset: "1", style: `stop-color: ${ribbon.bottom}` }),
    );
    defs.append(gradient);
    group.append(node("path", { d: ribbon.d, fill: `url(#${id}-${k})` }));
  });
  root.append(defs, group);
  return root;
}
