import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserSocketUrl,
  type CdpConnection,
  connectCdp,
} from "../src/browser/people/cdp";
import { sweepCookies } from "../src/browser/people/cookies";
import { browserLaunchFlags } from "../src/browser/units";

// Proof for LazurioPlatform#504 (F39's addendum of 2026-10-18), run by hand on
// macOS or Linux with a Chrome: `bun run scripts/proof-browser-loopback-entry.ts`
// (`CHROME=<path>` picks the binary). Nothing here touches the network: every
// name the proof opens resolves to a stand-in for the gateway's loopback
// entry, a TLS listener on 127.0.0.1 with a throwaway self-signed certificate
// that only this run's Chrome trusts (`--ignore-certificate-errors-spki-list`).
// It shows, against a real Chrome:
// 1. the browser unit's exact `--host-resolver-rules` (`browserLaunchFlags`)
//    sends `https://<module>.<base>/` and the bare `https://<base>/` to the
//    entry's port, with the page's own Host and TLS name;
// 2. a forced proxy needs the Environment's names bypassed, and the bypass
//    composes with the rule;
// 3. DevTools names a failed navigation's loader in `Network.loadingFailed`
//    and in the error page's `Page.frameNavigated`, the pairing the view's hub
//    reads for the hand-off (with the Network domain on, buffering nothing);
// 4. the view's cookie sweep (`sweepCookies`) removes Lazurio sessions set by
//    real responses, keeps a module's own cookie, keeps github.com's sign-in
//    and names its login, and in a public Environment removes it too.
// It does not prove the Machines policy (ERR_BLOCKED_BY_ADMINISTRATOR) or
// the real gateway entry; those are qualified on an Environment.

const base = "try-01.lazurioexampleorganization.lazurio.io";
const seedHosts = ["auth.lazurio.ai", "dashboard.lazurio.ai", "github.com"];

