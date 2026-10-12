// A preview of Nová karta (decision F47 step 3) against fakes, never a live
// Environment: `bun scripts/preview-new-tab.ts [port] [cs|en] [team]`.
// It serves the bundled page `/new-tab` with the boot document a hosted
// Launchpad writes into it (`withBoot`) and its headers
// (`newTabPageHeaders`), and answers Nová karta's routes with the real ones
// of step 2 (`createNewTabRoutes`): their hub is a loopback fake of the view's
// four requests with five tabs (one an agent works in, one that the T3 Code
// thread `t3-x` holds, one held by the Launchpad, one a page opened, one
// nobody knows), each with its heap but one; their service manager and
// `/proc/meminfo` are fakes that put the Environment's memory at about 85 %
// (warn) with two running Modules; their holder file lives in a temporary
// runtime directory, which starts with the Launchpad holding two tabs. A
// close ends a tab after 8 s, Vrátit within them brings it back; × in the
// panel's strip releases the Launchpad's hold; Zastavit stops a fake Module,
// an address opens a fake tab. The
// view's origin is a synthetic https one that does not resolve, so a
// standalone choice navigates to an address that does not load, and a tab's
// frame in the Launchpad's panel shows the browser's own error page; inside
// the host page every choice is only logged.
//
//   http://127.0.0.1:<port>/          the Launchpad's page with its right
//                                     panel (the Browser toggle in Apps): the
//                                     strip, "+" and Nová karta in the element
//   http://127.0.0.1:<port>/new-tab   standalone (as Codex Desktop opens it)
//   http://127.0.0.1:<port>/host      inside <lazurio-new-tab> with T3 Code's
//                                     tools, strip `t3-x`, and switches for
//                                     the language, focus-address and a dark
//                                     theme
//   http://127.0.0.1:<port>/preview   these links and the failure switches:
//   /preview/set?hub=down|up          the view's hub stops or starts answering
//   /preview/set?browser=none|present the Environment has no browser (every
//                                     route of Nová karta answers 404
//                                     `no-browser`, as a workstation's)
//
// The Launchpad's page reads nothing but its profile and Nová karta's routes
// here; its other sections say they could not be read. `team` makes the
// Environment a Team Environment (its note). Synthetic names only; stop it
// with Ctrl-C.
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holderFileText } from "../src/browser/people/holds";
import type { TabFacts } from "../src/browser/people/hub";
import type { LaunchpadBoot } from "../src/launchpad/boot";
import { withBoot } from "../src/launchpad/boot-document";
import type { PublicEntry } from "../src/launchpad/chat";
import { launchpadHolderOf } from "../src/launchpad/new-tab/holder";
import type { ModuleUnit } from "../src/launchpad/new-tab/modules";
import {
  createNewTabRoutes,
  type NewTabHost,
  newTabPageHeaders,
} from "../src/launchpad/new-tab-routes";
import { pageRoutes } from "../src/launchpad/page";
import type { ServiceManagerProcess } from "../src/modules/service-manager-process";
import { readFolderCatalog } from "../src/organizations/catalog";
import { parseShell, type Shell } from "../src/shell/contract";
import { writeOrganization } from "../tests/fixtures/catalog-folder";

const port = Number(process.argv[2] ?? 24620);
const locale: "cs" | "en" = process.argv[3] === "en" ? "en" : "cs";
const team = process.argv.slice(2).includes("team");
const base = "vm-01.example.lazurio.io";
const viewOrigin = `https://browser.${base}`;
const czech = locale === "cs";

const parent = await realpath(
  await mkdtemp(join(tmpdir(), "new-tab-preview-")),
);
const folder = join(parent, "Lazurio");
await mkdir(folder, { mode: 0o700 });
await mkdir(join(folder, "organizations"), { mode: 0o755 });
const runtime = join(parent, "run");
const holders = join(runtime, "lazurio-browser", "holders");
await mkdir(holders, { recursive: true, mode: 0o700 });

