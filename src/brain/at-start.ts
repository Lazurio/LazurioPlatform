import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  CustomServerInput,
  CustomServerSettings,
} from "../integrations/custom-server";
import type { ToolRunner } from "../tools/status";
import { writeDurableFile } from "../update/durable-file";
import type { BrainPaths } from "./pin";

// The person's brain at the Launchpad's start (plan LZD-0033 R11a, step 4),
// where it sets Executor up (decision F44): once Executor's own setup has
// ended, the Launchpad runs `lazurio brain setup --json` as a child process
// (the admin token is read by that process alone, never by the Launchpad's)
// and reads only its closed labels. Where Lazurio's server answers, Executor
// gets the custom remote server Brain with the Executor key's handover, so
// every agent of the Environment reads and writes the brain over MCP
// without an instruction. Never awaited by the start and never a reason for
// it to fail; its journal line holds closed labels only.

/** The closed labels `lazurio brain setup --json` prints. */
export type BrainSetupLabels = Readonly<{
  server: string;
  move?: string;
  takeover?: string;
  vault?: string;
  meaning?: string;
}>;

const setupTimeoutMs = 45 * 60_000;

/** Runs `lazurio brain setup --json` as a child process of `executable`;
 * null when it did not finish or printed no labels. */
export async function runBrainSetup(
  input: Readonly<{
    executable: string;
    run: ToolRunner;
    env: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<BrainSetupLabels | null> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env))
    if (value !== undefined) env[name] = value;
  const result = await input
    .run([input.executable, "brain", "setup", "--json"], setupTimeoutMs, env)
    .catch(() => "timeout" as const);
  if (result === "timeout") return null;
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (typeof value.server !== "string") return null;
    const label = (key: string) =>
      typeof value[key] === "string" ? { [key]: value[key] as string } : {};
    return Object.freeze({
      server: value.server,
      ...label("move"),
      ...label("takeover"),
      ...label("vault"),
      ...label("meaning"),
    });
  } catch {
    return null;
  }
}

/** Where Lazurio's server answers after setup: Executor may reach it. */
export const brainAnswers = (labels: BrainSetupLabels | null) =>
  labels !== null &&
  ["installed", "started", "running", "moved", "held", "waits-move"].includes(
    labels.server,
  );

/** What the Launchpad's custom servers of Executor offer (Integrations →
 * Vlastní, decision F42): the one path a custom server is added or saved. */
export type BrainServerSessions = Readonly<{
  addCustom(
    server: CustomServerInput,
  ): Promise<Readonly<{ kind: string; app?: string; reason?: string }>>;
  customSettings(
    id: string,
  ): Promise<CustomServerSettings | Readonly<{ kind: "blocked" }>>;
  updateCustom(
    id: string,
    server: CustomServerInput,
  ): Promise<Readonly<{ kind: string }>>;
}>;

export type BrainServerResult =
  | "added"
  | "kept"
  | "updated"
  | "no-key"
  | "name-taken"
  | "failed";

/** Lazurio's record of the server it added: its id in Executor and which
 * key it carries, as a short digest of the key, never the key. */
const recordPath = (paths: BrainPaths) =>
  join(dirname(paths.state), "executor.json");

const digestOf = (token: string) =>
  createHash("sha256").update(token).digest("hex").slice(0, 16);

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Executor's custom remote server Brain with the Executor key (read,
 * write): added once, kept while it carries the key handed over, saved
 * again with the new key after setup minted one. A server of that name
 * Lazurio did not add is left alone (`name-taken`). */
export async function convergeBrainServer(
  paths: BrainPaths,
  sessions: BrainServerSessions,
): Promise<BrainServerResult> {
  const handover = await readJson(paths.executorKey);
  const url = handover?.url;
  const token = handover?.token;
  if (
    typeof url !== "string" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) ||
    typeof token !== "string" ||
    token.length < 16
  )
    return "no-key";
  const server: CustomServerInput = Object.freeze({
    type: "http",
    name: "Brain",
    url: `${url}/mcp`,
    bearer: Object.freeze({ value: token }),
    headers: Object.freeze([]),
  });
  const digest = digestOf(token);
  const record = await readJson(recordPath(paths));
  const write = async (slug: string) => {
    await mkdir(dirname(recordPath(paths)), { recursive: true, mode: 0o700 });
    await writeDurableFile(
      dirname(recordPath(paths)),
      basename(recordPath(paths)),
      Buffer.from(`${JSON.stringify({ slug, key: digest })}\n`),
    );
  };
  const slug = typeof record?.slug === "string" ? record.slug : undefined;
  if (slug !== undefined) {
    const settings = await sessions.customSettings(slug);
    if (settings.kind === "custom-server" && settings.type === "http") {
      if (record?.key === digest && settings.url === server.url) return "kept";
      const saved = await sessions.updateCustom(slug, server);
      if (saved.kind !== "saved" && saved.kind !== "connected") return "failed";
      await write(slug);
      return "updated";
    }
  }
  const added = await sessions.addCustom(server);
  if (added.kind === "blocked" && added.reason === "name-taken")
    return "name-taken";
  if (added.kind !== "connected" || typeof added.app !== "string")
    return "failed";
  await write(added.app);
  return "added";
}
