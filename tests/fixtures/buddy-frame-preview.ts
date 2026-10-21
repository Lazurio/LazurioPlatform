import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBuddyFrame } from "../../src/buddy/frame/server";
import { startFakeAdapter } from "./buddy-adapter";
import { freePort } from "./ports";

// A local preview of Buddy's frame for the check in a browser (root decision
// 0178), with no Osobní Prostředí: the scripted fake adapter, the real frame
// server, a host page that plays the shell's side of `lazurio.buddy.*` v1,
// and a stand-in for the gateway, all on one port under
// `*.lazurio.localhost`, which browsers resolve to this computer:
//
//   http://launchpad.jana.lazurio.localhost:<port>/   the host with the bubble
//   http://buddy.jana.lazurio.localhost:<port>/       the frame
//   http://jana.lazurio.localhost:<port>/oauth2/start the gateway's sign-in
//
// The stand-in gateway answers 401 to `/api/*` without its session cookie,
// as the real one does to a request that is no navigation, so the frame
// shows „Přihlásit“; its sign-in sets the cookie and lands on `/signed-in`.
//
//   bun tests/fixtures/buddy-frame-preview.ts [port]

const port = Number(process.argv[2] ?? 8801);
const domain = `lazurio.localhost:${port}`;
const frameHost = `buddy.jana.${domain}`;
const origin = `http://${frameHost}`;
const secret = "preview-secret-0123456789abcdef";
const cookie = "preview-session=1";

const directory = await mkdtemp(join(tmpdir(), "buddy-preview-"));
const secretFile = join(directory, "lazurio_web.secret");
await writeFile(secretFile, `${secret}\n`, { mode: 0o600 });
const personaFile = join(directory, "persona.json");
await writeFile(
  personaFile,
  JSON.stringify({
    schema_version: "lazurio.buddy-persona.v1",
    buddy_name: "Rex",
  }),
);

const adapter = await startFakeAdapter({
  secret,
  script: true,
  streamMs: 30_000,
});
const yesterday = (hour: number, minute = 0) => {
  const day = new Date();
  day.setDate(day.getDate() - 1);
  day.setHours(hour, minute, 0, 0);
  return day.toISOString();
};
adapter.remember({
  message_id: "m-old-1",
  role: "assistant",
  text: "Dobré ráno. Záloha je v pořádku.",
  at: yesterday(7, 30),
  via: "lazurio_web",
  media: [],
});
adapter.remember({
  message_id: "m-old-2",
  role: "user",
  text: "Připomeň mi zítra schůzku v 9:00.",
  at: yesterday(18, 20),
  via: "telegram",
  media: [],
});
adapter.remember({
  message_id: "m-old-3",
  role: "assistant",
  text: "Připomenu vám to **v 9:00**.",
  at: yesterday(18, 21),
  via: "telegram",
  media: [],
});

const listenPort = freePort();
const frame = await startBuddyFrame(
  { origin, listenPort, adapterPort: adapter.port, secretFile },
  { personaFile },
);