// The example Organization of the boot catalog: what Navrhované offers and
// how the running Modules are named.
await writeOrganization(folder, "example_GEN3", {
  slug: "example",
  state: "current",
  modules: [
    {
      id: "mission-control",
      path: "mission-control",
      runtime: { title: "Mission Control v3", icon: "control" },
    },
    { id: "knowledgebase", runtime: { title: "Knowledgebase", icon: "book" } },
    { id: "deals", runtime: { title: "Deals v2", icon: "deal" } },
    { id: "pricebook", runtime: { title: "Ceník", icon: "pricebook" } },
    { id: "brainstorm", apps: false },
  ],
});
const catalog = await readFolderCatalog(folder);

const shell: Shell | null = parseShell({
  schema: "lazurio.shell.v1",
  locale,
  current: "vm-01.example",
  operator: { initials: "JN", login: "example-user", avatar: null },
  environments: [
    {
      id: "vm-01.example",
      label: team ? "Obchod" : null,
      kind: team ? "team" : "work",
      organizations: ["example"],
      assignee: team ? null : "example-user",
      // Apps on the preview's own origin, as a path: the page then accepts
      // the host page of this origin, as the Launchpad's own panel is.
      apps: { apps: "/", chat: `https://t3code.${base}/`, automate: null },
    },
  ],
  organizations: [
    {
      slug: "example",
      name: "Example Company",
      avatar: null,
      dashboard: "https://dashboard.lazurio.ai/orgs/example",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/",
  account: "https://dashboard.lazurio.ai/settings",
  addOrganization: null,
});
if (shell === null) throw new Error("The preview's shell document is invalid");
const entry: PublicEntry = {
  launchpadOrigin: `https://launchpad.${base}`,
  t3codeOrigin: `https://t3code.${base}`,
  moduleOriginTemplate: `https://{module}.${base}`,
  browserOrigin: viewOrigin,
};
const boot: LaunchpadBoot = { locale, shell, catalog, entry };

// ---- The fake hub: the view's four loopback requests (F47 point 6) ----------

const id = (n: number) => n.toString(16).toUpperCase().padStart(32, "0");
const minutes = (count: number) =>
  new Date(Date.now() - count * 60_000).toISOString();
const megabytes = (count: number) => count * 1024 * 1024;
type Tab = Omit<TabFacts, "closing"> & {
  closing: string | null;
  heapUsed: number | null;
};
const tabs = new Map<string, Tab>();
const add = (tab: Tab) => tabs.set(tab.id, tab);
const fact = (
  n: number,
  extra: Partial<Tab> & Pick<Tab, "url" | "title">,
): Tab => ({
  id: id(n),
  favicon: null,
  openedAt: minutes(300),
  usedAt: minutes(0),
  opener: { kind: "unknown" },
  agents: [],
  holders: [],
  viewers: 0,
  closing: null,
  grace: null,
  heapUsed: null,
  ...extra,
});
add(
  fact(1, {
    url: "https://crm.example.com/deals?stage=won",
    title: czech ? "Obchody – CRM" : "Deals – CRM",
    opener: { kind: "agent", session: "codex-a1" },
    agents: ["codex-a1"],
    usedAt: minutes(0),
    heapUsed: megabytes(236),
  }),
);
add(
  fact(2, {
    url: "https://invoices.example.com/2026/09",
    title: czech
      ? "Faktury za září – Účetnictví"
      : "September invoices – Accounting",
    opener: { kind: "agent", session: "t3-x" },
    holders: [
      {
        strip: "t3-x",
        label: czech ? "Faktury za září" : "September invoices",
      },
    ],
    usedAt: minutes(3),
    heapUsed: megabytes(612),
  }),
);
add(
  fact(3, {
    url: "https://documentation.lazurio.ai/cs/guide/",
    title: czech ? "Průvodce Lazuriem" : "Lazurio guide",
    favicon: "https://lazurio.ai/favicon.ico",
    opener: { kind: "new-tab", strip: "launchpad" },
    holders: [{ strip: "launchpad", label: "Launchpad" }],
    usedAt: minutes(125),
    heapUsed: megabytes(95),
  }),
);
add(
  fact(4, {
    url: "https://accounts.example.com/signin",
    title: czech ? "Přihlášení" : "Sign in",
    opener: { kind: "page", openerId: id(3) },
    usedAt: minutes(26 * 60),
    heapUsed: null,
  }),
);
add(
  fact(5, {
    url: "https://example.org/reports/q3.pdf",
    title: "",
    usedAt: minutes(3 * 24 * 60),
    heapUsed: megabytes(64),
  }),
);
let next = 16;
const closingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const json = (body: unknown, status = 200) => Response.json(body, { status });
// The failure switches of /preview/set.
const switches = { hubDown: false, noBrowser: false };
const hub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    // Down: no answer of the hub's own, which the Launchpad reads as a hub
    // that is unreachable (hub-client.ts).
    if (switches.hubDown) return new Response("down", { status: 503 });
    const url = new URL(request.url);
    if (url.pathname === "/.lazurio/tabs" && request.method === "GET") {
      const heap = url.searchParams.get("heap") === "1";
      return json({
        tabs: [...tabs.values()].map(({ heapUsed, ...facts }) =>
          heap
            ? {
                ...facts,
                heap:
                  heapUsed === null
                    ? null
                    : { used: heapUsed, total: heapUsed * 2 },
              }
            : facts,
        ),
      });
    }
    if (url.pathname === "/.lazurio/tabs" && request.method === "POST") {
      const body = (await request.json()) as { url?: unknown; strip?: unknown };
      if (typeof body.url !== "string")
        return json({ error: "invalid-request" }, 400);
      const n = next++;
      const tab = id(n);
      const strip = typeof body.strip === "string" ? body.strip : null;
      add(
        fact(n, {
          url: body.url,
          title: new URL(body.url).hostname,
          opener: { kind: "new-tab", strip },
          holders: strip === "launchpad" ? [{ strip, label: "Launchpad" }] : [],
          heapUsed: megabytes(41),
        }),
      );
      return json({ id: tab, view: `/t/${tab}` }, 201);
    }
    const action = /^\/\.lazurio\/tabs\/([0-9A-F]{32})\/(close|restore)$/.exec(
      url.pathname,
    );
    if (action !== null && request.method === "POST") {
      const [, tab = "", what] = action;
      const known = tabs.get(tab);
      if (known === undefined) return json({ error: "not-found" }, 404);
      if (what === "close") {
        if (known.closing === null) {
          known.closing = new Date(Date.now() + 8_000).toISOString();
          closingTimers.set(
            tab,
            setTimeout(() => {
              tabs.delete(tab);
              closingTimers.delete(tab);
            }, 8_000),
          );
        }
        return json({ closing: known.closing }, 202);
      }
      if (known.closing === null)
        return json({ error: "nothing-to-restore" }, 409);
      clearTimeout(closingTimers.get(tab));
      closingTimers.delete(tab);
      known.closing = null;
      return json({ restored: true });
    }
    return json({ error: "not-found" }, 404);
  },
});

