/** The prototype's live check on the Environment's screen, end to end:
 *
 * 1. A Chrome for Testing of its own (temporary profile, own DevTools port,
 *    no Lazurio extension, so nothing intercepts) opens the test page on the
 *    screen `:1` and a file input's own GTK "Open File" window.
 * 2. The desktop service starts; a headless Chrome off the screen opens the
 *    desktop page from that tab and takes the screen.
 * 3. While the person holds it, the `computer` gate refuses `click` before
 *    the driver (sent without a pid, so a driver would refuse it too) and
 *    lets `get_screen_size` through.
 * 4. Escape typed into the page closes the dialog; the test page hears
 *    `cancel`.
 * 5. Releasing puts the stacking back: the other windows of the screen keep
 *    their order, position and size.
 *
 * Input reaches the screen only in step 4 and only after the pointer was seen
 * still for two seconds. Every process it started is stopped at the end.
 *
 *   bun check.ts [--shots <dir>]
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Cdp, connectCdp } from "./cdp";
import { pointer, topLevels } from "./windows";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { shots: { type: "string" } },
});
const here = import.meta.dir;
const display = ":1";
const ports = { test: 9533, client: 9534, desktop: 4881 };
const origin = `http://127.0.0.1:${ports.desktop}`;
const chrome = (
  await Array.fromAsync(
    new Bun.Glob(".agent-browser/browsers/chrome-*/chrome").scan({
      cwd: homedir(),
      absolute: true,
    }),
  )
)
  .sort()
  .at(-1);
if (chrome === undefined) throw new Error("no Chrome for Testing");
const work = join(tmpdir(), `desktop-check-${process.pid}`);
const state = join(work, "state");
await mkdir(state, { recursive: true, mode: 0o700 });

const children: Bun.Subprocess[] = [];
const results: string[] = [];
const ok = (what: string, value: boolean) => {
  results.push(`${value ? "ok  " : "FAIL"} ${what}`);
  if (!value) process.exitCode = 1;
};

async function waitFor<T>(what: string, probe: () => Promise<T | null>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > until) throw new Error(`timed out: ${what}`);
    await Bun.sleep(200);
  }
}

async function attach(port: number, match: (url: string) => boolean): Promise<{ cdp: Cdp; s: string }> {
  const cdp = await connectCdp(port);
  const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page" && match(t.url));
  if (page === undefined) throw new Error(`no page on ${port}`);
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  return { cdp, s: sessionId };
}

async function evaluate<T>(at: { cdp: Cdp; s: string }, expression: string): Promise<T> {
  const r = await at.cdp.send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, at.s);
  return r.result.value;
}

async function shot(at: { cdp: Cdp; s: string }, name: string): Promise<void> {
  if (values.shots === undefined) return;
  const { data } = await at.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, at.s);
  await writeFile(join(values.shots, name), Buffer.from(data, "base64"));
}