const hostPage = `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>Launchpad (náhled)</title>
<style>
  body { margin: 0; font: 15px system-ui, sans-serif; background: #fbfaf9; color: #090909; }
  main { padding: 32px; }
  .controls button { margin-right: 8px; }
  .launcher { position: fixed; right: 22px; bottom: 22px; width: 58px; height: 58px; border: 0; border-radius: 50%;
    background: #fff; box-shadow: 0 0 0 1px #e6e4e0, 0 8px 24px rgba(9,9,9,.1); cursor: pointer; display: grid; place-items: center; }
  .launcher img { width: 40px; height: auto; }
  .panel { position: fixed; right: 22px; bottom: 92px; width: 400px; height: min(600px, calc(100vh - 140px));
    border: 1px solid #e6e4e0; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(9,9,9,.1); background: #fff; }
  .panel.full { left: 50%; right: auto; top: 40px; bottom: 40px; width: 760px; height: auto; transform: translateX(-50%); }
  .scrim { position: fixed; inset: 0; background: rgba(9,9,9,.25); }
  iframe { width: 100%; height: 100%; border: 0; display: block; }
  [hidden] { display: none !important; }
</style></head>
<body>
<main>
  <h1>Apps</h1>
  <p>Host page of the preview: it plays the shell's side of <code>lazurio.buddy.*</code> v1.</p>
  <p class="controls">
    <button id="dark">Dark</button><button id="light">Light</button>
    <button id="en">English</button><button id="cs">Čeština</button>
    <button id="page">Another page</button>
  </p>
  <p id="log"></p>
</main>
<div class="scrim" id="scrim" hidden></div>
<div class="panel" id="panel" hidden></div>
<button class="launcher" id="launcher" title="Buddy"><img src="${origin}/assets/avatar.webp" alt="Buddy"></button>
<script>
  const buddy = ${JSON.stringify(origin)};
  const panel = document.getElementById("panel");
  const scrim = document.getElementById("scrim");
  const log = document.getElementById("log");
  let frame = null;
  let mode = "panel";
  const context = { type: "lazurio.buddy.context", v: 1, lang: "cs", theme: "light",
    environment: { id: "jana", kind: "personal", name: "Osobní Prostředí" },
    organization: null, app: "apps", page: { path: location.pathname }, guide: null };
  const send = () => frame && frame.contentWindow.postMessage(context, buddy);
  const layout = (next) => {
    mode = next;
    panel.hidden = next === "closed";
    panel.classList.toggle("full", next === "fullscreen");
    scrim.hidden = next !== "fullscreen";
  };
  document.getElementById("launcher").onclick = () => {
    if (frame === null) {
      frame = document.createElement("iframe");
      frame.title = "Buddy";
      frame.src = buddy + "/";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads");
      frame.setAttribute("referrerpolicy", "origin");
      frame.setAttribute("allow", "clipboard-write");
      panel.append(frame);
    }
    layout(panel.hidden ? "panel" : "closed");
  };
  scrim.onclick = () => layout("panel");
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && mode === "fullscreen") layout("panel"); });
  window.addEventListener("message", (event) => {
    if (frame === null || event.source !== frame.contentWindow || event.origin !== buddy) return;
    const data = event.data;
    log.textContent = "frame: " + JSON.stringify(data);
    if (data && data.type === "lazurio.buddy.ready") send();
    if (data && data.type === "lazurio.buddy.layout") layout(data.mode);
  });
  const set = (key, value) => { context[key] = value; send(); };
  document.getElementById("dark").onclick = () => set("theme", "dark");
  document.getElementById("light").onclick = () => set("theme", "light");
  document.getElementById("en").onclick = () => set("lang", "en");
  document.getElementById("cs").onclick = () => set("lang", "cs");
  document.getElementById("page").onclick = () => {
    context.environment = { id: "jana", kind: "personal", name: "Osobní Prostředí" };
    set("page", { path: "/settings/tools" });
    set("app", "settings");
  };
</script>
</body></html>`;

const signInPage = (
  rd: string,
) => `<!doctype html><html lang="cs"><head><meta charset="utf-8"><title>Přihlášení (náhled)</title></head>
<body style="font: 15px system-ui; padding: 32px">
<p>Stand-in for the gateway's sign-in.</p>
<form method="post" action="${origin}/__preview/session?rd=${encodeURIComponent(rd)}"><button>Přihlásit</button></form>
</body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get("host");
    if (host === `launchpad.jana.${domain}`)
      return new Response(hostPage, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (host === `jana.${domain}` && url.pathname === "/oauth2/start")
      return new Response(
        signInPage(url.searchParams.get("rd") ?? `${origin}/signed-in`),
        {
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    if (host !== frameHost) return new Response("not-found", { status: 404 });
    if (url.pathname === "/__preview/session")
      return new Response(null, {
        status: 303,
        headers: {
          location: `${origin}/signed-in`,
          "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
    if (url.pathname === "/__preview/sign-out")
      return new Response("signed out", {
        headers: { "set-cookie": "preview-session=; Path=/; Max-Age=0" },
      });
    // The gateway's admission: a request that is no navigation answers 401
    // without the session.
    if (
      url.pathname.startsWith("/api/") &&
      !(request.headers.get("cookie") ?? "").includes(cookie)
    )
      return new Response("unauthorized", { status: 401 });
    const upstream = await fetch(
      `http://127.0.0.1:${listenPort}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers: request.headers,
        redirect: "manual",
        ...(request.method === "GET" || request.method === "HEAD"
          ? {}
          : { body: await request.arrayBuffer() }),
      },
    );
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  },
});

console.log(
  JSON.stringify({
    host: `http://launchpad.jana.${domain}/`,
    frame: `${origin}/`,
    signOut: `${origin}/__preview/sign-out`,
    port: server.port,
  }),
);

process.on("SIGINT", async () => {
  await frame.stop();
  await adapter.stop();
  await server.stop(true);
  process.exit(0);
});
