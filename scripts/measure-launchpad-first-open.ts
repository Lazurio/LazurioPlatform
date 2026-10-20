// What a hosted Launchpad's first open costs on its own side (root decision
// 0195, plan DEV-6656), measured against a generated fixture Folder, never a
// live one, with this computer's own tools on PATH (their sign-in probes may
// ask their providers, as on a real first open):
//
//   bun scripts/measure-launchpad-first-open.ts [--root <checkout>]
//     [--organizations 17] [--modules 9] [--page-ms 1000] [--stale]
//     [--folder <Folder>]
//
// `--root` names the checkout whose `src/` is measured (by default this one),
// so the same script measures another revision for a before/after. It prints
// one JSON object: the page with its boot document (first and repeated), the
// tools' status cold (no reading yet), kept (within the minute) and on a
// first open (the page document, then the tools asked `--page-ms` later, as
// the page does once loaded), `/api/catalog` first and repeated, and with
// `--stale` the tools a minute and a moment after a reading (the answer at
// once and the one after it). With `--folder` it also times reading that
// Folder's catalog directly, read-only: every reading anew, and as the
// Launchpad keeps it. Times are milliseconds over loopback, the median of
// the repeats.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    organizations: { type: "string", default: "17" },
    modules: { type: "string", default: "9" },
    "page-ms": { type: "string", default: "1000" },
    stale: { type: "boolean", default: false },
    folder: { type: "string" },
  },
});
const root = resolve(values.root ?? join(import.meta.dir, ".."));
const from = (path: string) => import(join(root, path));

const { startLaunchpad } = await from("src/launchpad/server.ts");
const { initializeHandoverFolder } = await from(
  "src/folder/initialize-folder.ts",
);
const { executionOs } = await from("src/folder/platform.ts");
const { presetProfile } = await from("src/folder/presets.ts");
const { toolsEnvironmentOf } = await from("src/tools/overview.ts");
const { readFolderCatalog } = await from("src/organizations/catalog.ts");
const { writeOrganization } = await from("tests/fixtures/catalog-folder.ts");
const { organizationWithEntry } = await from(
  "tests/fixtures/machine-bindings.ts",
);
const { freePort } = await from("tests/fixtures/ports.ts");

const median = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 10) / 10;
};
const timed = async <T>(work: () => Promise<T>) => {
  const started = performance.now();
  const value = await work();
  return { ms: Math.round((performance.now() - started) * 10) / 10, value };
};

const result: Record<string, unknown> = { root };

if (values.folder !== undefined) {
  const folder = resolve(values.folder);
  const anew: number[] = [];
  let counted = { organizations: 0, modules: 0 };
  for (let round = 0; round < 7; round++) {
    const { ms, value } = await timed(
      (): Promise<{ organizations: { modules: unknown[] }[] }> =>
        readFolderCatalog(folder),
    );
    anew.push(ms);
    counted = {
      organizations: value.organizations.length,
      modules: value.organizations.reduce(
        (sum: number, entry: { modules: unknown[] }) =>
          sum + entry.modules.length,
        0,
      ),
    };
  }
  const folderResult: Record<string, unknown> = {
    ...counted,
    catalogAnewMs: { first: anew[0], median: median(anew.slice(1)) },
  };
  const reading = await from("src/launchpad/catalog-reading.ts").catch(
    () => null,
  );
  if (reading !== null) {
    const { unverifiedPersonalspace } = await from(
      "src/organizations/personalspace.ts",
    );
    const kept = reading.createCatalogReading(folder, {
      holder: unverifiedPersonalspace,
    });
    await kept.read();
    await kept.read();
    await Bun.sleep(200);
    await kept.read();
    const times: number[] = [];
    for (let round = 0; round < 7; round++)
      times.push((await timed(() => kept.read())).ms);
    kept.close();
    folderResult.catalogKeptMs = median(times);
  }
  result.folder = folderResult;
}