// ---- The Launchpad's side: its real routes over fakes ------------------------

// The T3 Code thread `t3-x` names itself in its holder file (F47 point 4),
// and the Launchpad holds two tabs, one of them the thread's too: its strip
// shows those two, Přehled every tab.
await writeFile(
  join(holders, "t3-x.json"),
  holderFileText("t3-x", czech ? "Faktury za září" : "September invoices", [
    { id: id(2), recordedAt: null },
  ]),
  { mode: 0o600 },
);
await writeFile(
  join(holders, "launchpad.json"),
  holderFileText("launchpad", "Launchpad", [
    { id: id(3), recordedAt: null },
    { id: id(2), recordedAt: null },
  ]),
  { mode: 0o600 },
);
const running: ModuleUnit[] = [
  {
    org: "example",
    module: "deals",
    app: "fixture-deals",
    unit: "lazurio-app-example-deals.service",
  },
  {
    org: "example",
    module: "knowledgebase",
    app: "fixture-knowledgebase",
    unit: "lazurio-app-example-knowledgebase.service",
  },
];
const unitMemory: Record<string, number> = {
  "lazurio-browser.service": megabytes(2150),
  "lazurio-launchpad.service": megabytes(180),
  "t3code.service": megabytes(620),
  "lazurio-app-example-deals.service": megabytes(780),
  "lazurio-app-example-knowledgebase.service": megabytes(410),
};
const run: ServiceManagerProcess = async (program, args) => {
  if (program !== "systemctl" || args[1] !== "show")
    return { code: 1, stdout: "", stderr: "unsupported" };
  const units = args.slice(args.indexOf("--") + 1);
  return {
    code: 0,
    stdout: units
      .map(
        (unit) =>
          `Id=${unit}\nMemoryCurrent=${unitMemory[unit] ?? "[not set]"}\n`,
      )
      .join("\n"),
    stderr: "",
  };
};
// About 85 % of 7.75 GiB in use: the warn tone.
const meminfo =
  "MemTotal:        8130000 kB\nMemFree:          410000 kB\nMemAvailable:    1219500 kB\n";
