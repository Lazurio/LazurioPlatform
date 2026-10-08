import { vendorText } from "./vendor-text" with { type: "macro" };

const symbol = vendorText("symbol-color.svg");

// The offline guide page (DEV-6651, design: the shell wireframe's
// "Environment mimo dosah", approved by the Admin on 2026-10-08). The
// Environment's service worker keeps it from the last visit and shows it at
// the address that failed, so it must stand alone: styles, logo and sketch
// are inside, nothing is loaded from the network. Its text names the
// Environment, its Organization and the tailnet exactly as the Tailscale client
// lists it, and it continues to the address by itself once the address answers.
// Everything beyond the three steps lives in the documentation.

export type OfflineGuideInput = {
  locale: "cs" | "en";
  /** The Environment's display name. */
  environment: string;
  /** The Organization the Environment serves; none for a personal Environment. */
  organization: string | null;
  /** The tailnet as the Tailscale client lists it: its control server's host. */
  tailnet: string;
  /** The documentation's guide to connecting through Tailscale. */
  docs: string;
};

type Platform = "macos" | "windows" | "ios" | "android";

type Copy = {
  title: string;
  lead: (environment: string, organization: string | null) => string;
  choose: string;
  continues: string;
  continuesTo: string;
  retry: string;
  retried: string;
  connected: string;
  stillFailing: string;
  docs: string;
  account: string;
  otherTailnet: string;
  steps: Record<Platform, readonly [string, string, string]>;
};

const copy: Record<"cs" | "en", Copy> = {
  cs: {
    title: "Zapni Tailscale",
    lead: (environment, organization) =>
      organization
        ? `<strong>${environment}</strong> v Organizaci <strong>${organization}</strong> je dostupný jen přes Tailscale.`
        : `Tvůj <strong>${environment}</strong> Environment je dostupný jen přes Tailscale.`,
    choose: "Zapni ho a vyber tailnet",
    continues: "Jakmile se připojíš, stránka sama pokračuje.",
    continuesTo: "Pokračuje na",
    retry: "Zkusit znovu",
    retried: "Environment je pořád mimo dosah.",
    connected: "Připojeno, pokračuju…",
    stillFailing: "Pořád to nejde?",
    docs: "Podrobný návod v dokumentaci",
    account: "Tvůj účet",
    otherTailnet: "jiný tailnet",
    steps: {
      macos: [
        "Klikni na ikonu Tailscale v horní liště.",
        "Zapni přepínač Tailscale.",
        "Najeď na svůj účet a v seznamu vyber {tailnet}.",
      ],
      windows: [
        "Klikni pravým tlačítkem na ikonu Tailscale vpravo dole na hlavním panelu. Když ji nevidíš, schovává se pod šipkou ^.",
        "Najeď na svůj účet a v seznamu vyber {tailnet}.",
        "Když Tailscale není připojený, zvol Connect.",
      ],
      ios: [
        "Otevři aplikaci Tailscale.",
        "Klepni na ikonu účtu vpravo nahoře, pak na svůj účet a v seznamu vyber {tailnet}.",
        "Zapni přepínač Tailscale.",
      ],
      android: [
        "Otevři aplikaci Tailscale.",
        "Klepni na ikonu účtu vpravo nahoře, pak na svůj účet a v seznamu vyber {tailnet}.",
        "Zapni přepínač Tailscale.",
      ],
    },
  },
  en: {
    title: "Turn on Tailscale",
    lead: (environment, organization) =>
      organization
        ? `<strong>${environment}</strong> of <strong>${organization}</strong> is reachable only through Tailscale.`
        : `Your <strong>${environment}</strong> Environment is reachable only through Tailscale.`,
    choose: "Turn it on and choose the tailnet",
    continues: "Once you are connected, this page continues by itself.",
    continuesTo: "Continues to",
    retry: "Try again",
    retried: "The Environment is still out of reach.",
    connected: "Connected, continuing…",
    stillFailing: "Still not working?",
    docs: "The detailed guide in the documentation",
    account: "Your account",
    otherTailnet: "another tailnet",
    steps: {
      macos: [
        "Click the Tailscale icon in the menu bar.",
        "Turn on the Tailscale switch.",
        "Point at your account and choose {tailnet} in the list.",
      ],
      windows: [
        "Right-click the Tailscale icon at the bottom right of the taskbar. If you do not see it, it hides under the ^ arrow.",
        "Point at your account and choose {tailnet} in the list.",
        "If Tailscale is not connected, choose Connect.",
      ],
      ios: [
        "Open the Tailscale app.",
        "Tap the account icon at the top right, then your account, and choose {tailnet} in the list.",
        "Turn on the Tailscale switch.",
      ],
      android: [
        "Open the Tailscale app.",
        "Tap the account icon at the top right, then your account, and choose {tailnet} in the list.",
        "Turn on the Tailscale switch.",
      ],
    },
  },
};

