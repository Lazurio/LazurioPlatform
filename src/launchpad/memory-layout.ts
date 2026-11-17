// The layout of the memory map (Apps → Brain, plan LZD-0033 R11b): the
// force simulation of the approved wireframe (prototypes-lazurio
// `screens/BuddyMemory.tsx`, Obsidian's graph view), which runs d3-force
// with Obsidian's default sliders converted as its `docs/buddy-memory-graph.md`
// records: link distance 250 × 0.3, repulsion 10 × −22 (cut off at 900),
// centre 0.52 × 0.09, link strength 1 ÷ the smaller degree, velocity decay
// 0.45, alpha decay 0.03. The Launchpad bundles no libraries, so this module
// implements the same four forces as d3-force does (Barnes–Hut repulsion,
// θ 0.9), and places the first positions as d3 does (a phyllotaxis spiral),
// so the same memory always opens in the same shape. Pure: memory-panel.ts
// draws it.

export type LayoutNode = {
  readonly id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Links of the node on the map; the size of its dot follows it. */
  degree: number;
  /** Held by the pointer (dragged): the simulation leaves it there. */
  fx: number | null;
  fy: number | null;
};

export type LayoutLink = Readonly<{
  source: LayoutNode;
  target: LayoutNode;
}>;

export const layoutForces = Object.freeze({
  distance: 250 * 0.3,
  charge: -10 * 22,
  chargeMax: 900,
  center: 0.52 * 0.09,
  velocityDecay: 0.45,
  alphaDecay: 0.03,
  alphaMin: 0.001,
  theta2: 0.81,
});

/** Nodes and links for the ids and pairs given, placed on d3's spiral. A
 * link to an id that has no node is left out. Positions of `previous` nodes
 * with the same id are kept. */
export function layoutOf(
  ids: readonly string[],
  pairs: readonly Readonly<{ source: string; target: string }>[],
  previous: ReadonlyMap<string, LayoutNode> = new Map(),
): Readonly<{ nodes: LayoutNode[]; links: LayoutLink[] }> {
  const angle = Math.PI * (3 - Math.sqrt(5));
  const nodes = ids.map((id, index): LayoutNode => {
    const old = previous.get(id);
    if (old !== undefined)
      return { ...old, degree: 0, fx: null, fy: null, vx: 0, vy: 0 };
    const radius = 10 * Math.sqrt(0.5 + index);
    return {
      id,
      x: radius * Math.cos(index * angle),
      y: radius * Math.sin(index * angle),
      vx: 0,
      vy: 0,
      degree: 0,
      fx: null,
      fy: null,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: LayoutLink[] = [];
  for (const pair of pairs) {
    const source = byId.get(pair.source);
    const target = byId.get(pair.target);
    if (source === undefined || target === undefined || source === target)
      continue;
    source.degree += 1;
    target.degree += 1;
    links.push({ source, target });
  }
  return { nodes, links };
}

type Quad = {
  x0: number;
  y0: number;
  size: number;
  /** Total charge weight (number of nodes) and its centre. */
  count: number;
  cx: number;
  cy: number;
  node: LayoutNode | null;
  children: (Quad | null)[] | null;
};

function quad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, count: 0, cx: 0, cy: 0, node: null, children: null };
}

function insert(cell: Quad, node: LayoutNode, depth = 0): void {
  cell.cx = (cell.cx * cell.count + node.x) / (cell.count + 1);
  cell.cy = (cell.cy * cell.count + node.y) / (cell.count + 1);
  cell.count += 1;
  if (cell.children === null && cell.node === null) {
    cell.node = node;
    return;
  }
  // Coincident points stay together in one leaf past a depth.
  if (depth > 40) return;
  if (cell.children === null) {
    cell.children = [null, null, null, null];
    const old = cell.node as LayoutNode;
    cell.node = null;
    place(cell, old, depth);
  }
  place(cell, node, depth);
}

function place(cell: Quad, node: LayoutNode, depth: number): void {
  const half = cell.size / 2;
  const right = node.x >= cell.x0 + half ? 1 : 0;
  const bottom = node.y >= cell.y0 + half ? 1 : 0;
  const index = bottom * 2 + right;
  const children = cell.children as (Quad | null)[];
  let child = children[index] ?? null;
  if (child === null) {
    child = quad(cell.x0 + right * half, cell.y0 + bottom * half, half);
    children[index] = child;
  }
  insert(child, node, depth + 1);
}

function tree(nodes: readonly LayoutNode[]): Quad | null {
  if (nodes.length === 0) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
  }
  const root = quad(x0, y0, Math.max(x1 - x0, y1 - y0, 1) * 1.0001);
  for (const node of nodes) insert(root, node);
  return root;
}