const host: NewTabHost = {
  runtimeDirectory: runtime,
  run,
  readFile: (path) =>
    path === "/proc/meminfo"
      ? Promise.resolve(meminfo)
      : readFile(path, "utf8"),
  bootClock: async () => null,
  log: () => undefined,
};
const holder = launchpadHolderOf(runtime, {
  bootClock: async () => null,
  readFile: host.readFile,
});
await holder?.start();
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const routes = createNewTabRoutes({
  browser: { origin: viewOrigin, listenPort: hub.port ?? 0 },
  holder,
  host,
  modules: async () => running,
  headers,
});
// The same routes where the Environment has no browser.
const withoutBrowser = createNewTabRoutes({
  browser: undefined,
  holder: null,
  host,
  modules: async () => running,
  headers,
});

// The bundled page and the shell's assets, as the Launchpad's inner
// listener serves them.
const inner = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: pageRoutes,
  fetch: () => new Response("not-found", { status: 404 }),
});
const fromInner = (path: string) =>
  fetch(`http://127.0.0.1:${inner.port}${path}`);

const tools = [
  { id: "terminal", label: "Terminal", key: "T", icon: "terminal" },
  { id: "files", label: "Files", key: "F", icon: "files" },
  { id: "diff", label: "Diff", key: "D", icon: "diff" },
  { id: "pull-request", label: "Pull request", key: "P", icon: "pull-request" },
  { id: "agents", label: "Agents", key: "A", icon: "agents" },
  { id: "device", label: "Device", key: "M", icon: "device" },
];
const attribute = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const indexPage =
  () => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><title>Nová karta – preview</title>
