import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeDurableFile } from "../update/durable-file";
import type { ProcessRunner } from "../update/self-check";
import { systemctl } from "../update/service-control";
import { type BrainHttp, healthVersion } from "./admin";
import { readBrainState, writeBrainState } from "./keys";
import {
  type BrainPaths,
  brainRefreshService,
  brainRefreshTimer,
  brainUnit,
} from "./pin";
import { unitOwner, writeBrainUnits } from "./units";

// The interim installer's brain taken over in place (plan LZD-0033 R11a,
// part B), only once the Environment's owner has switched it on
// (`lazurio brain take-over`): nothing moves and nothing restarts. Its
// units in ~/.config/systemd/user become Lazurio's, naming the same
// command in ~/.bun, after a copy of them for the way back; systemd reads
// them again, and the server must still run the version it ran. Lazurio
// then records that release as the brain's, and the Launchpad's key and
// the vault's records of the interim installer's ledger as its own. The
// move to the pin is the next, separate step (`./move.ts`).

export type TakeoverHost = Readonly<{
  paths: BrainPaths;
  service: ProcessRunner;
  http: BrainHttp;
  base: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}>;

export type TakeoverResult =
  | "taken-over"
  | "waits-consent"
  | `refused:${string}`
  | `restored:${string}`
  | `restore-failed:${string}`;

const githubPin = /^github:Lazurio\/gbrain#([0-9a-f]{40})$/;

/** The interim installer's release: the commit Bun installed from the fork
 * and the version that package carries; null where either is not readable. */
