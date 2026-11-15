// The desktop page: noVNC over the service's gated WebSocket. What this page
// does with input is only for show; the service drops a viewer's keys and
// pointer unless that viewer holds the screen.
import RFB from "/novnc/core/rfb.js";

const params = new URLSearchParams(location.search);
const tab = params.get("tab");
const back = params.get("back");
const wantsControl = params.get("take") === "1";
const viewer = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

const $ = (id) => document.getElementById(id);
const narrow = matchMedia("(max-width: 700px)");
// Opened from a tab, the page starts at 1:1 on that tab's window, so the
// person sees their own window first and the other threads' windows only
// when they ask for the whole screen.
let fit = !narrow.matches && !tab;
let holding = false;
let focusRect = null;
let lastState = null;

const ws = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rfb?viewer=${viewer}`;
const rfb = new RFB($("screen"), ws, { wsProtocols: ["binary"], shared: true });
rfb.viewOnly = true;
rfb.focusOnClick = true;
rfb.background = "transparent";

function post(path, body = {}) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewer, ...body }),
  }).then((r) => r.json());
}

function applyView() {
  $("fit").setAttribute("aria-pressed", String(fit));
  $("fit").textContent = fit ? "Celá plocha" : "1:1";
  if (narrow.matches && !fit) {
    // A phone shows the screen at 1:1 around the window, panned by dragging.
    rfb.scaleViewport = false;
    rfb.clipViewport = true;
    rfb.dragViewport = !holding;
  } else {
    rfb.clipViewport = false;
    rfb.dragViewport = false;
    rfb.scaleViewport = fit;
  }
  requestAnimationFrame(showFocus);
}

function screenScale() {
  const canvas = $("screen").querySelector("canvas");
  if (!canvas) return null;
  const box = canvas.getBoundingClientRect();
  return { box, scale: box.width / (canvas.width || 1) };
}

/** Brings the tab's window into sight and marks it for a moment. */
function showFocus() {
  if (!focusRect) return;
  const screen = $("screen").firstElementChild;
  if (!fit && screen && !rfb.clipViewport) {
    screen.scrollTo({ left: focusRect.x - 24, top: focusRect.y - 24 });
  }
  if (rfb.clipViewport && rfb._display?.viewportChangePos) {
    // noVNC 1.7.0 has no public call to place the clipped viewport.
    const loc = rfb._display._viewportLoc ?? { x: 0, y: 0 };
    rfb._display.viewportChangePos(focusRect.x - 12 - loc.x, focusRect.y - 12 - loc.y);
  }
  requestAnimationFrame(() => {
    const measured = screenScale();
    if (!measured) return;
    const main = document.querySelector("main").getBoundingClientRect();
    const loc = rfb.clipViewport ? (rfb._display?._viewportLoc ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const mark = $("mark");
    mark.style.left = `${measured.box.left - main.left + (focusRect.x - loc.x) * measured.scale}px`;
    mark.style.top = `${measured.box.top - main.top + (focusRect.y - loc.y) * measured.scale}px`;
    mark.style.width = `${focusRect.width * measured.scale}px`;
    mark.style.height = `${focusRect.height * measured.scale}px`;
    mark.style.opacity = "1";
    clearTimeout(showFocus.timer);
    showFocus.timer = setTimeout(() => {
      mark.style.opacity = "0";
    }, 2500);
  });
}

async function focusTab() {
  if (!tab) return;
  const result = await post("/api/focus", { tab });
  if (result.window === null) {
    $("status").textContent = "Okno této záložky se na ploše nepodařilo najít.";
    return;
  }
  focusRect = result.rect;
  $("others").hidden = false;
  showFocus();
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 2 ? "právě teď" : `před ${s} s`;
}

function render(state) {
  lastState = state;
  holding = state.you;
  rfb.viewOnly = !holding;
  const chip = $("turn");
  const agent = state.agents[0];
  if (state.you) {
    chip.dataset.state = "you";
    chip.textContent = "Ovládáte plochu. Agenti zatím čekají.";
  } else if (state.person) {
    chip.dataset.state = "other";
    chip.textContent = "Plochu ovládá jiný člověk.";
  } else if (agent) {
    chip.dataset.state = "agent";
    chip.textContent = `Plochu ovládá agent ${agent.agent} (${ago(agent.at)}).`;
  } else {
    chip.dataset.state = "watch";
    chip.textContent = "Sledujete plochu.";
  }
  $("take").hidden = state.you;
  $("take").textContent = agent || state.person ? "Převzít ovládání" : "Ovládat plochu";
  $("release").hidden = !state.you;
  if (narrow.matches && !fit) rfb.dragViewport = !holding;
}

async function poll() {
  try {
    render(await fetch(`/api/state?viewer=${viewer}`).then((r) => r.json()));
    const { escapes } = await fetch("/api/escapes").then((r) => r.json());
    const box = $("escapes");
    box.replaceChildren();
    const mine = tab ? escapes.filter((e) => e.tab === tab) : escapes;
    box.hidden = mine.length === 0;
    if (mine.length > 0) {
      const text = document.createElement("span");
      text.textContent =
        mine.length === 1
          ? `Mimo stránku je otevřené okno „${mine[0].name || "bez názvu"}“.`
          : `Mimo stránku jsou otevřená okna: ${mine.map((e) => `„${e.name || "bez názvu"}“`).join(", ")}.`;
      const show = document.createElement("button");
      show.type = "button";
      show.textContent = "Ukázat";
      show.addEventListener("click", () => {
        const e = mine.at(-1);
        focusRect = { x: e.x, y: e.y, width: e.width, height: e.height };
        if (tab) void focusTab();
        else showFocus();
      });
      box.append(text, show);
      const last = mine.at(-1);
      if (holding && last.kind === "dialog") {
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "Zavřít okno";
        close.addEventListener("click", async () => {
          await post("/api/dismiss", { window: last.id });
          await poll();
        });
        box.append(close);
      }
    }
  } catch {
    $("turn").textContent = "Spojení se službou plochy se přerušilo.";
  }
}

$("take").addEventListener("click", async () => {
  await post("/api/take");
  await poll();
  $("screen").querySelector("canvas")?.focus();
});
$("release").addEventListener("click", async () => {
  await post("/api/release");
  await poll();
});
$("fit").addEventListener("click", () => {
  fit = !fit;
  applyView();
});
if (back) {
  $("back").hidden = false;
  $("back").addEventListener("click", async () => {
    await post("/api/release");
    location.href = back;
  });
}

rfb.addEventListener("connect", async () => {
  $("status").textContent = "";
  applyView();
  await poll();
  // Opened from a tab whose window a native window covers: the person came
  // to act on it, so they take the screen, unless an agent is on it now.
  if (wantsControl && lastState && !lastState.person && lastState.agents.length === 0) {
    await post("/api/take");
    await poll();
  }
  await focusTab();
});
rfb.addEventListener("disconnect", (event) => {
  $("status").textContent = event.detail.clean
    ? "Plocha se odpojila."
    : "Spojení s plochou se přerušilo. Obnovte stránku.";
});

setInterval(poll, 2000);
// While the person holds the screen and the page is visible, the lease is
// renewed; a hidden or closed page lets it run out after two minutes.
setInterval(() => {
  if (holding && document.visibilityState === "visible") void post("/api/renew");
}, 30_000);
narrow.addEventListener("change", applyView);
