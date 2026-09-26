// Runs in its own process with a hostile HTTP_PROXY in the environment: starts
// a hosted Launchpad on the given port and fetches the admitted shell through
// node:http (which ignores proxy variables). Prints one JSON line.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../../src/folder/initialize-folder";
import { executionOs } from "../../src/folder/platform";
import { presetProfile } from "../../src/folder/presets";
import { parseHostedEntry } from "../../src/launchpad/hosted-trust";
import { startLaunchpad } from "../../src/launchpad/server";
import { bindings } from "./machine-bindings";

const listenPort = Number(process.argv[2]);
const parent = await realpath(
  await mkdtemp(join(tmpdir(), "launchpad-entry-proxy-")),
);
const folder = join(parent, "Lazurio");
await mkdir(folder, { mode: 0o700 });
await mkdir(join(folder, "organizations"), { mode: 0o755 });
await mkdir(join(folder, "personalspace"), { mode: 0o700 });
const preset = "hosted-organization-personal";
const entry = parseHostedEntry({
  externalOrigin: "https://launchpad.workspace.example.lazurio.io",
  authCheckUrl: "https://workspace.example.lazurio.io/oauth2/auth",
  authCookieName: "__Secure-lazurio-workspace",
  listenPort,
});
await initializeHandoverFolder(folder, {
  preset,
  machine: { ...bindings.organization, entry },
  profile: presetProfile(preset, executionOs(process.platform)),
});
// Counts what the hostile proxy would have seen: the process's own fetches to
// the proxy go through the environment; the shell must not be one of them.
let proxied = 0;
const app = await startLaunchpad(folder, undefined, undefined, undefined, {
  fetcher: async () => new Response("ok"),
});
try {
  const got = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: listenPort,
          path: "/",
          method: "GET",
          headers: {
            host: "launchpad.workspace.example.lazurio.io",
            cookie: "__Secure-lazurio-workspace=valid",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  // Prove the environment really is hostile for this process: a plain fetch
  // to any http URL is answered by the proxy.
  const probe = await fetch("http://proxy-probe.invalid/").catch(() => null);
  if (probe?.status === 418)
    proxied = 0; // the proxy is reachable; the shell above did not use it
  else proxied = -1; // the environment was not hostile: the run proves nothing
  console.log(
    JSON.stringify({
      status: got.status,
      html: got.body.includes("<html"),
      replaced: got.body.includes("proxy replacement"),
      proxied,
    }),
  );
} finally {
  await app.close();
  await rm(parent, { recursive: true, force: true });
}
