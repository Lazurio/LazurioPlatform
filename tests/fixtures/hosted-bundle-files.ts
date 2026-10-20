// Compiled into an executable by its test (#532), the way a release is built:
// starts a hosted Launchpad on the given port behind a gateway that admits
// every request with a cookie, fetches the page and every script and style
// file it names through the gateway's path, and prints one JSON line with
// what the browser was told to keep, beside every file the compiled bundle
// lists and those of them taken as content-hashed.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeHandoverFolder } from "../../src/folder/initialize-folder";
import { executionOs } from "../../src/folder/platform";
import { presetProfile } from "../../src/folder/presets";
import index from "../../src/launchpad/index.html";
import newTabPage from "../../src/launchpad/new-tab.html";
import { bundledFilePaths } from "../../src/launchpad/page";
import { startLaunchpad } from "../../src/launchpad/server";
import { organizationWithEntry } from "./machine-bindings";

const listenPort = Number(process.argv[2]);
const parent = await realpath(
  await mkdtemp(join(tmpdir(), "launchpad-bundle-files-")),
);
const folder = join(parent, "Lazurio");
await mkdir(folder, { mode: 0o700 });
await mkdir(join(folder, "organizations"), { mode: 0o755 });
await mkdir(join(folder, "personalspace"), { mode: 0o700 });
const preset = "hosted-organization-personal";
await initializeHandoverFolder(folder, {
  preset,
  machine: organizationWithEntry(listenPort),
  profile: presetProfile(preset, executionOs(process.platform)),
});
const app = await startLaunchpad(folder, undefined, undefined, undefined, {
  fetcher: async () => new Response("ok"),
});
const base = `http://127.0.0.1:${listenPort}`;
const admitted = {
  host: "launchpad.workspace.example.lazurio.io",
  cookie: "__Secure-lazurio-workspace=valid",
};
const caching = (answer: Response) => ({
  status: answer.status,
  cacheControl: answer.headers.get("cache-control"),
  etag: answer.headers.get("etag"),
});
try {
  const page = await fetch(`${base}/`, { headers: admitted });
  const html = await page.text();
  const named = [
    ...new Set(
      [...html.matchAll(/(?:src|href)="(\/[^"/]+\.(?:js|css))"/g)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
  const files = [];
  for (const path of named) {
    const answer = await fetch(`${base}${path}`, { headers: admitted });
    await answer.arrayBuffer();
    const etag = answer.headers.get("etag");
    const again =
      etag === null
        ? null
        : await fetch(`${base}${path}`, {
            headers: { ...admitted, "if-none-match": etag },
          });
    await again?.arrayBuffer();
    files.push({
      path,
      ...caching(answer),
      revalidated: again === null ? null : caching(again),
    });
  }
  const missing = await fetch(`${base}/chunk-00000000.js`, {
    headers: admitted,
  });
  await missing.arrayBuffer();
  const listed = [index, newTabPage].flatMap((bundle) => {
    const root = bundle.index.slice(
      0,
      Math.max(bundle.index.lastIndexOf("/"), bundle.index.lastIndexOf("\\")) +
        1,
    );
    return (bundle.files ?? [])
      .filter((file) => file.loader !== "html")
      .map((file) => `/${file.path.slice(root.length)}`);
  });
  console.log(
    JSON.stringify({
      page: caching(page),
      files,
      missing: caching(missing),
      listed: [...new Set(listed)].sort(),
      hashed: [...bundledFilePaths([index, newTabPage])].sort(),
    }),
  );
} finally {
  await app.close();
  await rm(parent, { recursive: true, force: true });
}
