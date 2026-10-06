/** The page of the people's view (decision F39 point 1), one document for
 * `/` and for `/t/<id>`: a thin bar (back, forward, reload and the address),
 * a row for a page's new tab, and the page area. The script
 * (`/assets/view.js`, `client.ts`) does the rest: it opens a remote tab for
 * `/`, fills in the words in the person's language and draws the remote tab.
 * No inline script and nothing from another origin: the service's policy is
 * `script-src 'self'` and allows only its own styles and images. */

// Icons drawn for this page, in the current colour, hidden from assistive
// technology (each button names itself).
const icon = (paths: string, className = "") =>
  `<svg${className === "" ? "" : ` class="${className}"`} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const cross = '<path d="M7 7l10 10M17 7L7 17"/>';

// The page's icon until the remote page has one of its own (a globe).
const defaultIcon =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2380808a' stroke-width='1.6'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9s1.2-6.5 3.6-9z'/%3E%3C/svg%3E";

const styles = `
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
:root {
  color-scheme: light dark;
  --chrome: #f3f3f4; --line: #dcdcdf; --text: #1d1d1f; --muted: #6e6e73;
  --field: #ffffff; --hover: rgba(0, 0, 0, 0.07); --accent: #2563eb;
  --on-accent: #ffffff; --page: #e9e9eb; --panel: #ffffff; --notice: #eef2fb;
  --veil: rgba(233, 233, 235, 0.92); --error: #c5221f;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --chrome: #2a2a2d; --line: #3d3d42; --text: #ececef; --muted: #a1a1a8;
    --field: #1c1c1e; --hover: rgba(255, 255, 255, 0.09); --accent: #7aa2ff;
    --on-accent: #111114; --page: #18181a; --panel: #2f2f33; --notice: #26304a;
    --veil: rgba(24, 24, 26, 0.9); --error: #f28b82;
    --shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
}
html, body { height: 100%; margin: 0; }
body {
  overflow: hidden; overscroll-behavior: none; background: var(--page);
  color: var(--text); -webkit-text-size-adjust: 100%;
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.view { position: fixed; inset: 0; display: flex; flex-direction: column; }
.bar {
  flex: none; display: flex; align-items: center; gap: 2px; height: 40px;
  padding: 0 6px; background: var(--chrome); border-bottom: 1px solid var(--line);
}
.tool {
  flex: none; display: inline-grid; place-items: center; width: 30px; height: 30px;
  padding: 0; border: 0; border-radius: 50%; background: transparent;
  color: var(--text); cursor: pointer;
}
.tool:hover:not(:disabled) { background: var(--hover); }
.tool:disabled { opacity: 0.35; cursor: default; }
.tool:focus-visible, .button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
#reload[data-state="reload"] .stop-icon, #reload[data-state="stop"] .reload-icon { display: none; }
.address {
  flex: 1; min-width: 0; height: 30px; margin-left: 4px; padding: 0 12px;
  border: 1px solid var(--line); border-radius: 15px; background: var(--field);
  color: var(--text); font: inherit; font-size: 14px; outline: none;
}
.address:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.address::placeholder { color: var(--muted); }
.address:disabled { opacity: 0.6; }
.notice {
  flex: none; display: flex; align-items: center; gap: 8px; min-height: 36px;
  padding: 3px 4px 3px 12px; background: var(--notice); border-bottom: 1px solid var(--line);
}
.notice-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.area {
  position: relative; flex: 1; min-height: 0; overflow: hidden; background: var(--page);
  touch-action: none; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
}
.page { position: absolute; inset: 0; overflow: hidden; }
.screen { position: absolute; inset: 0; display: block; width: 100%; height: 100%; touch-action: none; }
.keys {
  position: absolute; left: 0; top: 0; width: 1px; height: 1px; margin: 0; padding: 0;
  border: 0; opacity: 0; resize: none; overflow: hidden; white-space: pre;
  color: transparent; background: transparent; caret-color: transparent;
  font-size: 16px; pointer-events: none;
}
.status, .banner {
  position: absolute; left: 50%; max-width: calc(100% - 24px); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; border-radius: 999px;
  background: var(--panel); box-shadow: var(--shadow); pointer-events: none;
}
.status { top: 50%; transform: translate(-50%, -50%); padding: 7px 14px; color: var(--muted); }
.banner { z-index: 4; top: 10px; transform: translateX(-50%); padding: 6px 12px; font-size: 12px; }
.popups { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; pointer-events: none; }
.popup {
  grid-area: 1 / 1; display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
  box-shadow: var(--shadow); pointer-events: auto;
}
.popup-head {
  flex: none; display: flex; align-items: center; gap: 6px; height: 34px;
  padding: 0 2px 0 12px; background: var(--chrome); border-bottom: 1px solid var(--line);
}
.popup-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.popup-body { position: relative; flex: none; width: 480px; height: 600px; background: var(--page); }
.end {
  position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 14px; padding: 24px;
  text-align: center; background: var(--veil);
}
.end p { margin: 0; font-size: 15px; }
.button {
  height: 30px; padding: 0 14px; border: 1px solid var(--line); border-radius: 8px;
  background: var(--field); color: var(--text); font: inherit; cursor: pointer; white-space: nowrap;
}
.button.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.button:disabled { opacity: 0.55; cursor: default; }
.modal {
  width: min(420px, calc(100vw - 32px)); padding: 18px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--panel); color: var(--text); box-shadow: var(--shadow);
}
.modal::backdrop { background: rgba(0, 0, 0, 0.32); }
.modal h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.modal .message { margin: 0 0 14px; max-height: 50vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.modal .field {
  display: block; width: 100%; height: 32px; margin: 0 0 14px; padding: 0 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--field);
  color: var(--text); font: inherit; font-size: 16px;
}
.modal input[type="file"] { display: block; width: 100%; margin: 0 0 14px; }
.modal .error { margin: 0 0 12px; color: var(--error); }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
`;

const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title></title>
<link id="icon" rel="icon" href="${defaultIcon}">
<style>${styles}</style>
</head>
<body>
<div class="view">
<header class="bar">
<button id="back" class="tool" type="button" disabled>${icon('<path d="M15 5l-7 7 7 7"/>')}</button>
<button id="forward" class="tool" type="button" disabled>${icon('<path d="M9 5l7 7-7 7"/>')}</button>
<button id="reload" class="tool" type="button" data-state="reload">${icon('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>', "reload-icon")}${icon(cross, "stop-icon")}</button>
<input id="address" class="address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
</header>
<div id="notice" class="notice" role="status" hidden>
<span id="notice-text" class="notice-text"></span>
<button id="notice-open" class="button" type="button"></button>
<button id="notice-close" class="tool" type="button">${icon(cross)}</button>
</div>
<main id="area" class="area">
<div id="banner" class="banner" role="status" hidden></div>
</main>
</div>
<script type="module" src="/assets/view.js"></script>
</body>
</html>
`;

/** The complete document of the view page. */
export function viewPage(): string {
  return page;
}
