import {
  findNodes,
  fitView,
  forcesOf,
  type LayoutLink,
  type LayoutNode,
  layoutForces,
  layoutOf,
  radiusOf,
  tick,
} from "./memory-layout";
import {
  defaultMemorySettings,
  loadMemorySettings,
  type MemorySettings,
  memoryGroupOf,
  saveMemorySettings,
  settingRanges,
  shownGraph,
  swatches,
} from "./memory-settings";
import {
  type MemoryMapModel,
  type MemoryPageModel,
  markdownBlocks,
  markdownRuns,
  memoryCount,
  memoryDate,
  memoryRetries,
  memoryStateLine,
  memoryTruncatedLine,
  memoryTypeLabel,
  parseMemoryMap,
  parseMemoryPage,
} from "./memory-view";
import type { MessageKey } from "./messages";

type Copy = Readonly<Record<MessageKey, string>>;
type Answer = Promise<{ value: unknown; ok: boolean }>;

// Apps → Brain (plan LZD-0033 R11b): the map of the person's memory as the
// approved wireframe draws it (prototypes-lazurio `screens/BuddyMemory.tsx`,
// Obsidian's graph view): dots on a canvas, the hovered one and its
// neighbours lit and the rest faded, labels that come with zoom, a dot to
// drag, the wheel and a pinch to zoom, empty space to pan; "Najít
// vzpomínku" at the top left; a click opens the memory in the panel beside
// the map (under it on a narrow screen) with its facts, text and links.
// Read only: the page never writes to the memory. Read on first view and
// on Refresh; every server value is drawn as text.

type View = { k: number; x: number; y: number };