function chromeBinary(): string {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && existsSync(mac)) return mac;
  const found = execFileSync(
    "sh",
    [
      "-c",
      `ls -d ${homedir()}/.agent-browser/browsers/chrome-*/chrome ${homedir()}/.agent-browser/browsers/chrome-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -n 1`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (found === "") throw new Error("No Chrome found; set CHROME");
  return found;
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};

const dir = await mkdtemp(join(tmpdir(), "lazurio-504-proof-"));
const chromes: ReturnType<typeof spawn>[] = [];
try {
  // A throwaway certificate for the Environment's names and the seed hosts.
  const names = [base, `*.${base}`, ...seedHosts];
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${base}`,
      "-addext",
      `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const spki = execFileSync(
    "sh",
    [
      "-c",
      'openssl x509 -in "$1" -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64',
      "sh",
      join(dir, "cert.pem"),
    ],
    { encoding: "utf8" },
  ).trim();

  // The stand-in entry: names the Host and path it was asked for, and sets
  // the cookies each real host would.
  const cookiesFor = (host: string): string[] => {
    if (host === base)
      return [
        `__Secure-lazurio-workspace=s; Domain=${base}; Path=/; Secure; HttpOnly`,
        `__Secure-lazurio-workspace_0=c0; Domain=${base}; Path=/; Secure; HttpOnly`,
        "__Host-lazurio-public-notice=1; Path=/; Secure",
      ];
    if (host === `mission-control.${base}`)
      return ["session=module; Path=/; Secure; HttpOnly"];
    if (host === "auth.lazurio.ai")
      return [
        "KEYCLOAK_SESSION=k; Path=/realms/lazurio/; Secure",
        "lazurio_consent=1; Domain=lazurio.ai; Path=/; Secure",
      ];
    if (host === "dashboard.lazurio.ai")
      return ["__Host-dashboard=d; Path=/; Secure; HttpOnly"];
    if (host === "github.com")
      return [
        "user_session=u; Path=/; Secure; HttpOnly",
        "__Host-user_session_same_site=u; Path=/; Secure; HttpOnly",
        "logged_in=yes; Domain=github.com; Path=/; Secure",
        "dotcom_user=octocat; Domain=github.com; Path=/; Secure",
      ];
    return [];
  };
  const entry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      cert: await readFile(join(dir, "cert.pem"), "utf8"),
      key: await readFile(join(dir, "key.pem"), "utf8"),
    },
    fetch(request) {
      const host = request.headers.get("host") ?? "";
      const headers = new Headers({ "content-type": "text/plain" });
      // Persistent, as the real ones mostly are, so they outlive the seed's
      // Chrome.
      for (const cookie of cookiesFor(host.replace(/:443$/, "")))
        headers.append("set-cookie", `${cookie}; Max-Age=3600`);
      return new Response(
        `entry host=${host} path=${new URL(request.url).pathname}`,
        { headers },
      );
    },
  });
  const local = { port: entry.port ?? 0, base };
  const productFlags = browserLaunchFlags(local);
  const rule = productFlags.find((flag) =>
    flag.startsWith("--host-resolver-rules="),
  );
  if (rule === undefined) throw new Error("No resolver rule");
  console.log(`unit flag: ${rule}`);

  const binary = chromeBinary();
  console.log(
    `chrome: ${execFileSync(binary, ["--version"], { encoding: "utf8" }).trim()}`,
  );
  let nextPort = 9400 + Math.floor(Math.random() * 400);
  async function launch(
    flags: string[],
  ): Promise<{ cdp: CdpConnection; stop: () => Promise<void> }> {
    const port = nextPort++;
    const chrome = spawn(
      binary,
      [
        "--headless=new",
        `--user-data-dir=${join(dir, "profile")}`,
        `--remote-debugging-port=${port}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--ignore-certificate-errors-spki-list=${spki}`,
        ...flags,
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    chromes.push(chrome);
    let url = "";
    for (let attempt = 0; attempt < 150 && url === ""; attempt++)
      try {
        url = await browserSocketUrl(port);
      } catch {
        await Bun.sleep(100);
      }
    if (url === "") throw new Error("Chrome did not answer");
    const cdp = await connectCdp(url);
    return {
      cdp,
      // A clean close, so Chrome writes its cookies to the profile.
      stop: async () => {
        const ended = new Promise((resolve) => chrome.once("exit", resolve));
        await cdp.send("Browser.close").catch(() => chrome.kill());
        await Promise.race([ended, Bun.sleep(5_000)]);
        cdp.close();
        chrome.kill();
      },
    };
  }
  /** Opens `url` in a new tab; the page's text, DevTools' error and the
   * failed-loader pairing. */
  async function visit(cdp: CdpConnection, url: string) {
    const events: { method: string; params: Record<string, unknown> }[] = [];
    cdp.onEvent((event) => events.push(event as never));
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const session = String(sessionId);
    await cdp.send("Page.enable", {}, session);
    await cdp.send(
      "Network.enable",
      { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 },
      session,
    );
    const navigation = await cdp.send("Page.navigate", { url }, session);
    await Bun.sleep(1_000);
    const text = await cdp.send(
      "Runtime.evaluate",
      {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      },
      session,
    );
    await cdp.send("Target.closeTarget", { targetId });
    return {
      text: String((text.result as { value?: unknown })?.value ?? ""),
      error: (navigation.errorText as string | undefined) ?? null,
      events,
    };
  }

  // Seed: real responses set the Lazurio and GitHub cookies (the proof maps
  // the seed hosts to the stand-in too, only for this step).
  {
    const seed = await launch([
      `${rule},${seedHosts.map((host) => `MAP ${host} 127.0.0.1:${local.port}`).join(",")}`,
    ]);
    for (const url of [
      `https://${base}/oauth2/start`,
      `https://mission-control.${base}/`,
      "https://auth.lazurio.ai/realms/lazurio/account",
      "https://dashboard.lazurio.ai/",
      "https://github.com/",
    ]) {
      const seen = await visit(seed.cdp, url);
      console.log(`seed ${url}: ${JSON.stringify(seen.text || seen.error)}`);
    }
    await seed.stop();
  }

  // 1. The exact unit flag.
  const product = await launch([rule]);
  for (const [url, host, path] of [
    [`https://mission-control.${base}/x`, `mission-control.${base}`, "/x"],
    [`https://${base}/oauth2/start`, base, "/oauth2/start"],
  ] as const) {
    const seen = await visit(product.cdp, url);
    record(
      `rule sends ${host} to 127.0.0.1:${local.port}`,
      seen.text === `entry host=${host} path=${path}`,
      JSON.stringify(seen.text || seen.error),
    );
  }

  // 3. The failed-loader pairing, on a name the rule does not cover.
  {
    const seen = await visit(product.cdp, "https://unresolvable.invalid/");
    const failed = seen.events.find(
      (event) =>
        event.method === "Network.loadingFailed" &&
        event.params.type === "Document",
    );
    const committed = seen.events.find(
      (event) =>
        event.method === "Page.frameNavigated" &&
        (event.params.frame as { unreachableUrl?: string } | undefined)
          ?.unreachableUrl === "https://unresolvable.invalid/",
    );
    const loader = (committed?.params.frame as { loaderId?: string })?.loaderId;
    record(
      "a failed navigation's loader is named by both events",
      failed !== undefined &&
        loader !== undefined &&
        failed.params.requestId === loader,
      `${String(failed?.params.errorText)} requestId=${String(failed?.params.requestId)} loaderId=${String(loader)}`,
    );
  }

  // 4. The cookie sweep, as the view runs it.
  {
    const listed = async () =>
      (
        (await product.cdp.send("Storage.getCookies", {})).cookies as {
          name: string;
          domain: string;
        }[]
      )
        .map((cookie) => `${cookie.name}@${cookie.domain}`)
        .sort();
    const before = await listed();
    console.log(`cookies before: ${before.join(" ")}`);
    const work = await sweepCookies(product.cdp, false);
    const after = await listed();
    console.log(`after a work Environment's sweep: ${after.join(" ")}`);
    record(
      "a work Environment's sweep removes Lazurio sessions, keeps module and GitHub cookies",
      work.remaining === 0 &&
        work.github === "octocat" &&
        !after.some(
          (cookie) =>
            cookie.includes("lazurio.ai") ||
            cookie.startsWith("__Secure-lazurio-workspace") ||
            cookie.startsWith("__Host-lazurio-public-notice"),
        ) &&
        after.includes(`session@mission-control.${base}`) &&
        after.includes("user_session@github.com"),
      JSON.stringify(work),
    );
    const visitors = await sweepCookies(product.cdp, true);
    const left = await listed();
    console.log(`after a public Environment's sweep: ${left.join(" ")}`);
    record(
      "a public Environment's sweep also removes github.com's session",
      visitors.remaining === 0 &&
        visitors.github === null &&
        !left.some((cookie) => cookie.endsWith("github.com")) &&
        left.includes(`session@mission-control.${base}`),
      JSON.stringify(visitors),
    );
  }
  await product.stop();

  // 2. A forced proxy (a closed port): without a bypass it takes the
  // Environment's names; with one the rule still applies.
  const closed = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const proxyPort = closed.port;
  closed.stop(true);
  {
    const proxied = await launch([
      rule,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
    ]);
    const seen = await visit(proxied.cdp, `https://mission-control.${base}/`);
    record(
      "a forced proxy without a bypass takes the Environment's names",
      seen.text.startsWith("entry ") === false && seen.error !== null,
      String(seen.error),
    );
    await proxied.stop();
  }
  {
    const bypassed = await launch([
      rule,
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      `--proxy-bypass-list=${base};*.${base}`,
    ]);
    const seen = await visit(bypassed.cdp, `https://mission-control.${base}/`);
    record(
      "with the Environment's names bypassed the rule applies under a proxy",
      seen.text === `entry host=mission-control.${base} path=/`,
      JSON.stringify(seen.text || seen.error),
    );
    await bypassed.stop();
  }
  entry.stop(true);
} finally {
  for (const chrome of chromes) chrome.kill();
  await rm(dir, { recursive: true, force: true });
}
const failed = results.filter((result) => !result.ok);
console.log(
  failed.length === 0
    ? `all ${results.length} checks passed`
    : `${failed.length} of ${results.length} checks failed`,
);
process.exit(failed.length === 0 ? 0 : 1);