const PLATFORMS: readonly (readonly [Platform, string])[] = [
  ["macos", "macOS"],
  ["windows", "Windows"],
  ["ios", "iPhone"],
  ["android", "Android"],
];

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const glyph = `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${Array.from(
  { length: 9 },
  (_, index) =>
    `<circle cx="${4 + (index % 3) * 8}" cy="${4 + Math.floor(index / 3) * 8}" r="2.6" fill="currentColor" opacity="${[3, 4, 5, 7].includes(index) ? 1 : 0.3}"/>`,
).join("")}</svg>`;

const marker = (n: number) => `<span class="mark">${n}</span>`;

/** The account rows: the needed tailnet highlighted, two others as in a real list. */
function accounts(c: Copy, tailnet: string, step: number): string {
  const row = (host: string, target: boolean, checked: boolean) =>
    `<div class="acct${target ? " is-target" : ""}"><span class="check">${checked ? "✓" : ""}</span><span class="avatar">•</span><span class="acct-text"><b>${c.account}</b><span class="host">${host}</span></span>${target ? marker(step) : ""}</div>`;
  return `<div class="accts">${row(c.otherTailnet, false, true)}${row(tailnet, true, false)}${row(c.otherTailnet, false, false)}</div>`;
}

function sketch(platform: Platform, c: Copy, tailnet: string): string {
  const switchRow = (step: number) =>
    `<div class="row switch"><span class="switch-text"><b>Tailscale</b><span class="host">Connected</span></span><span class="toggle"></span>${marker(step)}</div>`;
  if (platform === "ios" || platform === "android") {
    return `<div class="sk phone"><div class="apphead">${glyph} Tailscale ${marker(1)}</div>${switchRow(3)}${accounts(c, tailnet, 2)}</div>`;
  }
  const windows = platform === "windows";
  const icon = `<span class="icon">${glyph}${marker(1)}</span>`;
  const menus = `<div class="menus"><div class="panel sub${windows ? " top" : ""}">${accounts(c, tailnet, windows ? 2 : 3)}</div><div class="panel main">${windows ? "" : switchRow(2)}<div class="acct is-open"><span class="avatar">•</span><span class="acct-text"><b>${c.account}</b><span class="host">${c.otherTailnet}</span></span><span class="chev">›</span></div><div class="sep"></div><div class="row faint">${windows ? "Network devices ›" : "Network Devices ›"}</div><div class="row faint">${windows ? "Exit nodes ›" : "Exit Nodes ›"}</div><div class="sep"></div>${windows ? `<div class="row">Connect ${marker(3)}</div>` : ""}<div class="row faint">${windows ? "Exit" : "Quit"}</div></div></div>`;
  return windows
    ? `<div class="sk win">${menus}<div class="taskbar"><span>^</span>${icon}</div></div>`
    : `<div class="sk mac"><div class="bar"><span class="blob"></span>${icon}<span class="blob wide"></span></div>${menus}</div>`;
}

function steps(platform: Platform, c: Copy, tailnet: string): string {
  return `<ol class="steps">${c.steps[platform]
    .map(
      (step, index) =>
        `<li>${marker(index + 1)}<span>${step.replace("{tailnet}", `<code>${tailnet}</code>`)}</span></li>`,
    )
    .join("")}</ol>`;
}