export function createMemoryPanel(
  input: Readonly<{
    get: (path: string) => Answer;
    copy: () => Copy;
    locale: () => "cs" | "en";
    /** Whether the page shows the map now. */
    shown: () => boolean;
  }>,
) {
  const $ = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;
  const graphBox = $<HTMLElement>("memory-graph");
  const canvas = $<HTMLCanvasElement>("memory-canvas");
  const stateBox = $<HTMLElement>("memory-state");
  const stateLine = $<HTMLElement>("memory-state-line");
  const stateRetry = $<HTMLButtonElement>("memory-state-retry");
  const countLine = $<HTMLElement>("memory-count");
  const find = $<HTMLInputElement>("memory-find");
  const findList = $<HTMLElement>("memory-find-list");
  const note = $<HTMLElement>("memory-note");
  const body = $<HTMLElement>("memory-body");
  const refreshButton = $<HTMLButtonElement>("memory-refresh");
  const zoomIn = $<HTMLButtonElement>("memory-zoom-in");
  const zoomOut = $<HTMLButtonElement>("memory-zoom-out");
  const zoomFit = $<HTMLButtonElement>("memory-zoom-fit");
  const gear = $<HTMLButtonElement>("memory-gear");
  const settingsBox = $<HTMLElement>("memory-settings");
  const localBar = $<HTMLElement>("memory-local");
  const nothingShown = $<HTMLElement>("memory-nothing");
  /** The viewer's own browser keeps the graph's settings (R11c). */
  const storage = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  const reduced = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  let loaded = false;
  let reading = false;
  let model: MemoryMapModel | null = null;
  let nodes: LayoutNode[] = [];
  let links: LayoutLink[] = [];
  let titles = new Map<string, string>();
  /** Every memory of the map and its links, as read; `nodes` and `links`
   * are what the map shows of them (filters, local graph, animation). */
  let data: Extract<MemoryMapModel, { state: "ready" }> | null = null;
  let settings: MemorySettings = loadMemorySettings(storage());
  let simForces = forcesOf(settings.forces);
  /** The memory whose local graph the map shows, or null for all. */
  let localCenter: string | null = null;
  /** While Animovat plays: the memories born before it show. */
  let step: number | null = null;
  let animation: ReturnType<typeof setInterval> | undefined;
  let settingsOpen = false;
  /** Where each memory last stood, so a change of what shows keeps it. */
  const positions = new Map<string, LayoutNode>();
  let colors = new Map<string, number>();
  let neighbours = new Map<string, Set<string>>();
  let view: View = { k: 1, x: 0, y: 0 };
  let size = { w: 0, h: 0 };
  let alpha = 0;
  let frame = 0;
  let hovered: string | null = null;
  let chosen: string | null = null;
  let fitted = false;
  let pageRequest = 0;

  // ---- reading -----------------------------------------------------------

  async function refresh(fresh = false) {
    if (reading) return;
    reading = true;
    if (!loaded) drawState(null);
    refreshButton?.setAttribute("aria-busy", "true");
    let next: MemoryMapModel;
    try {
      const { value } = await input.get(
        fresh ? "/api/memory?fresh=1" : "/api/memory",
      );
      next = parseMemoryMap(value);
    } catch {
      next = { state: "failed" };
    }
    reading = false;
    loaded = true;
    refreshButton?.removeAttribute("aria-busy");
    model = next;
    if (next.state === "ready") setGraph(next);
    else {
      stop();
      nodes = [];
      links = [];
    }
    render();
  }

  function setGraph(map: Extract<MemoryMapModel, { state: "ready" }>) {
    const first = data === null;
    data = map;
    titles = new Map(map.nodes.map((node) => [node.id, node.title]));
    if (chosen !== null && !titles.has(chosen)) chosen = null;
    if (localCenter !== null && !titles.has(localCenter)) localCenter = null;
    recolor();
    relayout(first || !fitted);
  }

  /** The colour group of each memory, by the settings' groups. */
  function recolor() {
    colors = new Map(
      (data?.nodes ?? []).map((node) => [
        node.id,
        memoryGroupOf(settings.groups, node),
      ]),
    );
  }

  /** Lays out what the map shows now; `fit` settles it quietly and frames
   * it, as the wireframe does on open and on a new local graph. */
  function relayout(fit: boolean) {
    if (data === null) return;
    const shown = shownGraph(
      data.nodes,
      data.links,
      settings,
      localCenter,
      step,
    );
    const laid = layoutOf(shown.ids, shown.links, positions);
    nodes = laid.nodes;
    links = laid.links;
    for (const node of nodes) positions.set(node.id, node);
    neighbours = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    for (const link of links) {
      neighbours.get(link.source.id)?.add(link.target.id);
      neighbours.get(link.target.id)?.add(link.source.id);
    }
    if (nothingShown !== null) nothingShown.hidden = nodes.length > 0;
    if (fit) {
      // With reduced motion it settles fully and stands still.
      alpha = 1;
      const steps = reduced() ? 300 : 120;
      for (let index = 0; index < steps; index += 1)
        alpha = tick(nodes, links, alpha, simForces);
      measure();
      view = fitView(nodes, size.w, size.h);
      fitted = size.w > 0;
      alpha = reduced() ? 0 : 0.12;
    } else alpha = Math.max(alpha, reduced() ? 0 : 0.3);
    drawLocal();
    run();
  }

  // ---- drawing -----------------------------------------------------------

  function render() {
    const copy = input.copy();
    const locale = input.locale();
    const ready = model?.state === "ready";
    if (graphBox !== null) graphBox.hidden = !ready;
    if (!ready) {
      drawState(model);
      if (note !== null) note.hidden = true;
      body?.classList.remove("has-note");
      return;
    }
    if (stateBox !== null) stateBox.hidden = true;
    const map = model as Extract<MemoryMapModel, { state: "ready" }>;
    // As in the wireframe, the map carries no count; only a cut map says
    // so, since it does not show everything.
    if (countLine !== null) {
      countLine.hidden = !map.truncated;
      countLine.textContent = map.truncated
        ? `${memoryCount(nodes.length, links.length, copy, locale)} · ${memoryTruncatedLine(nodes.length, copy, locale)}`
        : "";
    }
    canvas?.setAttribute(
      "aria-label",
      `${copy.memoryCanvasLabel} ${memoryCount(nodes.length, links.length, copy, locale)}`,
    );
    relabel(copy);
    drawSettings();
    drawLocal();
    measure();
    if (!fitted && size.w > 0) {
      view = fitView(nodes, size.w, size.h);
      fitted = true;
    }
    draw();
  }

  /** The words of the icon buttons and the field, which carry no text. */
  function relabel(copy: Copy) {
    if (find !== null) {
      find.placeholder = copy.memoryFind;
      find.setAttribute("aria-label", copy.memoryFind);
    }
    for (const [button, label] of [
      [zoomIn, copy.memoryZoomIn],
      [zoomOut, copy.memoryZoomOut],
      [zoomFit, copy.memoryZoomFit],
    ] as const) {
      button?.setAttribute("aria-label", label);
      if (button !== null) button.title = label;
    }
  }

  function drawState(next: MemoryMapModel | null) {
    if (stateBox === null || stateLine === null) return;
    const copy = input.copy();
    stateBox.hidden = false;
    if (next === null || next.state === "ready") {
      stateLine.textContent = copy.memoryLoading;
      if (stateRetry !== null) stateRetry.hidden = true;
      return;
    }
    stateLine.textContent = memoryStateLine(next.state, copy);
    stateBox.dataset.state = next.state;
    if (stateRetry !== null) stateRetry.hidden = !memoryRetries(next.state);
  }

  function measure() {
    if (canvas === null) return;
    const box = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (box.width !== size.w || box.height !== size.h) {
      size = { w: box.width, h: box.height };
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
    }
  }

  const token = (style: CSSStyleDeclaration, name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;

  function draw() {
    const context = canvas?.getContext("2d");
    if (canvas === null || !context || size.w === 0) return;
    const style = getComputedStyle(canvas);
    const ink = token(style, "--lz-ink", "#16161d");
    const paper = token(style, "--memory-paper", "#fff");
    const line = token(style, "--lz-gray-300", "#cfcfd4");
    const dot = token(style, "--lz-gray-500", "#8a8a93");
    const accent = token(style, "--lz-accent", "#2f6bff");
    const swatchColor = new Map(
      swatches.map((swatch) => [swatch.id, token(style, swatch.token, dot)]),
    );
    const groupColor = (id: string): string => {
      const index = colors.get(id) ?? -1;
      const group = index < 0 ? undefined : settings.groups[index];
      return group === undefined ? dot : (swatchColor.get(group.color) ?? dot);
    };
    const show = settings.display;
    const font = token(style, "--lz-font-sans", "sans-serif");
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(
      ratio * view.k,
      0,
      0,
      ratio * view.k,
      ratio * view.x,
      ratio * view.y,
    );
    const focus = hovered ?? null;
    const lit = (id: string) =>
      focus === null || id === focus || neighbours.get(focus)?.has(id) === true;
    const fade = (id: string) => (lit(id) ? 1 : 0.15);
    // Links.
    context.lineWidth = show.linkThickness / Math.max(view.k, 0.35);
    for (const link of links) {
      const on =
        focus !== null &&
        (link.source.id === focus || link.target.id === focus);
      context.globalAlpha = focus === null ? 0.9 : on ? 1 : 0.08;
      context.strokeStyle = on ? accent : line;
      context.beginPath();
      context.moveTo(link.source.x, link.source.y);
      context.lineTo(link.target.x, link.target.y);
      context.stroke();
      if (show.arrows) {
        // Šipky: a head at the target's edge, as the wireframe draws it.
        const angle = Math.atan2(
          link.target.y - link.source.y,
          link.target.x - link.source.x,
        );
        const r = radiusOf(link.target, show.nodeSize) + 1;
        const tipX = link.target.x - Math.cos(angle) * r;
        const tipY = link.target.y - Math.sin(angle) * r;
        const head = 3 + 2.5 * show.linkThickness;
        context.fillStyle = context.strokeStyle;
        context.beginPath();
        context.moveTo(tipX, tipY);
        context.lineTo(
          tipX - Math.cos(angle - 0.45) * head,
          tipY - Math.sin(angle - 0.45) * head,
        );
        context.lineTo(
          tipX - Math.cos(angle + 0.45) * head,
          tipY - Math.sin(angle + 0.45) * head,
        );
        context.closePath();
        context.fill();
      }
    }
    // Dots.
    for (const node of nodes) {
      const r = radiusOf(node, show.nodeSize);
      context.globalAlpha = fade(node.id);
      context.fillStyle = node.id === hovered ? accent : groupColor(node.id);
      context.beginPath();
      context.arc(node.x, node.y, r, 0, Math.PI * 2);
      context.fill();
      if (node.id === chosen) {
        context.globalAlpha = 1;
        context.strokeStyle = ink;
        context.lineWidth = 2 / view.k;
        context.beginPath();
        context.arc(node.x, node.y, r + 3 / view.k, 0, Math.PI * 2);
        context.stroke();
      }
    }
    // Labels come with zoom; the hovered dot, its neighbours and the open
    // memory always show theirs, at a readable size.
    // Zobrazení popisků (Obsidian's text fade threshold, −3 to 3).
    const threshold = 0.85 * 2 ** (show.textFade * 0.5);
    const zoomAlpha = Math.min(
      1,
      Math.max(0, (view.k - threshold * 0.6) / (threshold * 0.5)),
    );
    context.textAlign = "center";
    context.textBaseline = "top";
    context.lineJoin = "round";
    for (const node of nodes) {
      const always = (focus !== null && lit(node.id)) || node.id === chosen;
      const alphaHere = always ? 1 : zoomAlpha * fade(node.id);
      if (alphaHere < 0.02) continue;
      const scale = always ? Math.max(1, 1 / view.k) : 1;
      context.font = `500 ${11 * scale}px ${font}`;
      context.globalAlpha = alphaHere;
      const label = titles.get(node.id) ?? node.id;
      const y = node.y + radiusOf(node, show.nodeSize) + 4;
      context.strokeStyle = paper;
      context.lineWidth = 3 * scale;
      context.strokeText(label, node.x, y);
      context.fillStyle = ink;
      context.fillText(label, node.x, y);
    }
    context.globalAlpha = 1;
  }

  function drawSoon() {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (alpha > layoutForces.alphaMin) {
        alpha = tick(nodes, links, alpha, simForces);
        drawSoon();
      }
      draw();
    });
  }
  const run = () => drawSoon();
  function stop() {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    alpha = 0;
  }

  // ---- the camera ----------------------------------------------------------

  const toWorld = (px: number, py: number) => ({
    x: (px - view.x) / view.k,
    y: (py - view.y) / view.k,
  });
  function zoomAt(factor: number, px = size.w / 2, py = size.h / 2) {
    const k = Math.min(8, Math.max(0.05, view.k * factor));
    const world = toWorld(px, py);
    view = { k, x: px - world.x * k, y: py - world.y * k };
    drawSoon();
  }
  function glideTo(id: string) {
    const node = nodes.find((item) => item.id === id);
    if (node === undefined) return;
    measure();
    const k = Math.max(view.k, 1);
    const goal = { k, x: size.w / 2 - node.x * k, y: size.h / 2 - node.y * k };
    if (reduced()) {
      view = goal;
      drawSoon();
      return;
    }
    const start = { ...view };
    const began = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - began) / 350);
      const e = t * (2 - t);
      view = {
        k: start.k + (goal.k - start.k) * e,
        x: start.x + (goal.x - start.x) * e,
        y: start.y + (goal.y - start.y) * e,
      };
      draw();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function nodeAt(px: number, py: number): LayoutNode | null {
    const world = toWorld(px, py);
    let best: LayoutNode | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const node of nodes) {
      const dx = node.x - world.x;
      const dy = node.y - world.y;
      const distance = dx * dx + dy * dy;
      // A finger is wider than a dot: at least 12 px around it on screen.
      const reach = Math.max(
        radiusOf(node, settings.display.nodeSize) + 2,
        12 / view.k,
      );
      if (distance <= reach * reach && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  // ---- pointer: drag a dot, pan, pinch, wheel -----------------------------

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: {
    node: LayoutNode | null;
    startX: number;
    startY: number;
    moved: boolean;
    view: View;
  } | null = null;
  let pinch: { distance: number; k: number } | null = null;
  const local = (event: PointerEvent | WheelEvent) => {
    const box = (canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  canvas?.addEventListener("pointerdown", (event) => {
    const point = local(event);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: view.k };
      if (drag?.node) {
        drag.node.fx = null;
        drag.node.fy = null;
      }
      drag = null;
      return;
    }
    const node = nodeAt(point.x, point.y);
    drag = {
      node,
      startX: point.x,
      startY: point.y,
      moved: false,
      view: { ...view },
    };
  });
  canvas?.addEventListener("pointermove", (event) => {
    const point = local(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);
    if (pinch !== null && pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = (pinch.k * (distance / pinch.distance)) / view.k;
      zoomAt(factor, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (drag === null) {
      // Hover lights a dot and its neighbours, with a mouse only.
      if (event.pointerType !== "mouse") return;
      const node = nodeAt(point.x, point.y);
      const next = node?.id ?? null;
      if (next !== hovered) {
        hovered = next;
        canvas.style.cursor = next === null ? "grab" : "pointer";
        drawSoon();
      }
      return;
    }
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.node !== null) {
      const world = toWorld(point.x, point.y);
      drag.node.fx = world.x;
      drag.node.fy = world.y;
      hovered = drag.node.id;
      alpha = Math.max(alpha, 0.3);
    } else view = { ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy };
    drawSoon();
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    const was = drag;
    drag = null;
    if (was === null) return;
    if (was.node !== null) {
      was.node.fx = null;
      was.node.fy = null;
    }
    if (!was.moved && event.type === "pointerup") {
      if (was.node !== null) open(was.node.id, false);
      else if (event.pointerType !== "mouse") {
        hovered = null;
        drawSoon();
      }
    }
  };
  canvas?.addEventListener("pointerup", release);
  canvas?.addEventListener("pointercancel", release);
  canvas?.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && drag === null && hovered !== null) {
      hovered = null;
      drawSoon();
    }
  });
  canvas?.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const point = local(event);
      zoomAt(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
    },
    { passive: false },
  );
  // Keyboard: + and − zoom, arrows pan, 0 shows the whole map.
  canvas?.addEventListener("keydown", (event) => {
    const pan = 60;
    const keys: Record<string, () => void> = {
      "+": () => zoomAt(1.25),
      "=": () => zoomAt(1.25),
      "-": () => zoomAt(0.8),
      "0": () => fitAll(),
      ArrowLeft: () => (view = { ...view, x: view.x + pan }),
      ArrowRight: () => (view = { ...view, x: view.x - pan }),
      ArrowUp: () => (view = { ...view, y: view.y + pan }),
      ArrowDown: () => (view = { ...view, y: view.y - pan }),
    };
    const action = keys[event.key];
    if (action === undefined || event.metaKey || event.ctrlKey || event.altKey)
      return;
    event.preventDefault();
    action();
    drawSoon();
  });
  function fitAll() {
    measure();
    view = fitView(nodes, size.w, size.h);
    drawSoon();
  }
  zoomIn?.addEventListener("click", () => zoomAt(1.25));
  zoomOut?.addEventListener("click", () => zoomAt(0.8));
  zoomFit?.addEventListener("click", fitAll);
  refreshButton?.addEventListener("click", () => void refresh(true));
  stateRetry?.addEventListener("click", () => void refresh(true));
  if (typeof ResizeObserver === "function" && canvas !== null)
    new ResizeObserver(() => {
      if (model?.state !== "ready") return;
      const before = size;
      measure();
      // Keep the middle of the map where it was.
      view = {
        ...view,
        x: view.x + (size.w - before.w) / 2,
        y: view.y + (size.h - before.h) / 2,
      };
      draw();
    }).observe(canvas);

  // ---- "Najít vzpomínku" --------------------------------------------------

  let found: string[] = [];
  let active = -1;
  function drawFound() {
    if (findList === null || find === null) return;
    findList.replaceChildren();
    const query = find.value.trim();
    if (query === "" || model?.state !== "ready") {
      findList.hidden = true;
      find.setAttribute("aria-expanded", "false");
      return;
    }
    found = findNodes(
      nodes.map((node) => ({
        id: node.id,
        title: titles.get(node.id) ?? node.id,
      })),
      query,
    )
      .slice(0, 8)
      .map((node) => node.id);
    if (found.length === 0) {
      const empty = document.createElement("li");
      empty.className = "memory-find-none";
      empty.textContent = input.copy().memoryFindNone;
      findList.append(empty);
    }
    found.forEach((id, index) => {
      const item = document.createElement("li");
      item.id = `memory-find-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === active));
      const title = document.createElement("span");
      title.className = "memory-find-title";
      title.textContent = titles.get(id) ?? id;
      const path = document.createElement("span");
      path.className = "memory-find-path";
      path.textContent = id;
      item.append(title, path);
      item.addEventListener("pointerdown", (event) => event.preventDefault());
      item.addEventListener("click", () => pick(id));
      findList.append(item);
    });
    findList.hidden = false;
    find.setAttribute("aria-expanded", "true");
    if (active >= 0)
      find.setAttribute("aria-activedescendant", `memory-find-${active}`);
    else find.removeAttribute("aria-activedescendant");
  }
  function pick(id: string) {
    if (find !== null) find.value = "";
    active = -1;
    drawFound();
    open(id, true);
  }
  find?.addEventListener("input", () => {
    active = -1;
    drawFound();
  });
  find?.addEventListener("blur", () => {
    if (findList !== null) findList.hidden = true;
    find.setAttribute("aria-expanded", "false");
  });
  find?.addEventListener("focus", drawFound);
  find?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (found.length === 0) return;
      active =
        event.key === "ArrowDown"
          ? (active + 1) % found.length
          : (active - 1 + found.length) % found.length;
      drawFound();
    } else if (event.key === "Enter") {
      const id = found[Math.max(active, 0)];
      if (id !== undefined) {
        event.preventDefault();
        pick(id);
      }
    } else if (event.key === "Escape" && find.value !== "") {
      event.stopPropagation();
      find.value = "";
      drawFound();
    }
  });

  // ---- the memory beside the map -------------------------------------------

  let opener: HTMLElement | null = null;
  function open(id: string, glide: boolean) {
    // An open local graph follows the memory opened from it.
    if (localCenter !== null && localCenter !== id) {
      localCenter = id;
      relayout(true);
    }
    opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    chosen = id;
    hovered = null;
    if (glide) glideTo(id);
    drawSoon();
    void readPage(id);
  }
  function close() {
    chosen = null;
    pageRequest += 1;
    // The local graph is the open memory's (as in the wireframe).
    if (localCenter !== null) setLocal(null);
    if (note !== null) {
      note.hidden = true;
      note.replaceChildren();
    }
    body?.classList.remove("has-note");
    drawSoon();
    (opener ?? canvas)?.focus({ preventScroll: true });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && chosen !== null && input.shown()) close();
  });

  async function readPage(id: string) {
    const request = ++pageRequest;
    drawNote({ id, title: titles.get(id) ?? id, page: null });
    let page: MemoryPageModel;
    try {
      const { value } = await input.get(
        `/api/memory/page?slug=${encodeURIComponent(id)}`,
      );
      page = parseMemoryPage(value);
    } catch {
      page = { state: "failed" };
    }
    if (request !== pageRequest) return;
    drawNote({ id, title: titles.get(id) ?? id, page });
  }

  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ) => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function pageButton(slug: string, label?: string) {
    if (!titles.has(slug))
      return element("span", "memory-link-missing", label ?? slug);
    const button = element(
      "button",
      "memory-link",
      label ?? titles.get(slug) ?? slug,
    );
    button.type = "button";
    button.addEventListener("click", () => open(slug, true));
    return button;
  }

  function runs(text: string, from: string): Node[] {
    return markdownRuns(text, from).map((run) => {
      switch (run.kind) {
        case "text":
          return document.createTextNode(run.text);
        case "strong":
          return element("strong", undefined, run.text);
        case "em":
          return element("em", undefined, run.text);
        case "code":
          return element("code", undefined, run.text);
        case "page":
          return pageButton(run.slug, run.text);
        default: {
          const link = element("a", undefined, run.text);
          link.href = run.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          return link;
        }
      }
    });
  }

  function linkList(title: string, slugs: readonly string[]) {
    const section = element("section", "memory-note-links");
    section.append(element("h3", undefined, title));
    const list = element("ul");
    for (const slug of slugs) {
      const item = element("li");
      item.append(pageButton(slug), element("span", "memory-note-path", slug));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  function drawNote(
    shown: Readonly<{
      id: string;
      title: string;
      page: MemoryPageModel | null;
    }>,
  ) {
    if (note === null) return;
    const copy = input.copy();
    const locale = input.locale();
    const page = shown.page;
    const head = element("header", "memory-note-head");
    const titleBox = element("div", "memory-note-title");
    const heading = element(
      "h2",
      undefined,
      page?.state === "ready" ? page.title : shown.title,
    );
    heading.id = "memory-note-heading";
    heading.tabIndex = -1;
    // The folder above the title, as the wireframe has it.
    const folder = shown.id.includes("/")
      ? shown.id.slice(0, shown.id.lastIndexOf("/"))
      : "/";
    titleBox.append(element("span", "memory-note-path", folder), heading);
    const closeButton = element("button", "ghost memory-icon");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", copy.memoryNoteClose);
    closeButton.title = copy.memoryNoteClose;
    closeButton.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#i-x"/></svg>';
    closeButton.addEventListener("click", close);
    localButton = iconButton("i-memory", copy.memoryLocal, () =>
      setLocal(localCenter === shown.id ? null : shown.id),
    );
    drawLocalButton();
    head.append(titleBox, localButton, closeButton);
    const content = element("div", "memory-note-body");
    if (page === null)
      content.append(element("p", "memory-note-hint", copy.memoryNoteLoading));
    else if (page.state !== "ready")
      content.append(
        element(
          "p",
          "memory-note-hint",
          page.state === "missing"
            ? copy.memoryNoteMissing
            : copy.memoryNoteFailed,
        ),
      );
    else {
      // Its properties in the wireframe's box: tags, kind, last change.
      const updated = memoryDate(page.updated, locale);
      const rows: [string, Node[]][] = [];
      if (page.tags.length > 0)
        rows.push([
          copy.memoryPropTags,
          page.tags.map((tag) => element("span", "memory-tag", `#${tag}`)),
        ]);
      if (page.type !== "")
        rows.push([
          copy.memoryPropType,
          [document.createTextNode(memoryTypeLabel(page.type, copy))],
        ]);
      if (updated !== null)
        rows.push([copy.memoryPropUpdated, [document.createTextNode(updated)]]);
      if (rows.length > 0) {
        const props = element("dl", "memory-props");
        for (const [label, value] of rows) {
          const row = element("div", "memory-props-row");
          const dd = element("dd");
          dd.append(...value);
          row.append(element("dt", undefined, label), dd);
          props.append(row);
        }
        content.append(props);
      }
      if (page.facts.length > 0) {
        const facts = element("section", "memory-note-facts");
        facts.append(element("h3", undefined, copy.memoryFacts));
        const list = element("ul");
        for (const fact of page.facts) {
          const item = element("li");
          item.append(element("span", "memory-fact-text", fact.text));
          const since = memoryDate(fact.since, locale);
          if (since !== null)
            item.append(element("span", "memory-fact-since", since));
          list.append(item);
        }
        facts.append(list);
        content.append(facts);
      }
      const text = element("div", "memory-note-text");
      for (const block of markdownBlocks(page.body)) {
        if (block.kind === "heading") {
          const level = Math.min(6, Math.max(3, block.level + 2));
          const node = element(`h${level}` as "h3");
          // The page's own top heading keeps the wireframe's size.
          if (block.level === 1) node.className = "memory-h1";
          node.append(...runs(block.text, page.id));
          text.append(node);
        } else if (block.kind === "list") {
          const list = element(block.ordered ? "ol" : "ul");
          for (const entry of block.items) {
            const item = element("li");
            item.append(...runs(entry, page.id));
            list.append(item);
          }
          text.append(list);
        } else if (block.kind === "code") {
          const pre = element("pre");
          pre.append(element("code", undefined, block.text));
          text.append(pre);
        } else {
          const node = element(block.kind === "quote" ? "blockquote" : "p");
          node.append(...runs(block.text, page.id));
          text.append(node);
        }
      }
      if (text.childElementCount > 0) content.append(text);
      if (page.links.length > 0)
        content.append(linkList(copy.memoryLinks, page.links));
      if (page.backlinks.length > 0)
        content.append(linkList(copy.memoryBacklinks, page.backlinks));
    }
    const wasHidden = note.hidden;
    note.replaceChildren(head, content);
    note.setAttribute("aria-labelledby", "memory-note-heading");
    note.hidden = false;
    body?.classList.add("has-note");
    if (wasHidden) {
      // The panel takes room from the map: keep the memory in view.
      requestAnimationFrame(() => {
        measure();
        glideTo(shown.id);
      });
    }
  }

  // ---- Nastavení grafu (R11c) ---------------------------------------------

  /** Settings changed: kept in this browser and drawn at once; forces and
   * what shows lay the map out again, the rest only redraw. */
  function changeSettings(
    next: MemorySettings,
    layout: "none" | "move" | "fit",
  ) {
    settings = next;
    simForces = forcesOf(settings.forces);
    saveMemorySettings(storage(), settings);
    recolor();
    if (layout === "none") drawSoon();
    else relayout(layout === "fit");
  }

  const swatchLabel = (copy: Copy, id: string): string =>
    ({
      green: copy.memorySwatchGreen,
      orange: copy.memorySwatchOrange,
      orchid: copy.memorySwatchOrchid,
      blue: copy.memorySwatchBlue,
      vermilion: copy.memorySwatchVermilion,
      yellow: copy.memorySwatchYellow,
      mint: copy.memorySwatchMint,
      ink: copy.memorySwatchInk,
    })[id] ?? id;
  const fill = (template: string, values: Readonly<Record<string, string>>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

  /** Which sections are open, as the wireframe opens them first. */
  const sections = {
    filters: true,
    groups: true,
    display: false,
    forces: false,
  };
  let picking: number | null = null;

  function iconButton(icon: string, label: string, onClick: () => void) {
    const button = element("button", "ghost memory-icon");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>`;
    button.addEventListener("click", onClick);
    return button;
  }

  function toggleRow(
    label: string,
    on: boolean,
    change: (on: boolean) => void,
  ) {
    const row = element("div", "memory-set-row");
    const button = element("button", "switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", String(on));
    button.setAttribute("aria-label", label);
    button.addEventListener("click", () => change(!on));
    row.append(element("span", undefined, label), button);
    return row;
  }

  function slider(
    label: string,
    value: number,
    range: Readonly<{ min: number; max: number; step: number }>,
    change: (value: number) => void,
  ) {
    const box = element("label", "memory-set-slider");
    const input = element("input");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value);
    input.addEventListener("input", () => change(Number(input.value)));
    box.append(element("span", undefined, label), input);
    return box;
  }

  function section(
    key: keyof typeof sections,
    title: string,
    content: () => Node[],
  ) {
    const box = element("section", "memory-set-section");
    const head = element("button", "memory-set-title");
    head.type = "button";
    head.setAttribute("aria-expanded", String(sections[key]));
    head.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-chevron-down"/></svg>`;
    head.append(document.createTextNode(title));
    head.addEventListener("click", () => {
      sections[key] = !sections[key];
      drawSettings();
    });
    box.append(head);
    if (sections[key]) {
      const body = element("div", "memory-set-content");
      body.append(...content());
      box.append(body);
    }
    return box;
  }

  function drawSettings() {
    if (gear !== null) {
      const copy = input.copy();
      gear.setAttribute("aria-expanded", String(settingsOpen));
      gear.setAttribute("aria-label", copy.memorySettings);
      gear.title = copy.memorySettings;
      gear.classList.toggle("is-on", settingsOpen);
    }
    if (settingsBox === null) return;
    settingsBox.hidden = !settingsOpen;
    if (!settingsOpen) {
      settingsBox.replaceChildren();
      return;
    }
    const copy = input.copy();
    // Keep the focus where it was across a redraw of the panel.
    const focused = document.activeElement?.getAttribute("data-set") ?? null;
    settingsBox.setAttribute("aria-label", copy.memorySettings);
    const head = element("div", "memory-set-head");
    head.append(
      iconButton("i-refresh", copy.memorySettingsReset, () => {
        picking = null;
        changeSettings(defaultMemorySettings, "fit");
        drawSettings();
      }),
      iconButton("i-x", copy.memoryNoteClose, () => {
        settingsOpen = false;
        drawSettings();
        gear?.focus();
      }),
    );
    const s = settings;
    const search = element("label", "memory-set-search");
    search.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-search"/></svg>`;
    const searchInput = element("input");
    searchInput.type = "search";
    searchInput.value = s.filters.search;
    searchInput.placeholder = copy.memorySearch;
    searchInput.title = copy.memorySearchHint;
    searchInput.setAttribute("aria-label", copy.memorySearch);
    searchInput.dataset.set = "search";
    searchInput.autocomplete = "off";
    searchInput.spellcheck = false;
    searchInput.addEventListener("input", () =>
      changeSettings(
        {
          ...settings,
          filters: { ...settings.filters, search: searchInput.value },
        },
        "move",
      ),
    );
    search.append(searchInput);
    const local = localCenter !== null;
    const filters = section("filters", copy.memoryFilters, () => [
      search,
      ...(local
        ? [
            slider(
              fill(copy.memoryDepth, { count: String(s.local.depth) }),
              s.local.depth,
              settingRanges.depth,
              (depth) => {
                changeSettings(
                  { ...settings, local: { ...settings.local, depth } },
                  "fit",
                );
                drawSettings();
              },
            ),
            toggleRow(copy.memoryIncoming, s.local.incoming, (incoming) => {
              changeSettings(
                { ...settings, local: { ...settings.local, incoming } },
                "fit",
              );
              drawSettings();
            }),
            toggleRow(copy.memoryOutgoing, s.local.outgoing, (outgoing) => {
              changeSettings(
                { ...settings, local: { ...settings.local, outgoing } },
                "fit",
              );
              drawSettings();
            }),
          ]
        : [
            toggleRow(copy.memoryOrphans, s.filters.orphans, (orphans) => {
              changeSettings(
                { ...settings, filters: { ...settings.filters, orphans } },
                "move",
              );
              drawSettings();
            }),
          ]),
    ]);
    const groups = section("groups", copy.memoryGroups, () => {
      const out: Node[] = s.groups.map((group, index) => {
        const box = element("div", "memory-set-group");
        const row = element("div", "memory-set-group-row");
        const query = element("input");
        query.value = group.query;
        query.placeholder = copy.memoryGroupPlaceholder;
        query.setAttribute(
          "aria-label",
          fill(copy.memoryGroupQuery, { count: String(index + 1) }),
        );
        query.dataset.set = `group-${index}`;
        query.autocomplete = "off";
        query.spellcheck = false;
        query.addEventListener("input", () =>
          changeSettings(
            {
              ...settings,
              groups: settings.groups.map((item, at) =>
                at === index ? { ...item, query: query.value } : item,
              ),
            },
            "none",
          ),
        );
        const swatch = swatches.find((item) => item.id === group.color);
        const color = element("button", "memory-set-swatch");
        color.type = "button";
        color.style.background = `var(${swatch?.token ?? "--lz-ink"})`;
        color.setAttribute(
          "aria-label",
          fill(copy.memoryGroupColor, {
            color: swatchLabel(copy, group.color),
          }),
        );
        color.setAttribute("aria-expanded", String(picking === index));
        color.addEventListener("click", () => {
          picking = picking === index ? null : index;
          drawSettings();
        });
        const remove = iconButton("i-x", copy.memoryGroupRemove, () => {
          picking = null;
          changeSettings(
            {
              ...settings,
              groups: settings.groups.filter((_, at) => at !== index),
            },
            "none",
          );
          drawSettings();
        });
        row.append(query, color, remove);
        box.append(row);
        if (picking === index) {
          const palette = element("div", "memory-set-palette");
          for (const item of swatches) {
            const option = element("button", "memory-set-swatch");
            option.type = "button";
            option.style.background = `var(${item.token})`;
            option.setAttribute("aria-label", swatchLabel(copy, item.id));
            option.setAttribute(
              "aria-pressed",
              String(item.id === group.color),
            );
            option.addEventListener("click", () => {
              picking = null;
              changeSettings(
                {
                  ...settings,
                  groups: settings.groups.map((entry, at) =>
                    at === index ? { ...entry, color: item.id } : entry,
                  ),
                },
                "none",
              );
              drawSettings();
            });
            palette.append(option);
          }
          box.append(palette);
        }
        return box;
      });
      const add = element("button", "memory-set-add", copy.memoryGroupAdd);
      add.type = "button";
      add.addEventListener("click", () => {
        const color =
          swatches[settings.groups.length % swatches.length]?.id ?? "blue";
        changeSettings(
          { ...settings, groups: [...settings.groups, { query: "", color }] },
          "none",
        );
        drawSettings();
        settingsBox
          ?.querySelector<HTMLInputElement>(
            `[data-set="group-${settings.groups.length - 1}"]`,
          )
          ?.focus();
      });
      out.push(add);
      return out;
    });
    const display = section("display", copy.memoryDisplay, () => {
      const animate = element(
        "button",
        "memory-set-add",
        step === null ? copy.memoryAnimate : copy.memoryAnimateStop,
      );
      animate.type = "button";
      animate.addEventListener("click", () => {
        if (step === null) startAnimation();
        else stopAnimation();
        drawSettings();
      });
      return [
        toggleRow(copy.memoryArrows, s.display.arrows, (arrows) => {
          changeSettings(
            { ...settings, display: { ...settings.display, arrows } },
            "none",
          );
          drawSettings();
        }),
        slider(
          copy.memoryTextFade,
          s.display.textFade,
          settingRanges.textFade,
          (textFade) =>
            changeSettings(
              { ...settings, display: { ...settings.display, textFade } },
              "none",
            ),
        ),
        slider(
          copy.memoryNodeSize,
          s.display.nodeSize,
          settingRanges.nodeSize,
          (nodeSize) =>
            changeSettings(
              { ...settings, display: { ...settings.display, nodeSize } },
              "none",
            ),
        ),
        slider(
          copy.memoryLinkThickness,
          s.display.linkThickness,
          settingRanges.linkThickness,
          (linkThickness) =>
            changeSettings(
              { ...settings, display: { ...settings.display, linkThickness } },
              "none",
            ),
        ),
        animate,
      ];
    });
    const forces = section("forces", copy.memoryForces, () => [
      slider(
        copy.memoryCenterForce,
        s.forces.center,
        settingRanges.center,
        (center) =>
          changeSettings(
            { ...settings, forces: { ...settings.forces, center } },
            "move",
          ),
      ),
      slider(
        copy.memoryRepelForce,
        s.forces.repel,
        settingRanges.repel,
        (repel) =>
          changeSettings(
            { ...settings, forces: { ...settings.forces, repel } },
            "move",
          ),
      ),
      slider(copy.memoryLinkForce, s.forces.link, settingRanges.link, (link) =>
        changeSettings(
          { ...settings, forces: { ...settings.forces, link } },
          "move",
        ),
      ),
      slider(
        copy.memoryLinkDistance,
        s.forces.distance,
        settingRanges.distance,
        (distance) =>
          changeSettings(
            { ...settings, forces: { ...settings.forces, distance } },
            "move",
          ),
      ),
    ]);
    settingsBox.replaceChildren(head, filters, groups, display, forces);
    if (focused !== null)
      settingsBox
        .querySelector<HTMLElement>(`[data-set="${focused}"]`)
        ?.focus();
  }
  gear?.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    drawSettings();
  });

  // ---- Animovat: the memory growing, oldest first -------------------------

  function startAnimation() {
    if (data === null) return;
    const count = data.nodes.length;
    step = 0;
    relayout(false);
    animation = setInterval(() => {
      if (step === null) return;
      step += Math.max(1, Math.round(count / 80));
      if (step >= count) {
        stopAnimation();
        drawSettings();
        return;
      }
      relayout(false);
    }, 60);
  }
  function stopAnimation() {
    if (animation !== undefined) clearInterval(animation);
    animation = undefined;
    if (step === null) return;
    step = null;
    relayout(false);
  }

  // ---- Místní graf: the open memory's links to a depth ---------------------

  function setLocal(center: string | null) {
    localCenter = center;
    relayout(true);
    if (settingsOpen) drawSettings();
    drawLocalButton();
  }
  /** The bar beside "Najít vzpomínku" while the map shows a local graph:
   * whose links, the depth 1 to 3, and back to the whole graph. */
  function drawLocal() {
    if (localBar === null) return;
    const copy = input.copy();
    localBar.hidden = localCenter === null;
    localBar.replaceChildren();
    if (localCenter === null) return;
    const label = element(
      "span",
      "memory-local-label",
      `${copy.memoryLocalOf}: `,
    );
    label.append(
      element("strong", undefined, titles.get(localCenter) ?? localCenter),
    );
    const depths = element("div", "memory-local-depth");
    depths.setAttribute("role", "group");
    depths.setAttribute(
      "aria-label",
      fill(copy.memoryDepth, { count: "" }).replace(/[:\s]+$/, ""),
    );
    for (const depth of [1, 2, 3]) {
      const button = element("button", undefined, String(depth));
      button.type = "button";
      button.setAttribute(
        "aria-pressed",
        String(settings.local.depth === depth),
      );
      button.title = fill(copy.memoryDepth, { count: String(depth) });
      button.addEventListener("click", () => {
        changeSettings(
          { ...settings, local: { ...settings.local, depth } },
          "fit",
        );
        if (settingsOpen) drawSettings();
      });
      depths.append(button);
    }
    localBar.append(
      label,
      depths,
      iconButton("i-x", copy.memoryWholeGraph, () => setLocal(null)),
    );
  }
  let localButton: HTMLButtonElement | null = null;
  function drawLocalButton() {
    if (localButton === null) return;
    const on = localCenter !== null && localCenter === chosen;
    localButton.setAttribute("aria-pressed", String(on));
    localButton.classList.toggle("is-on", on);
  }

  return Object.freeze({
    get loaded() {
      return loaded;
    },
    refresh,
    /** The page shows again (a route or a language change). */
    render() {
      if (input.shown() && model !== null) render();
    },
  });
}