// A hosted work Environment in Czech with the generated Organizations.
async function launchpad() {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "measure-first-open-")),
  );
  const folder = join(parent, "Lazurio");
  await mkdir(folder, { mode: 0o700 });
  await mkdir(join(folder, "organizations"), { mode: 0o755 });
  const organizations = Number(values.organizations);
  const modules = Number(values.modules);
  for (let index = 0; index < organizations; index++)
    await writeOrganization(folder, `org${index}_GEN3`, {
      slug: `org${index}`,
      state: "current",
      modules: Array.from({ length: modules }, (_, module) => ({
        id: `module${module}`,
      })),
    });
  const preset = "hosted-organization-personal";
  const machine = organizationWithEntry(freePort());
  const entry = machine.entry;
  await initializeHandoverFolder(folder, {
    preset,
    machine,
    profile: presetProfile(preset, executionOs(process.platform), {
      locale: "cs",
    }),
  });
  const started = performance.now();
  const app = await startLaunchpad(
    folder,
    undefined,
    undefined,
    undefined,
    {
      fetcher: async (_url: string, init: RequestInit) =>
        new Headers(init.headers).get("cookie") ===
        "__Secure-lazurio-workspace=valid"
          ? new Response("ok")
          : new Response("no", { status: 401 }),
    },
    toolsEnvironmentOf(process.env, process.platform),
  );
  const startMs = Math.round((performance.now() - started) * 10) / 10;
  const base = `http://127.0.0.1:${entry.listenPort}`;
  const valid = {
    host: new URL(entry.externalOrigin).host,
    cookie: "__Secure-lazurio-workspace=valid",
  };
  const page = async () => {
    const answer = await fetch(`${base}/`, { headers: valid });
    const html = await answer.text();
    return html.includes('id="lazurio-boot"');
  };
  const post = async (path: string, body: unknown) => {
    const answer = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        ...valid,
        origin: entry.externalOrigin,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: answer.status, value: await answer.json() };
  };
  // The page's own first reading: an older revision refuses `allowStale`.
  const tools = async (early: boolean) => {
    const asked = await post("/api/tools/status", {
      signIn: true,
      ...(early ? { allowStale: true } : {}),
    });
    if (asked.status === 400 && early)
      return post("/api/tools/status", { signIn: true });
    return asked;
  };
  return {
    startMs,
    page,
    post,
    tools,
    async close() {
      await app.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

// One Launchpad: the tools before any page, kept, the page, the catalog.
{
  const lp = await launchpad();
  try {
    result.startMs = lp.startMs;
    const cold = await timed(() => lp.tools(false));
    const kept: number[] = [];
    for (let round = 0; round < 5; round++)
      kept.push((await timed(() => lp.tools(true))).ms);
    const firstPage = await timed(() => lp.page());
    const pages: number[] = [];
    let carried = firstPage.value;
    for (let round = 0; round < 5; round++) {
      const { ms, value } = await timed(() => lp.page());
      pages.push(ms);
      carried &&= value;
    }
    const firstCatalog = await timed(() => lp.post("/api/catalog", {}));
    const catalogs: number[] = [];
    for (let round = 0; round < 5; round++)
      catalogs.push((await timed(() => lp.post("/api/catalog", {}))).ms);
    result.toolsStatusMs = {
      cold: cold.ms,
      kept: median(kept),
    };
    result.pageMs = {
      first: firstPage.ms,
      repeated: median(pages),
      bootCarried: carried,
    };
    result.catalogMs = {
      first: firstCatalog.ms,
      repeated: median(catalogs),
    };
    if (values.stale) {
      await Bun.sleep(61_000);
      const early = await timed(() => lp.tools(true));
      const after = await timed(() => lp.tools(false));
      result.toolsAfterTheMinuteMs = {
        firstAnswer: early.ms,
        stale: early.value.value?.stale === true,
        next: after.ms,
      };
    }
  } finally {
    await lp.close();
  }
}

// A first open on a fresh Launchpad: the page, then its tools once loaded.
{
  const lp = await launchpad();
  try {
    const opened = performance.now();
    await lp.page();
    await Bun.sleep(Number(values["page-ms"]));
    const asked = await timed(() => lp.tools(true));
    result.firstOpen = {
      pageMs: Number(values["page-ms"]),
      toolsAnswerMs: asked.ms,
      toolsAfterDocumentMs: Math.round((performance.now() - opened) * 10) / 10,
      stale: asked.value.value?.stale === true,
    };
  } finally {
    await lp.close();
  }
}

console.log(JSON.stringify(result, null, 2));
