import { rm } from "node:fs/promises";
import { layout } from "../update/layout";

// The installed service's health question (docs/update.md "Activation"): which
// version is running, or that it runs in Recovery mode. A Unix socket under
// the install base, so only this user can ask and the updater needs no port or
// session token to find it. In normal mode it states the version and nothing
// else; in Recovery mode it answers 503 with the check, which every updater,
// old or new, reads as "not healthy".
export type HealthAnswer =
  | Readonly<{ version: string }>
  | Readonly<{ mode: "recovery"; check: string; reason: string }>;

async function answers(socket: string): Promise<boolean> {
  try {
    const response = await fetch("http://launchpad/health", {
      unix: socket,
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function serveHealthSocket(base: string, answer: HealthAnswer) {
  const path = layout(base).healthSocket;
  // A socket file outlives a killed Launchpad; one that still answers, in
  // either mode, is a live Launchpad of this base, and there is only ever one.
  if (await answers(path))
    throw new Error("Another Launchpad serves this install base");
  await rm(path, { force: true });
  const status = "version" in answer ? 200 : 503;
  return Bun.serve({
    unix: path,
    fetch: (request) =>
      new URL(request.url).pathname === "/health" && request.method === "GET"
        ? Response.json(answer, { status })
        : new Response(null, { status: 404 }),
  });
}
