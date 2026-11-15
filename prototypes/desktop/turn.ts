/** Whose turn the screen is: a person in the desktop view, or the agents'
 * Computer Use. One owner-only directory holds it, so the desktop service
 * and every agent's `computer` gate read the same truth without talking to
 * each other, and either works when the other is not running.
 *
 * - `person.json`: a person holds the screen until `until` (a lease the
 *   desktop page renews while it is open and used). Written only by the
 *   desktop service. An expired lease is no lease.
 * - `agents/<name>.json`: the last time an agent's gate let an input tool
 *   through. Written only by that gate. Read by the desktop page to say who
 *   was on the screen and when. */

import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const turnDirectory =
  process.env.LAZURIO_DESKTOP_STATE ??
  join(homedir(), ".local/state/lazurio-desktop-prototype/turn");

export type PersonTurn = {
  holder: "person";
  /** Who, as the gateway names them; `person` without a gateway. */
  who: string;
  since: number;
  until: number;
};

export type AgentActivity = {
  agent: string;
  tool: string;
  at: number;
};

/** How long an agent's last input counts as "on the screen now". */
export const agentActiveMs = 20_000;
/** A person's lease; the page renews it while the person uses the screen. */
export const personLeaseMs = 120_000;

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function readPerson(
  now = Date.now(),
  directory = turnDirectory,
): Promise<PersonTurn | null> {
  try {
    const value = JSON.parse(
      await readFile(join(directory, "person.json"), "utf8"),
    ) as PersonTurn;
    if (value.holder !== "person" || typeof value.until !== "number")
      return null;
    return value.until > now ? value : null;
  } catch {
    return null;
  }
}

export async function holdForPerson(
  who: string,
  now = Date.now(),
  directory = turnDirectory,
): Promise<PersonTurn> {
  const current = await readPerson(now, directory);
  const turn: PersonTurn = {
    holder: "person",
    who,
    since: current?.who === who ? current.since : now,
    until: now + personLeaseMs,
  };
  await atomicWrite(join(directory, "person.json"), turn);
  return turn;
}

export async function releasePerson(directory = turnDirectory): Promise<void> {
  await rm(join(directory, "person.json"), { force: true });
}

function safeName(agent: string): string {
  return agent.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "agent";
}

export async function noteAgent(
  agent: string,
  tool: string,
  now = Date.now(),
  directory = turnDirectory,
): Promise<void> {
  await atomicWrite(join(directory, "agents", `${safeName(agent)}.json`), {
    agent,
    tool,
    at: now,
  } satisfies AgentActivity);
}

/** Agents whose last input is recent, newest first. */
export async function activeAgents(
  now = Date.now(),
  directory = turnDirectory,
): Promise<AgentActivity[]> {
  let names: string[];
  try {
    names = await readdir(join(directory, "agents"));
  } catch {
    return [];
  }
  const out: AgentActivity[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(
        await readFile(join(directory, "agents", name), "utf8"),
      ) as AgentActivity;
      if (now - value.at < agentActiveMs) out.push(value);
    } catch {
      // A file being replaced is read on the next poll.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