export async function interimRelease(
  paths: BrainPaths,
): Promise<Readonly<{ commit: string; version: string }> | null> {
  const global = join(paths.home, ".bun", "install", "global");
  try {
    const manifest = JSON.parse(
      await readFile(join(global, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown> };
    const pinned = githubPin.exec(String(manifest.dependencies?.gbrain ?? ""));
    const pkg = JSON.parse(
      await readFile(
        join(global, "node_modules", "gbrain", "package.json"),
        "utf8",
      ),
    ) as { version?: unknown };
    if (pinned?.[1] === undefined || typeof pkg.version !== "string")
      return null;
    return Object.freeze({ commit: pinned[1], version: pkg.version });
  } catch {
    return null;
  }
}

/** What the interim installer's ledger knows that Lazurio keeps: the
 * repository its vault was connected to and since when `sync.on_commit` and
 * git durability are on. Read once; never written. */
async function interimVault(
  home: string,
): Promise<
  Readonly<{ repo?: string; onCommit?: string; durability?: string }>
> {
  try {
    const ledger = JSON.parse(
      await readFile(
        join(home, ".local", "state", "lazurio", "buddy", "managed.json"),
        "utf8",
      ),
    ) as {
      vault?: {
        repo?: unknown;
        on_commit?: { repo?: unknown; at?: unknown };
        durability?: { repo?: unknown; at?: unknown };
      };
    };
    const vault = ledger.vault;
    const repo = typeof vault?.repo === "string" ? vault.repo : undefined;
    if (repo === undefined) return {};
    const since = (entry: { repo?: unknown; at?: unknown } | undefined) =>
      entry?.repo === repo && typeof entry.at === "string"
        ? entry.at
        : undefined;
    const onCommit = since(vault?.on_commit);
    const durability = since(vault?.durability);
    return {
      repo,
      ...(onCommit === undefined ? {} : { onCommit }),
      ...(durability === undefined ? {} : { durability }),
    };
  } catch {
    return {};
  }
}

const unitNames = [brainUnit, brainRefreshService, brainRefreshTimer];

/** Where the interim installer's units are kept for the way back. */
export const interimUnitsCopy = (paths: BrainPaths) =>
  join(dirname(paths.state), "interim-units");

/** The interim installer's units back from their copy, the ones that were
 * not there before removed; systemd reads them again. True only when every
 * write and the reload succeeded and the server's unit is the interim
 * installer's again. */
async function putInterimBack(
  host: TakeoverHost,
  created: readonly string[],
): Promise<boolean> {
  const { paths } = host;
  const copy = interimUnitsCopy(paths);
  let whole = true;
  for (const name of unitNames) {
    if (created.includes(name)) {
      await rm(join(paths.units, name), { force: true }).catch(() => {
        whole = false;
      });
      continue;
    }
    const text = await readFile(join(copy, name)).catch(() => undefined);
    if (text === undefined) continue;
    await writeDurableFile(paths.units, name, text).catch(() => {
      whole = false;
    });
  }
  const reloaded = await systemctl(
    { run: host.service, env: host.env },
    "daemon-reload",
  );
  return (
    whole &&
    reloaded &&
    (await unitOwner(paths, paths.units, brainUnit)) === "interim"
  );
}

/** A takeover a run left in progress (`taking-over`): the interim
 * installer's units come back first, so nothing bypasses the takeover or
 * loses the release it ran; the takeover is then tried again by setup (the
 * consent stays). Null where there is nothing to resume. */
export async function resumeTakeover(
  host: TakeoverHost,
): Promise<TakeoverResult | null> {
  const state = await readBrainState(host.paths);
  if (state.takeover?.state !== "taking-over") return null;
  const back = await putInterimBack(host, state.takeover.created ?? []);
  const current = await readBrainState(host.paths);
  const { release: _r, created: _c, ...takeover } = current.takeover ?? {};
  await writeBrainState(host.paths, {
    ...current,
    takeover: Object.freeze({
      ...takeover,
      state: back ? "failed-interrupted" : "restore-failed-interrupted",
      at: (host.now ?? (() => new Date()))().toISOString(),
    }),
  });
  return back ? "restored:interrupted" : "restore-failed:interrupted";
}

/** Records the owner's consent; `lazurio brain take-over` calls it. */
export async function consentToTakeover(
  paths: BrainPaths,
  now: Date,
): Promise<void> {
  const state = await readBrainState(paths);
  await writeBrainState(paths, {
    ...state,
    takeover: Object.freeze({
      ...(state.takeover ?? {}),
      consent: now.toISOString(),
    }),
  });
}

export async function takeOverInterim(
  host: TakeoverHost,
): Promise<TakeoverResult> {
  const { paths } = host;
  const now = () => (host.now ?? (() => new Date()))().toISOString();
  const state = await readBrainState(paths);
  if (state.takeover?.consent === undefined) return "waits-consent";
  // A way back that did not complete waits for a person.
  if (state.takeover.state?.startsWith("restore-failed-"))
    return `restore-failed:${state.takeover.state.slice("restore-failed-".length)}`;
  const record = async (
    takeover: `failed-${string}` | `restore-failed-${string}`,
  ) => {
    const current = await readBrainState(paths);
    const { release: _r, created: _c, ...rest } = current.takeover ?? {};
    await writeBrainState(paths, {
      ...current,
      takeover: Object.freeze({ ...rest, state: takeover, at: now() }),
    });
  };
  // What runs must be what the interim installer says it installed.
  const release = await interimRelease(paths);
  if (release === null) return "refused:release-unknown";
  const running = await healthVersion(host.http, host.base);
  if (running === null) return "refused:not-running";
  if (running !== release.version) return "refused:other-version";
  // A copy of every unit of these names that is there, for the way back.
  const copy = interimUnitsCopy(paths);
  const kept: Record<string, Buffer> = {};
  try {
    await mkdir(copy, { recursive: true, mode: 0o700 });
    for (const name of unitNames) {
      const text = await readFile(join(paths.units, name)).catch(
        () => undefined,
      );
      if (text === undefined) continue;
      kept[name] = text;
      await writeDurableFile(copy, name, text);
    }
  } catch {
    return "refused:copy";
  }
  if (kept[brainUnit] === undefined) return "refused:no-unit";
  const command = { run: host.service, env: host.env };
  const created = unitNames.filter((name) => kept[name] === undefined);
  // The journal before the first unit: a run that dies from here on is
  // put back by the next one (`resumeTakeover`).
  try {
    const current = await readBrainState(paths);
    await writeBrainState(paths, {
      ...current,
      takeover: Object.freeze({
        ...current.takeover,
        state: "taking-over",
        at: now(),
        release: Object.freeze({ ...release }),
        created,
      }),
    });
  } catch {
    return "refused:journal";
  }
  const back = async (why: string): Promise<TakeoverResult> => {
    if (await putInterimBack(host, created)) {
      await record(`failed-${why}`);
      return `restored:${why}`;
    }
    await record(`restore-failed-${why}`);
    return `restore-failed:${why}`;
  };
  try {
    await writeBrainUnits(paths, paths.interimCommand, false, {
      takeOver: true,
    });
  } catch {
    return back("units");
  }
  // systemd reads the units again; the running server is not restarted.
  if (!(await systemctl(command, "daemon-reload"))) return back("reload");
  if (
    !(await systemctl(command, "is-active", "--quiet", brainUnit)) ||
    (await healthVersion(host.http, host.base)) !== release.version
  )
    return back("not-running");
  // The timer the interim installer enabled stays enabled under its name.
  if (!(await systemctl(command, "enable", brainUnit, brainRefreshTimer)))
    return back("enable");
  const current = await readBrainState(paths);
  const vault = await interimVault(paths.home);
  const { release: _r, created: _c, ...takeover } = current.takeover ?? {};
  await writeBrainState(paths, {
    ...current,
    takeover: Object.freeze({ ...takeover, state: "done", at: now() }),
    release: Object.freeze({
      commit: release.commit,
      version: release.version,
      command: paths.interimCommand,
      source: "interim" as const,
    }),
    ...(current.vault === undefined && vault.repo !== undefined
      ? { vault: Object.freeze(vault) }
      : {}),
  });
  return "taken-over";
}