<style>body{margin:0;padding:40px;font:15px/1.5 system-ui,sans-serif;color:#1a1a1a}a{color:#0d12db}li{margin:6px 0}code{font-size:13px}</style></head>
<body><h1>Nová karta – preview (F47 step 3)</h1><ul>
<li><a href="/">/</a> – the Launchpad's page: Prohlížeč opens the right panel with the strip of the tabs the Launchpad holds, "+" and Nová karta (strip <code>launchpad</code>, focus-address). A tab's frame shows the browser's error page: the view's origin is synthetic.</li>
<li><a href="/new-tab">/new-tab</a> – standalone, as Codex Desktop's browser opens it: strip <code>launchpad</code>, no tools, the address bar takes the focus; a choice navigates this window to the tab's (synthetic, unreachable) view.</li>
<li><a href="/host">/host</a> – inside <code>&lt;lazurio-new-tab&gt;</code> with T3 Code's tools and the strip <code>t3-x</code>; choices are logged, never navigated.</li>
</ul><p>Everything here is fake: five tabs, memory at about 85 %, two running Modules. A close ends a tab after 8 s; Vrátit within them brings it back.</p>
<p>Failures: the view's hub is <strong>${switches.hubDown ? "down" : "up"}</strong> (<a href="/preview/set?hub=down">down</a> · <a href="/preview/set?hub=up">up</a>); the Environment has <strong>${switches.noBrowser ? "no browser" : "its browser"}</strong> (<a href="/preview/set?browser=none">none</a> · <a href="/preview/set?browser=present">present</a>).</p></body></html>`;

const hostPage = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nová karta – in a host</title>
<script type="module" src="/.lazurio/shell.js"></script>
<style>
html{color-scheme:light}
html.dark{color-scheme:dark;--lazurio-surface:#151515;--lazurio-ink:#ececec;--lazurio-ink-muted:#a3a3a3;--lazurio-line:#2c2c2c;--lazurio-line-strong:#3d3d3d;--lazurio-hover:#202020;--lazurio-selected:#262626;--lazurio-control:#1b1b1b;--lazurio-raised:#1d1d1d;--lazurio-overlay:#1d1d1d;--lazurio-overlay-ink:#ececec;--lazurio-focus:#7b93ff}
body{margin:0;height:100vh;display:grid;grid-template-columns:minmax(0,1fr) min(520px,60vw);font:14px/1.5 system-ui,sans-serif;background:#f4f4f2;color:#1a1a1a}
html.dark body{background:#0e0e0e;color:#ddd}
.chat{padding:24px 28px;overflow:auto}.chat h1{margin:0 0 6px;font-size:17px}.chat p{margin:0 0 14px;color:#666}html.dark .chat p{color:#999}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}.controls button{padding:6px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer}html.dark .controls button{background:#1d1d1d;border-color:#333;color:#ddd}
#log{margin:0;padding:12px;min-height:120px;border:1px solid #ddd;border-radius:8px;background:#fff;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap}html.dark #log{background:#151515;border-color:#2c2c2c}
.panel{display:flex;flex-direction:column;min-height:0;border-left:1px solid #e2e2df;background:var(--lazurio-surface,#fff)}html.dark .panel{border-color:#2c2c2c}
.strip{display:flex;align-items:center;gap:6px;height:42px;padding:0 8px;border-bottom:1px solid #ececea;background:#fafaf8}html.dark .strip{background:#181818;border-color:#2c2c2c}
.strip span{padding:5px 12px;border:1px solid #ddd;border-radius:6px;background:#fff;font-size:13px}html.dark .strip span{background:#1d1d1d;border-color:#333}
lazurio-new-tab{flex:1;min-height:0}
</style></head><body>
<section class="chat">
<h1>T3 Code (mock)</h1>
<p>The right panel holds <code>&lt;lazurio-new-tab strip="t3-x"&gt;</code> with T3 Code's tools. Letters T, F, D, P, A, M choose a tool while nobody types in Nová karta. What the tab became is logged below; the element never navigates this page.</p>
<div class="controls">
<button type="button" id="lang">lang: ${locale}</button>
<button type="button" id="focus">focus-address: off</button>
<button type="button" id="dark">dark theme: off</button>
<button type="button" id="strip">strip: t3-x</button>
</div>
<pre id="log">lazurio-new-tab events:\n</pre>
</section>
<aside class="panel"><div class="strip"><span>Nová karta</span></div>
<lazurio-new-tab id="nt" strip="t3-x" lang="${locale}" tools="${attribute(JSON.stringify(tools))}"></lazurio-new-tab></aside>
<script type="module">
const nt = document.getElementById("nt");
const log = document.getElementById("log");
document.addEventListener("lazurio-new-tab", (event) => {
  log.textContent += new Date().toLocaleTimeString() + "  " + JSON.stringify(event.detail) + "\\n";
});
const toggle = (id, apply) => document.getElementById(id).addEventListener("click", (event) => apply(event.currentTarget));
toggle("lang", (button) => { const next = nt.getAttribute("lang") === "cs" ? "en" : "cs"; nt.setAttribute("lang", next); button.textContent = "lang: " + next; });
toggle("focus", (button) => { const on = !nt.hasAttribute("focus-address"); nt.toggleAttribute("focus-address", on); button.textContent = "focus-address: " + (on ? "on" : "off"); });
toggle("dark", (button) => { const on = document.documentElement.classList.toggle("dark"); button.textContent = "dark theme: " + (on ? "on" : "off"); });
toggle("strip", (button) => { const next = nt.getAttribute("strip") === "t3-x" ? "t3-y" : "t3-x"; nt.setAttribute("strip", next); button.textContent = "strip: " + next; });
</script>
</body></html>`;

const html = (body: string) =>
  new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  development: false,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      // The Launchpad's page as a hosted Launchpad answers it: with its boot
      // document, whose entry routes the browser's view, so the right panel
      // is offered.
      const page = await fromInner("/");
      const answer = new Response(page.body, {
        status: page.status,
        headers: {
          ...headers,
          "Content-Type": page.headers.get("content-type") ?? "text/html",
        },
      });
      return withBoot(answer, boot);
    }
    if (url.pathname === "/preview" && request.method === "GET")
      return html(indexPage());
    if (url.pathname === "/preview/set" && request.method === "GET") {
      const hubState = url.searchParams.get("hub");
      const browserState = url.searchParams.get("browser");
      if (hubState === "down" || hubState === "up")
        switches.hubDown = hubState === "down";
      if (browserState === "none" || browserState === "present")
        switches.noBrowser = browserState === "none";
      return html(indexPage());
    }
    if (url.pathname === "/host" && request.method === "GET")
      return html(hostPage);
    if (url.pathname === "/new-tab" && request.method === "GET") {
      // The page as the hosted Launchpad answers it (`fromShell`): its
      // headers and its boot document.
      const page = await fromInner("/new-tab");
      const answer = new Response(page.body, {
        status: page.status,
        headers: {
          ...headers,
          ...newTabPageHeaders({
            externalOrigin: entry.launchpadOrigin,
            t3codeOrigin: entry.t3codeOrigin,
          }),
          "Content-Type": page.headers.get("content-type") ?? "text/html",
        },
      });
      return withBoot(answer, boot);
    }
    if (url.pathname === "/.lazurio/shell.json") return json(shell);
    if (url.pathname === "/.lazurio/browser.json")
      return json({ available: true, view: `${viewOrigin}/`, session: null });
    if (routes.handles(url.pathname))
      return (switches.noBrowser ? withoutBrowser : routes).handle(
        request,
        url,
        () => undefined,
      );
    // The Launchpad page's own first read: the profile of a hosted
    // Environment; everything else it asks is not served here.
    if (url.pathname === "/api/profile" && request.method === "POST")
      return json({
        revision: 1,
        preset: {
          name: team
            ? "hosted-organization-team"
            : "hosted-organization-personal",
          version: 1,
          selection: "recorded",
        },
        allowedPresets: [],
        machine: null,
        profile: { locale },
      });
    const stop = /^\/api\/modules\/([^/]+)\/([^/]+)\/stop$/.exec(url.pathname);
    if (stop !== null && request.method === "POST") {
      const index = running.findIndex(
        (module) =>
          module.org === decodeURIComponent(stop[1] ?? "") &&
          module.module === decodeURIComponent(stop[2] ?? ""),
      );
      if (index < 0) return json({ error: "not-found" }, 404);
      running.splice(index, 1);
      return json({ kind: "module", outcome: "stopped" });
    }
    // Any other request of the Launchpad's page: not served by the preview.
    if (url.pathname.startsWith("/api/"))
      return json({ error: "not-found" }, 404);
    if (request.method === "GET" || request.method === "HEAD")
      return fromInner(`${url.pathname}${url.search}`);
    return json({ error: "not-found" }, 404);
  },
});

console.log(
  JSON.stringify({
    launchpad: `http://127.0.0.1:${server.port}/`,
    standalone: `http://127.0.0.1:${server.port}/new-tab`,
    host: `http://127.0.0.1:${server.port}/host`,
    preview: `http://127.0.0.1:${server.port}/preview`,
    locale,
    team,
    runtime,
  }),
);