try {
  // 1. The test Chrome and its native window.
  children.push(
    Bun.spawn([chrome, `--user-data-dir=${join(work, "test-profile")}`, `--remote-debugging-port=${ports.test}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-position=700,120", "--window-size=1000,760", "--class=lazurio-desktop-check", `file://${join(here, "test-page.html")}`], { env: { ...process.env, DISPLAY: display }, stdout: "ignore", stderr: "ignore" }),
  );
  const test = await waitFor("test Chrome", () => attach(ports.test, (u) => u.startsWith("file:")));
  const tab = await waitFor("test tab id", async () => {
    const { targetInfos } = await test.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    return targetInfos.find((t) => t.type === "page" && t.url.startsWith("file:"))?.targetId ?? null;
  });
  const before = await topLevels(display);
  const [x, y] = await evaluate<[number, number]>(test, `(()=>{const e=document.getElementById("file");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await test.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, test.s);
  const dialog = await waitFor("GTK dialog", async () => (await topLevels(display)).find((w) => w.name === "Open File" && w.className === "lazurio-desktop-check") ?? null);
  ok("the file input opened a native window on the screen", true);

  // 2. The desktop service and the person's page.
  children.push(
    Bun.spawn(["bun", join(here, "serve.ts"), "--port", String(ports.desktop), "--origin", origin, "--cdp", String(ports.test)], { env: { ...process.env, LAZURIO_DESKTOP_STATE: join(state, "turn"), LAZURIO_DESKTOP_RUN: state }, stdout: "ignore", stderr: "ignore" }),
  );
  await waitFor("desktop service", async () => ((await fetch(`${origin}/api/state`)).ok ? true : null));
  const escapes = (await (await fetch(`${origin}/api/escapes`)).json()) as { escapes: { id: string; tab: string | null; kind: string }[] };
  ok("the service found the dialog and its tab", escapes.escapes.some((e) => e.id === dialog.id && e.tab === tab && e.kind === "dialog"));
  children.push(Bun.spawn([chrome, "--headless=new", `--user-data-dir=${join(work, "client-profile")}`, `--remote-debugging-port=${ports.client}`, "--no-first-run", "--window-size=1440,900", "about:blank"], { stdout: "ignore", stderr: "ignore" }));
  const client = await waitFor("client Chrome", () => attach(ports.client, () => true));
  // The pointer must be still before the person takes the screen.
  const p0 = await pointer(display);
  await Bun.sleep(2_000);
  const p1 = await pointer(display);
  if (p0.x !== p1.x || p0.y !== p1.y) throw new Error("the pointer moved: someone is on the screen; stopping");
  await client.cdp.send("Page.navigate", { url: `${origin}/?tab=${tab}&take=1` }, client.s);
  const turn = await waitFor("the screen taken", async () => {
    const text = await evaluate<string>(client, `document.getElementById("turn").textContent`);
    return text.startsWith("Ovládáte") ? text : null;
  });
  ok(`the page took the screen ("${turn}")`, true);
  await shot(client, "check-1-taken.png");

  // 3. The computer gate while the person holds the screen.
  const gate = Bun.spawn(["bun", join(here, "computer-gate.ts")], { env: { ...process.env, LAZURIO_DESKTOP_STATE: join(state, "turn"), AGENT_BROWSER_SESSION: "desktop-check" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  for (const line of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "desktop-check", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_screen_size", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "click", arguments: { x: 5, y: 5 } } },
  ])
    gate.stdin.write(`${JSON.stringify(line)}\n`);
  await gate.stdin.flush();
  await Bun.sleep(3_000);
  gate.stdin.end();
  const answers = (await new Response(gate.stdout).text()).trim().split("\n").map((l) => JSON.parse(l) as { id?: number; result?: { isError?: boolean; content?: { text?: string }[]; structuredContent?: unknown } });
  const click = answers.find((a) => a.id === 3);
  const size = answers.find((a) => a.id === 2);
  ok("computer: click refused before the driver while the person holds", click?.result?.isError === true && (click.result.content?.[0]?.text ?? "").startsWith("A person holds"));
  ok("computer: get_screen_size reached the driver", JSON.stringify(size?.result?.structuredContent ?? null).includes("1920"));

  // 4. Escape typed into the desktop page closes the dialog.
  await evaluate(client, `document.querySelector("#screen canvas").focus()`);
  for (const type of ["keyDown", "keyUp"]) await client.cdp.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, client.s);
  await waitFor("dialog gone", async () => ((await topLevels(display)).some((w) => w.id === dialog.id) ? null : true));
  const log = await evaluate<string>(test, `document.getElementById("log").textContent`);
  ok("Escape from the desktop closed the dialog and the page heard cancel", log.includes("cancelled"));
  await shot(client, "check-2-closed.png");

  // 5. Release: the other windows are where they were.
  await evaluate(client, `document.getElementById("release").click()`);
  await waitFor("released", async () => ((await evaluate<string>(client, `document.getElementById("turn").textContent`)).startsWith("Sledujete") ? true : null));
  const after = await topLevels(display);
  const others = (list: typeof before) => list.filter((w) => !w.className.startsWith("lazurio-desktop-check"));
  const ids = new Set(others(after).map((w) => w.id));
  const common = others(before).filter((w) => ids.has(w.id));
  const afterCommon = others(after).filter((w) => common.some((c) => c.id === w.id));
  ok(`the other ${common.length} windows keep their stacking`, common.map((w) => w.id).join() === afterCommon.map((w) => w.id).join());
  ok("the other windows keep their position and size", common.every((w) => {
    const now = after.find((a) => a.id === w.id);
    return now !== undefined && now.x === w.x && now.y === w.y && now.width === w.width && now.height === w.height;
  }));
  client.cdp.close();
  test.cdp.close();
} catch (error) {
  results.push(`FAIL ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) child.kill();
  await Bun.sleep(1_000);
  await rm(work, { recursive: true, force: true });
  console.log(results.join("\n"));
}
