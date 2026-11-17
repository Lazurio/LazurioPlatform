import {
  findNodes,
  fitView,
  type LayoutLink,
  type LayoutNode,
  layoutForces,
  layoutOf,
  radiusOf,
  tick,
} from "./memory-layout";
import {
  type MemoryMapModel,
  type MemoryPageModel,
  markdownBlocks,
  markdownRuns,
  memoryCount,
  memoryDate,
  memoryGroup,
  memoryRetries,
  memoryStateLine,
  memoryTruncatedLine,
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
  const reduced = () =>
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

  let loaded = false;
  let reading = false;
  let model: MemoryMapModel | null = null;
  let nodes: LayoutNode[] = [];
  let links: LayoutLink[] = [];
  let titles = new Map<string, string>();
  let groups = new Map<string, ReturnType<typeof memoryGroup>>();
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
    const previous = new Map(nodes.map((node) => [node.id, node]));
    const laid = layoutOf(
      map.nodes.map((node) => node.id),
      map.links,
      previous,
    );
    nodes = laid.nodes;
    links = laid.links;
    titles = new Map(map.nodes.map((node) => [node.id, node.title]));
    groups = new Map(
      map.nodes.map((node) => [node.id, memoryGroup(node.id, node.type)]),
    );
    neighbours = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    for (const link of links) {
      neighbours.get(link.source.id)?.add(link.target.id);
      neighbours.get(link.target.id)?.add(link.source.id);
    }
    if (chosen !== null && !titles.has(chosen)) chosen = null;
    if (previous.size === 0 || !fitted) {
      // Settle quietly, then frame the whole map, as the wireframe does on
      // open; with reduced motion it settles fully and stands still.
      alpha = 1;
      const steps = reduced() ? 300 : 120;
      for (let index = 0; index < steps; index += 1)
        alpha = tick(nodes, links, alpha);
      measure();
      view = fitView(nodes, size.w, size.h);
      fitted = size.w > 0;
      alpha = reduced() ? 0 : 0.12;
    } else alpha = Math.max(alpha, 0.3);
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
    const swatch = {
      person: token(style, "--lz-green-600", "#1f8a4c"),
      company: token(style, "--lz-expressive-orange-figure", "#d9730d"),
      idea: token(style, "--lz-expressive-orchid-figure", "#c065b8"),
    };
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
    context.lineWidth = 1 / Math.max(view.k, 0.35);
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
    }
    // Dots.
    for (const node of nodes) {
      const r = radiusOf(node);
      context.globalAlpha = fade(node.id);
      const group = groups.get(node.id) ?? null;
      context.fillStyle =
        node.id === hovered ? accent : group === null ? dot : swatch[group];
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
    const zoomAlpha = Math.min(1, Math.max(0, (view.k - 0.51) / 0.43));
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
      const y = node.y + radiusOf(node) + 4;
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
        alpha = tick(nodes, links, alpha);
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
      const reach = Math.max(radiusOf(node) + 2, 12 / view.k);
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
    head.append(titleBox, closeButton);
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
        rows.push([copy.memoryPropType, [document.createTextNode(page.type)]]);
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