const style = `
:root{color-scheme:light;--ink:#090909;--muted:#707070;--faint:#999;--line:#dddcdb;--line-faint:#ecebea;--paper:#fbfaf9;--blue:#0d12db;--blue-50:#ebf1fe;--blue-100:#d2ddfd;--blue-300:#7083f7;--green:#28c06f}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:680px;margin:48px auto;padding:0 20px}
header{text-align:center;margin-bottom:24px}
header svg{width:36px;height:36px}
.card{display:flex;flex-direction:column;gap:16px;padding:32px;border:1px solid var(--line-faint);border-radius:10px;background:#fff}
h1{margin:0;font-size:26px}
.lead{margin:0;color:var(--muted)}
.lead strong{color:var(--ink);font-weight:600}
code{padding:1px 5px;border-radius:3px;background:var(--blue-50);color:#0b0e91;font:0.88em ui-monospace,Menlo,Consolas,monospace;overflow-wrap:break-word}
.status{display:none;align-self:flex-start;padding:3px 10px;border:1px solid #88daae;border-radius:999px;background:#f4f8f6;color:#1b7a46;font-size:12px;font-weight:600}
.is-connected .status{display:inline-block}
.tabs{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;border:1px solid var(--line);border-radius:6px;background:var(--paper)}
.tabs button{padding:3px 10px;border:0;border-radius:3px;background:none;color:var(--muted);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.tabs button[aria-selected=true]{background:#fff;color:var(--ink);box-shadow:0 0 0 1px var(--line)}
.guide[hidden]{display:none}
.guide{display:flex;flex-direction:column;gap:16px}
.steps{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none;font-size:14px}
.steps li{display:flex;gap:10px;align-items:flex-start}
.mark{display:inline-flex;flex-shrink:0;width:18px;height:18px;align-items:center;justify-content:center;border-radius:50%;background:var(--blue);color:#fff;font-size:11px;font-weight:700;line-height:1}
.sk{position:relative;display:flex;flex-direction:column;padding:0 0 14px;border:1px solid var(--line);border-radius:10px;background:#f5f4f3;font-size:11px}
.sk .mark{position:absolute;top:50%;right:-9px;transform:translateY(-50%);box-shadow:0 0 0 2px #fff}
.bar{display:flex;justify-content:flex-end;align-items:center;gap:12px;height:26px;padding:0 12px;border-bottom:1px solid var(--line);border-radius:10px 10px 0 0;background:#fff}
.blob{width:14px;height:9px;border-radius:2px;background:#c3c2c1}.blob.wide{width:34px}
.icon{position:relative;display:inline-flex;padding:2px 6px;border-radius:6px;background:var(--blue-100);box-shadow:0 0 0 1px var(--blue-300)}
.icon .mark{top:-10px;right:-12px;transform:none}
.glyph{width:13px;height:13px}
.menus{display:flex;min-width:480px;justify-content:flex-end;align-items:flex-start;padding:6px 14px 0}
.panel{position:relative;display:flex;flex-direction:column;width:230px;padding:5px;border:1px solid var(--line);border-radius:6px;background:#fff;box-shadow:0 8px 24px rgba(9,9,9,.1)}
.panel.sub{z-index:1;margin:44px -4px 0 0}.panel.sub.top{margin-top:0}
.row{position:relative;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 6px}
.row.faint{color:var(--faint)}
.switch-text{display:flex;flex-direction:column}
.toggle{position:relative;width:26px;height:15px;margin-right:12px;border-radius:999px;background:var(--blue)}
.toggle::after{content:"";position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;background:#fff}
.sep{height:1px;margin:4px 2px;background:var(--line-faint)}
.accts{display:flex;flex-direction:column;gap:2px}
.acct{position:relative;display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:3px}
.acct.is-open{background:var(--blue-100)}
.acct.is-target{background:var(--blue);color:#fff}
.check{width:11px}
.avatar{display:inline-flex;width:18px;height:18px;flex-shrink:0;align-items:center;justify-content:center;border-radius:50%;background:#0b0eb4;color:#fff;font-size:10px}
.acct-text{display:flex;flex:1;min-width:0;flex-direction:column}
.host{color:var(--muted);font:9.5px ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.is-target .host{color:var(--blue-50)}
.chev{color:var(--muted)}
.win{padding-top:12px}.win .menus{padding-bottom:8px}
.taskbar{display:flex;min-width:480px;justify-content:flex-end;align-items:center;gap:10px;height:26px;padding:0 12px;border-radius:0 0 10px 10px;background:#262626;color:#dddcdb}
.win .icon{background:#515151;color:#fff}
.phone{width:240px;max-width:100%;align-self:center;padding:10px 10px 14px;border:6px solid #262626;border-radius:24px;background:#fff}
.apphead{position:relative;display:flex;align-items:center;gap:6px;padding:4px 6px 8px;font-size:13px;font-weight:700}
.phone .switch{margin-bottom:6px;border-bottom:1px solid var(--line-faint)}
.continue{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 16px;padding:12px 14px;border:1px solid var(--line-faint);border-radius:6px;background:var(--paper)}
.continue>div{min-width:0;flex:1 1 240px}
.label{color:var(--faint);font-size:11px}
.address{font:12px ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.continue button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.retried{margin:-6px 0 0;color:var(--muted);font-size:12px}
.help{margin:0;padding-top:12px;border-top:1px solid var(--line-faint);color:var(--muted);font-size:13px}
.help a{color:var(--blue);font-weight:600}
@media (max-width:640px){.sk{overflow-x:auto}}
`;

