import { logLines } from "./redact";

/** An unsupervised Launchpad started once (J1 and J4 on macOS): its first
 * stdout line without the session URL, the page's HTTP status, and its exit
 * on SIGTERM. The session URL carries a bearer token and is never printed;
 * the process's stderr is captured and printed only redacted
 * (scripts/qualify/redact.ts), also when the start fails or exits early. */
export async function launchpadOnce(
  input: Readonly<{
    executable: string;
    folder: string;
    env: Record<string, string | undefined>;
    print?: (line: string) => void;
    timeoutMs?: number;
  }>,
): Promise<{
  started: Record<string, unknown>;
  status: number;
  exit: number;
}> {
  const print = input.print ?? ((line: string) => console.log(line));
  const child = Bun.spawn(
    [input.executable, "launchpad", "--folder", input.folder],
    { env: input.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    let text = "";
    const deadline = Date.now() + (input.timeoutMs ?? 60_000);
    while (!text.includes("\n") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    let first: { url?: unknown } & Record<string, unknown>;
    try {
      first = JSON.parse(text.split("\n")[0] ?? "");
    } catch {
      throw new Error("The Launchpad printed no start line");
    }
    const { url, ...started } = first;
    if (typeof url !== "string")
      throw new Error("The Launchpad's start line has no URL");
    const page = await fetch(new URL("/", url), {
      signal: AbortSignal.timeout(10_000),
    });
    await page.text();
    child.kill("SIGTERM");
    return { started, status: page.status, exit: await child.exited };
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await child.exited;
    for (const line of logLines(await stderr, 60)) print(`  ! ${line}`);
  }
}