/** One step of the simulation at `alpha`; returns the next alpha. */
export function tick(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[],
  alpha: number,
): number {
  const f = layoutForces;
  // Links: a spring toward the distance, split by degree as d3 does.
  for (const link of links) {
    const { source, target } = link;
    let dx = target.x + target.vx - source.x - source.vx || 1e-6;
    let dy = target.y + target.vy - source.y - source.vy || 1e-6;
    let length = Math.sqrt(dx * dx + dy * dy);
    const strength = 1 / Math.max(1, Math.min(source.degree, target.degree));
    length = ((length - f.distance) / length) * alpha * strength;
    dx *= length;
    dy *= length;
    const bias = source.degree / (source.degree + target.degree || 1);
    target.vx -= dx * bias;
    target.vy -= dy * bias;
    source.vx += dx * (1 - bias);
    source.vy += dy * (1 - bias);
  }
  // Repulsion: Barnes–Hut over a quadtree.
  const root = tree(nodes);
  const max2 = f.chargeMax * f.chargeMax;
  if (root !== null)
    for (const node of nodes) {
      const stack: Quad[] = [root];
      while (stack.length > 0) {
        const cell = stack.pop() as Quad;
        if (cell.count === 0) continue;
        const dx = cell.cx - node.x;
        const dy = cell.cy - node.y;
        const l = dx * dx + dy * dy;
        const far = (cell.size * cell.size) / f.theta2 < l;
        if (cell.children !== null && !far) {
          for (const child of cell.children)
            if (child !== null) stack.push(child);
          continue;
        }
        if (cell.node === node && cell.count === 1) continue;
        if (l >= max2) continue;
        const weight = cell.node === node ? cell.count - 1 : cell.count;
        const w = (f.charge * alpha * weight) / Math.max(l, 1);
        node.vx += dx * w;
        node.vy += dy * w;
      }
    }
  // The centre pulls every node gently to the origin.
  for (const node of nodes) {
    node.vx -= node.x * f.center * alpha;
    node.vy -= node.y * f.center * alpha;
  }
  for (const node of nodes) {
    if (node.fx !== null && node.fy !== null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 1 - f.velocityDecay;
    node.vy *= 1 - f.velocityDecay;
    node.x += node.vx;
    node.y += node.vy;
  }
  return alpha + (0 - alpha) * f.alphaDecay;
}

/** The radius of a node's dot: bigger with more links, as Obsidian's. */
export const radiusOf = (node: Pick<LayoutNode, "degree">): number =>
  3 + Math.sqrt(node.degree) * 1.6;

/** The view that frames every node with a margin, at most 1.1× zoom. */
export function fitView(
  nodes: readonly Pick<LayoutNode, "x" | "y">[],
  width: number,
  height: number,
): Readonly<{ k: number; x: number; y: number }> {
  if (nodes.length === 0 || width <= 0 || height <= 0)
    return { k: 1, x: width / 2, y: height / 2 };
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x);
    y1 = Math.max(y1, node.y);
  }
  const k = Math.min(
    1.1,
    Math.max(0.05, Math.min(width / (x1 - x0 + 140), height / (y1 - y0 + 140))),
  );
  return {
    k,
    x: width / 2 - ((x0 + x1) / 2) * k,
    y: height / 2 - ((y0 + y1) / 2) * k,
  };
}

/** Ids of the nodes whose title or id holds every word of the query
 * (case and diacritics ignored), best first: a title that starts with it,
 * then the others in their order. */
export function findNodes<T extends Readonly<{ id: string; title: string }>>(
  nodes: readonly T[],
  query: string,
): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits = nodes.filter((node) => {
    const text = `${fold(node.title)} ${fold(node.id)}`;
    return words.every((word) => text.includes(word));
  });
  const head = fold(query.trim());
  return [
    ...hits.filter((node) => fold(node.title).startsWith(head)),
    ...hits.filter((node) => !fold(node.title).startsWith(head)),
  ];
}

export const fold = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("cs");
