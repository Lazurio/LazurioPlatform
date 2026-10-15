import { vendorText } from "./vendor-text" with { type: "macro" };

const symbol = vendorText("symbol-color.svg");

// The offline guide page (DEV-6651). The Environment's service worker keeps it
// from the last visit and shows it at the address that failed, so it must
// stand alone: styles, logo and sketch are inside, nothing is loaded from the
// network. It continues to the address by itself once the address answers.
//
// Simplified on 2026-10-11 (Anna): one command, one small line for when it
// fails, and above them a moving sketch of the person's own system in which
// the cursor from lazurio.ai's hero clicks the Tailscale icon, turns it on and
// chooses the tailnet. The system is detected, so there is no switch between
// systems, no numbered steps and no retry button: the page retries by itself.
// The tailnet is named exactly as the Tailscale client lists it, because
// every account in the list carries the same name. The Environment and its
// Organization stay in the tab's title.
//
// A way back does not need the tailnet (Admin, 2026-10-09: an Organization
// clicked by mistake must not strand you here): the rail's Lazurio logo and a
// link lead to the Dashboard, on the public internet, where you choose another
// Environment. No status line once connected (Admin, 2026-10-09): the page
// reloads at once into the Environment.

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
  /** The Dashboard, where the person chooses another Environment: the
   * rail's logo and the way back lead there. An https address; null draws
   * the logo without a link and no way back. */
  dashboard: string | null;
};

type Copy = {
  title: string;
  place: (environment: string, organization: string | null) => string;
  /** The command on a computer, where Tailscale lives by the clock. */
  desktop: string;
  /** The command on a phone, where Tailscale is an app. */
  phone: string;
  /** Before the fallback, on Windows only: the icon is right-clicked and may hide. */
  windows: string;
  failed: string;
  docs: string;
  or: string;
  /** The Dashboard as the end of the way back sentence. */
  dashboard: string;
  /** The Dashboard as the rail's logo names it. */
  home: string;
  /** The cursor's name tag. */
  you: string;
  /** The person's account as the sketch lists it: every tailnet carries it alike. */
  account: string;
  otherTailnet: string;
};