/**
 * Continues once the address answers: a same-origin request the worker does
 * not take (only navigations reach it), on return to the window, when the
 * browser reports a connection and every few seconds.
 */
const script = `
(function(){
  var ua=navigator.userAgent, p=/iPhone|iPad|iPod/.test(ua)?"ios":/Android/.test(ua)?"android":/Windows/.test(ua)?"windows":"macos";
  function show(id){document.querySelectorAll("[data-platform]").forEach(function(b){b.setAttribute("aria-selected",String(b.dataset.platform===id))});document.querySelectorAll(".guide").forEach(function(g){g.hidden=g.dataset.guide!==id})}
  document.querySelectorAll("[data-platform]").forEach(function(b){b.addEventListener("click",function(){show(b.dataset.platform)})});
  show(p);
  document.getElementById("address").textContent=location.host+location.pathname+location.search;
  var busy=false;
  function attempt(manual){if(busy)return;busy=true;fetch(location.href,{cache:"no-store",credentials:"same-origin",redirect:"manual"}).then(function(){document.body.classList.add("is-connected");setTimeout(function(){location.reload()},600)},function(){if(manual)document.getElementById("retried").hidden=false}).finally(function(){busy=false})}
  document.getElementById("retry").addEventListener("click",function(){attempt(true)});
  addEventListener("focus",function(){attempt(false)});addEventListener("online",function(){attempt(false)});
  document.addEventListener("visibilitychange",function(){if(!document.hidden)attempt(false)});
  setInterval(function(){attempt(false)},4000);
})();
`;

export function renderOfflineGuide(input: OfflineGuideInput): string {
  const c = copy[input.locale];
  const environment = escapeHtml(input.environment);
  const organization =
    input.organization === null ? null : escapeHtml(input.organization);
  const tailnet = escapeHtml(input.tailnet);
  const tabs = PLATFORMS.map(
    ([id, label]) =>
      `<button type="button" role="tab" data-platform="${id}" aria-selected="false">${label}</button>`,
  ).join("");
  const guides = PLATFORMS.map(
    ([id]) =>
      `<div class="guide" data-guide="${id}" hidden>${sketch(id, c, tailnet)}${steps(id, c, tailnet)}</div>`,
  ).join("");
  return `<!doctype html>
<html lang="${input.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${c.title}</title><style>${style}</style></head>
<body><main><header>${symbol}</header>
<section class="card"><div class="status" role="status">${c.connected}</div>
<h1>${c.title}</h1>
<p class="lead">${c.lead(environment, organization)} ${c.choose} <code>${tailnet}</code>. ${c.continues}</p>
<div class="tabs" role="tablist">${tabs}</div>
${guides}
<div class="continue"><div><div class="label">${c.continuesTo}</div><div class="address" id="address"></div></div><button type="button" id="retry">${c.retry}</button></div>
<p class="retried" id="retried" hidden>${c.retried}</p>
<p class="help">${c.stillFailing} <a href="${escapeHtml(input.docs)}" target="_blank" rel="noreferrer">${c.docs}</a></p>
</section></main><script>${script}</script></body></html>
`;
}