const copy: Record<"cs" | "en", Copy> = {
  cs: {
    title: "Zapněte Tailscale",
    place: (environment, organization) =>
      organization
        ? `${environment} Prostředí v Organizaci ${organization}`
        : `${environment} Prostředí`,
    desktop: "Zapněte Tailscale a vyberte síť",
    phone: "Otevřete Tailscale a vyberte síť",
    windows:
      "Na ikonu Tailscale klikněte pravým tlačítkem. Nevidíte ji? Je schovaná pod šipkou ^ vedle hodin. ",
    failed: "Nepovedlo se? Pomůže",
    docs: "podrobný návod",
    or: ", nebo se vraťte do",
    dashboard: "Lazuria",
    home: "Lazurio",
    you: "Vy",
    account: "Váš účet",
    otherTailnet: "jiná síť",
  },
  en: {
    title: "Turn on Tailscale",
    place: (environment, organization) =>
      organization
        ? `${environment} Environment of ${organization}`
        : `${environment} Environment`,
    desktop: "Turn on Tailscale and choose the network",
    phone: "Open Tailscale and choose the network",
    windows:
      "Right-click the Tailscale icon. Don't see it? It hides under the ^ arrow by the clock. ",
    failed: "Didn't work? Read the",
    docs: "detailed guide",
    or: ", or go back to the",
    dashboard: "Dashboard",
    home: "Dashboard",
    you: "You",
    account: "Your account",
    otherTailnet: "another network",
  },
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Tailscale's mark (nine dots, the T solid), the cursor from lazurio.ai's
 * hero with its name tag, a finger's touch and a tick, drawn once and used by
 * every sketch. */
function defs(c: Copy): string {
  const dots = Array.from(
    { length: 9 },
    (_, index) =>
      `<circle cx="${4 + (index % 3) * 8}" cy="${4 + Math.floor(index / 3) * 8}" r="2.6" fill="currentColor"${[3, 4, 5, 7].includes(index) ? "" : ' opacity=".3"'}/>`,
  ).join("");
  const tag = (x: number, y: number) =>
    `<g class="tag" transform="translate(${x} ${y})"><rect width="28" height="18" rx="9"/><text x="14" y="12.5">${c.you}</text></g>`;
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<symbol id="ts" viewBox="0 0 24 24">${dots}</symbol>
<g id="arrow"><path class="arrow" transform="scale(1.15) translate(-5 -5)" d="M19.5027 9.96958C20.7073 10.4588 20.6154 12.1941 19.3658 12.5533L13.0605 14.3658L10.1807 20.2606C9.60996 21.4288 7.88499 21.218 7.6124 19.9468L4.67677 6.25646C4.44638 5.18204 5.5121 4.2878 6.53019 4.70126L19.5027 9.96958Z"/>${tag(13, 19)}</g>
<g id="touch"><circle class="touch" r="12"/>${tag(12, -28)}</g>
<path id="tick" d="M0 0l3.2 3.2l6-7"/>
</defs></svg>`;
}

/** One account row: the person's account in one tailnet. */
function account(
  x: number,
  y: number,
  name: string,
  host: string,
  kind: "other" | "target",
  tick: boolean,
): string {
  const text =
    kind === "target"
      ? `<text class="host" x="${x + 38}" y="${y + 30}">${host}</text>`
      : `<text class="other-t" x="${x + 38}" y="${y + 30}">${host}</text>`;
  return `<g class="${kind}">${kind === "target" ? `<rect class="target-bg" x="${x - 4}" y="${y}" width="${270}" height="40" rx="6"/>` : ""}${tick ? `<use href="#tick" class="tick" x="${x - 1}" y="${y + 20}"/>` : ""}<circle class="avatar" cx="${x + 22}" cy="${y + 20}" r="10"/><text class="avatar-t" x="${x + 22}" y="${y + 23.5}">•</text><text class="name" x="${x + 38}" y="${y + 17}">${name}</text>${text}</g>`;
}

/** The submenu of the person's tailnets: another one active, this one to choose. */
function tailnets(
  c: Copy,
  name: string,
  tailnet: string,
  y: number,
  up: boolean,
): string {
  return `<g class="sub${up ? " up" : ""}"><rect class="panel" x="48" y="${y}" width="282" height="94" rx="9"/>${account(60, y + 4, name, c.otherTailnet, "other", true)}${account(60, y + 44, name, tailnet, "target", true)}</g>`;
}

/** The account row of the main menu, whose submenu holds the tailnets. */
function accountRow(c: Copy, name: string, y: number): string {
  return `<rect class="acct-bg" x="336" y="${y}" width="208" height="40" rx="6"/><circle class="avatar" cx="360" cy="${y + 20}" r="10"/><text class="avatar-t" x="360" y="${y + 23.5}">•</text><text class="name" x="376" y="${y + 17}">${name}</text><text class="other-t" x="376" y="${y + 30}">${c.otherTailnet}</text><path class="chev" d="M528 ${y + 15}l5 5l-5 5"/>`;
}

const switchRow = (x: number, y: number) =>
  `<rect class="track" x="${x}" y="${y}" width="32" height="18" rx="9"/><circle class="knob" cx="${x + 9}" cy="${y + 9}" r="7"/>`;

/**
 * The sketches, drawn after the real clients (Matěj's screenshots and his
 * acceptance on macOS and Windows, 2026-10-11), not screenshots, so they
 * survive redesigns. Each lists where the pointer goes: a press, or a hover
 * (~) that opens a submenu. The pointer ends on the tailnet to choose.
 */
function sketches(c: Copy, tailnet: string): string {
  const name = c.account;
  const mac = `<svg class="sc" data-os="macos" viewBox="0 0 560 196" data-start="190,176" data-steps="430,13,open 516,53,switch 470,96,~account 82,127,select">
<rect class="desk" width="560" height="196"/><rect class="bar" width="560" height="26"/><path class="edge" d="M0 26.5h560"/>
<rect class="blob" x="14" y="8" width="10" height="10" rx="2.5"/><rect class="blob" x="36" y="9.5" width="30" height="7" rx="3.5"/><rect class="blob" x="74" y="9.5" width="26" height="7" rx="3.5"/><rect class="blob" x="108" y="9.5" width="34" height="7" rx="3.5"/>
<rect class="blob" x="384" y="9" width="18" height="8" rx="4"/><use href="#ts" class="glyph" x="423" y="6" width="14" height="14"/><rect class="blob" x="452" y="9" width="14" height="8" rx="4"/><rect class="blob" x="474" y="8.5" width="22" height="9" rx="3"/><text class="clock" x="522" y="17">9:41</text>
<g class="menu"><rect class="panel" x="330" y="32" width="220" height="96" rx="9"/><text class="strong" x="346" y="57">Tailscale</text>${switchRow(500, 44)}<path class="sep" d="M340 70.5h200"/>${accountRow(c, name, 78)}${tailnets(c, name, tailnet, 70, false)}</g>
<circle class="ripple" r="10"/><g class="cur"><use href="#arrow"/></g></svg>`;
  const windows = `<svg class="sc" data-os="windows" viewBox="0 0 560 196" data-start="180,40" data-steps="420,180,open 470,72,~account 82,103,select 500,125,switch" hidden>
<rect class="desk" width="560" height="196"/><rect class="bar" y="164" width="560" height="32"/><path class="edge" d="M0 163.5h560"/>
<rect class="blob" x="16" y="173" width="14" height="14" rx="3"/><rect class="blob" x="42" y="174" width="120" height="12" rx="6"/><rect class="blob" x="176" y="173" width="14" height="14" rx="3"/><rect class="blob" x="200" y="173" width="14" height="14" rx="3"/>
<path class="chev" d="M386 183l4-4l4 4"/><use href="#ts" class="glyph" x="413" y="173" width="14" height="14"/><rect class="blob" x="440" y="176" width="14" height="8" rx="4"/><text class="clock" x="508" y="184">9:41</text>
<g class="menu up"><rect class="panel" x="330" y="46" width="220" height="102" rx="9"/>${accountRow(c, name, 54)}<path class="sep" d="M340 102.5h200"/><rect class="connect-bg" x="336" y="110" width="208" height="30" rx="6"/><text class="strong connect" x="352" y="129">Connect</text>${tailnets(c, name, tailnet, 46, true)}</g>
<circle class="ripple" r="10"/><g class="cur"><use href="#arrow"/></g></svg>`;
  const icons = [
    [178, 62],
    [294, 62],
    [352, 62],
    [178, 124],
    [236, 124],
    [294, 124],
    [178, 186],
  ]
    .map(
      ([x, y]) =>
        `<rect class="icon" x="${x}" y="${y}" width="40" height="40" rx="10"/>`,
    )
    .join("");
  const phone = `<svg class="sc" data-os="phone" viewBox="0 0 560 220" data-start="470,180" data-steps="256,82,open 378,66,account 190,192,select 368,108,switch" hidden>
<rect class="desk" width="560" height="220"/><rect class="frame" x="150" y="12" width="260" height="270" rx="36"/><rect class="desk" x="158" y="20" width="244" height="262" rx="29"/>
<g class="home">${icons}<rect class="app-icon" x="236" y="62" width="40" height="40" rx="10"/><use href="#ts" x="246" y="72" width="20" height="20" style="color:#fff"/></g>
<g class="app"><rect class="screen" x="158" y="20" width="244" height="262" rx="29"/><text class="title" x="176" y="72">Tailscale</text><circle class="avatar" cx="378" cy="66" r="12"/><text class="avatar-t" x="378" y="69.5">•</text>
<text class="strong" x="176" y="112">Tailscale</text>${switchRow(352, 99)}
<g class="sub"><rect class="panel" x="166" y="132" width="228" height="100" rx="12"/>${account(168, 132, name, c.otherTailnet, "other", false)}<g class="target"><rect class="target-bg" x="172" y="172" width="216" height="40" rx="8"/><circle class="avatar" cx="190" cy="192" r="10"/><text class="avatar-t" x="190" y="195.5">•</text><text class="name" x="206" y="189">${name}</text><text class="host small" x="206" y="202">${tailnet}</text></g></g></g>
<rect class="frame ios" x="250" y="28" width="60" height="16" rx="8"/><circle class="frame android" cx="280" cy="36" r="5"/><text class="clock" x="190" y="40">9:41</text>
<circle class="ripple" r="10"/><g class="cur"><use href="#touch"/></g></svg>`;
  return mac + windows + phone;
}

const style = `
:root{color-scheme:light;--ink:#090909;--muted:#707070;--faint:#999;--line:#dddcdb;--line-faint:#ecebea;--paper:#fbfaf9;--desk:#f5f4f3;--blob:#dddcdb;--track:#c3c2c1;--blue:#0d12db;--blue-50:#ebf1fe;--blue-700:#0b0e91;--orchid:#c77dbb}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.rail{position:fixed;inset:0 auto 0 0;display:flex;width:64px;flex-direction:column;align-items:center;padding:12px 0;background:var(--paper)}
.home{display:grid;width:40px;height:40px;place-items:center;border-radius:10px}
a.home:hover{background:var(--line-faint)}
.disc{display:grid;width:32px;height:32px;place-items:center;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.08)}
.disc svg{width:20px;height:20px}
main{display:flex;min-height:100vh;flex-direction:column;justify-content:center;gap:28px;max-width:520px;margin:0 auto;padding:40px 16px 40px 80px;box-sizing:content-box}
.scene{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--desk)}
.scene svg{display:block;width:100%;height:auto}
.say{display:flex;flex-direction:column;gap:14px}
h1{margin:0;font-size:30px;line-height:1.22;letter-spacing:-.02em;text-wrap:balance}
.net{display:inline-block;margin-top:6px;padding:2px 8px;border-radius:6px;background:var(--blue-50);color:var(--blue-700);font:500 .62em/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:0;overflow-wrap:anywhere}
.help{margin:0;color:var(--muted);font-size:13.5px}
.help a{color:var(--ink);font-weight:600;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}
.help a:hover{text-decoration-color:currentColor}
a:focus-visible{outline:2px solid var(--blue);outline-offset:2px;border-radius:4px}
.desk{fill:var(--desk)}.bar{fill:#fff}.edge{stroke:var(--line)}.blob,.icon{fill:var(--blob)}
.glyph{color:var(--ink)}.clock{fill:var(--ink);font:600 11px -apple-system,"Segoe UI",sans-serif;text-anchor:middle}
.panel{fill:#fff;stroke:var(--line)}.sep{stroke:var(--line-faint)}
.strong{fill:var(--ink);font:600 12px -apple-system,"Segoe UI",sans-serif}
.title{fill:var(--ink);font:700 16px -apple-system,"Segoe UI",sans-serif}
.name{fill:var(--ink);font:600 11px -apple-system,"Segoe UI",sans-serif}
.host{fill:var(--blue-700);font:9px ui-monospace,"SF Mono",Menlo,Consolas,monospace}.host.small{font-size:7.6px}
.other-t{fill:var(--faint);font:9.5px -apple-system,"Segoe UI",sans-serif}
.avatar{fill:var(--line-faint)}.avatar-t{fill:var(--ink);font:600 10px -apple-system,"Segoe UI",sans-serif;text-anchor:middle}
.chev{fill:none;stroke:var(--ink);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.tick{fill:none;stroke:var(--ink);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;transition:opacity .2s}
.frame{fill:#262626}.screen{fill:#fff}.app-icon{fill:#171717}
.menu,.sub,.app{opacity:0;transition:opacity .18s ease}
.home{transition:opacity .2s}
.is-open .menu,.is-open .app,.is-account .sub{opacity:1}
.is-open .home{opacity:0}
.track{fill:var(--track);transition:fill .2s}.knob{fill:#fff;transition:transform .2s ease}
.is-switch .track{fill:var(--blue)}.is-switch .knob{transform:translateX(14px)}
.acct-bg{fill:transparent;transition:fill .2s}.is-account .acct-bg{fill:var(--blue-50)}
.target-bg{fill:var(--blue-50);transition:fill .2s}
.target text,.target .avatar{transition:fill .2s}
.is-select .target-bg{fill:var(--blue)}
.is-select .target .name,.is-select .target .host,.is-select .target .avatar-t{fill:#fff}
.is-select .target .avatar{fill:rgba(255,255,255,.22)}
.target .tick{opacity:0;stroke:#fff}.is-select .target .tick{opacity:1}.is-select .other .tick{opacity:0}
.connect-bg{fill:transparent;transition:fill .2s}.connect{transition:fill .2s}
.is-switch .connect-bg{fill:var(--blue)}.is-switch .connect{fill:#fff}
.ripple{fill:none;stroke:var(--orchid);stroke-width:2;opacity:0}
.arrow{fill:var(--orchid);stroke:#fff;stroke-width:1.6;stroke-linejoin:round}
.touch{fill:var(--orchid);fill-opacity:.55;stroke:#fff;stroke-width:1.6}
.tag rect{fill:var(--orchid)}.tag text{fill:var(--ink);font:600 11px -apple-system,"Segoe UI",sans-serif;text-anchor:middle}
@media (max-width:640px){.rail{position:static;width:auto;flex-direction:row;padding:8px 12px}main{min-height:0;padding:16px;gap:22px}h1{font-size:25px}}
`;

/**
 * Shows the sketch and the words of the person's system, plays the sketch
 * (the finished state with reduced motion), and continues once the address
 * answers: a same-origin request the worker does not take (only navigations
 * reach it), on return to the window, when the browser reports a connection
 * and every few seconds.
 */
const script = `
(function(){
  var ua=navigator.userAgent, p=/iPhone|iPad|iPod/.test(ua)?"ios":/Android/.test(ua)?"android":/Windows/.test(ua)?"windows":"macos";
  var group=p==="ios"||p==="android"?"phone":p;
  document.querySelectorAll("[data-show]").forEach(function(el){if(el.getAttribute("data-show").split(" ").indexOf(p)<0)el.setAttribute("hidden","");else el.removeAttribute("hidden")});
  var svg=null;
  document.querySelectorAll(".sc").forEach(function(el){if(el.getAttribute("data-os")===group){el.removeAttribute("hidden");svg=el}else el.setAttribute("hidden","")});
  if(svg){
    var ios=svg.querySelector(".ios"),droid=svg.querySelector(".android");
    if(ios)ios.style.display=p==="ios"?"":"none";
    if(droid)droid.style.display=p==="android"?"":"none";
    var cur=svg.querySelector(".cur"),ring=svg.querySelector(".ripple");
    var start=svg.getAttribute("data-start").split(",").map(Number);
    var plan=[{k:"wait",d:700,at:start}],from=start,MOVE=950,PRESS=200,GAP=380;
    svg.getAttribute("data-steps").split(" ").forEach(function(s){var a=s.split(","),to=[+a[0],+a[1]],hover=a[2].charAt(0)==="~";plan.push({k:"move",d:MOVE,from:from,to:to});if(hover)plan.push({k:"hover",d:GAP+PRESS,at:to,act:a[2].slice(1)});else{plan.push({k:"press",d:PRESS,at:to,act:a[2]});plan.push({k:"wait",d:GAP,at:to})}from=to});
    plan.push({k:"wait",d:2200,at:from});plan.push({k:"fade",d:450,from:from,to:start});
    var total=plan.reduce(function(s,q){return s+q.d},0),t0=performance.now();
    var ease=function(t){return t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2};
    var place=function(x,y,s){cur.setAttribute("transform","translate("+x.toFixed(1)+" "+y.toFixed(1)+") scale("+s+")")};
    var flags=function(f){["open","switch","account","select"].forEach(function(n){svg.classList.toggle("is-"+n,f.indexOf(n)>=0)})};
    var frame=function(now){
      var t=(now-t0)%total,f=[],click=null,since=0;
      for(var i=0;i<plan.length;i++){var q=plan[i];
        if(t>=q.d){if(q.k==="press"){f.push(q.act);click=q.at;since=0}else if(click)since+=q.d;if(q.k==="hover")f.push(q.act);if(q.k==="fade"){f=[];click=null}t-=q.d;continue}
        var k=t/q.d;
        if(q.k==="wait"||q.k==="hover")place(q.at[0],q.at[1],1);
        if(q.k==="hover")f.push(q.act);
        if(q.k==="move"||q.k==="fade"){var e=ease(k);place(q.from[0]+(q.to[0]-q.from[0])*e,q.from[1]+(q.to[1]-q.from[1])*e,1)}
        if(q.k==="press")place(q.at[0],q.at[1],1-.18*Math.sin(Math.PI*k));
        if(q.k==="fade"){f=[];click=null}
        if(click&&q.k!=="press")since+=t;
        break}
      flags(f);
      if(click&&since<520){var r=since/520;ring.setAttribute("cx",click[0]);ring.setAttribute("cy",click[1]);ring.setAttribute("r",(6+16*r).toFixed(1));ring.style.opacity=(.8*(1-r)).toFixed(2)}else ring.style.opacity=0;
      requestAnimationFrame(frame)};
    if(matchMedia("(prefers-reduced-motion: reduce)").matches){var steps=plan.filter(function(q){return q.act});flags(steps.map(function(q){return q.act}));var sel=steps.filter(function(q){return q.act==="select"})[0];place(sel.at[0],sel.at[1],1)}
    else requestAnimationFrame(frame);
  }
  var busy=false;
  function attempt(){if(busy)return;busy=true;fetch(location.href,{cache:"no-store",credentials:"same-origin",redirect:"manual"}).then(function(){location.reload()},function(){}).finally(function(){busy=false})}
  addEventListener("focus",attempt);addEventListener("online",attempt);
  document.addEventListener("visibilitychange",function(){if(!document.hidden)attempt()});
  setInterval(attempt,4000);
})();
`;

export function renderOfflineGuide(input: OfflineGuideInput): string {
  const c = copy[input.locale];
  const dashboard =
    input.dashboard !== null && /^https:\/\//.test(input.dashboard)
      ? escapeHtml(input.dashboard)
      : null;
  const home =
    dashboard === null
      ? `<span class="home"><span class="disc">${symbol}</span></span>`
      : `<a class="home" href="${dashboard}" title="${c.home}" aria-label="${c.home}"><span class="disc">${symbol}</span></a>`;
  const back =
    dashboard === null
      ? "."
      : `${c.or} <a class="back" href="${dashboard}">${c.dashboard}</a>.`;
  const environment = escapeHtml(input.environment);
  const organization =
    input.organization === null ? null : escapeHtml(input.organization);
  const tailnet = escapeHtml(input.tailnet);
  return `<!doctype html>
<html lang="${input.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${c.title} · ${c.place(environment, organization)}</title><style>${style}</style></head>
<body><nav class="rail" aria-label="Lazurio">${home}</nav>${defs(c)}<main>
<figure class="scene" aria-hidden="true" style="margin:0">${sketches(c, tailnet)}</figure>
<section class="say">
<h1><span data-show="macos windows">${c.desktop}</span><span data-show="ios android" hidden>${c.phone}</span><br><code class="net">${tailnet}</code></h1>
<p class="help"><span data-show="windows" hidden>${c.windows}</span>${c.failed} <a href="${escapeHtml(input.docs)}" target="_blank" rel="noreferrer">${c.docs}</a>${back}</p>
</section></main><script>${script}</script></body></html>
`;
}
