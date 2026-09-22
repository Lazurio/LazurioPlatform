/** FIXTURE ONLY. The one HTTP client `scripts/qualify-update-linux.sh` needs
 * to click the Launchpad pill on the Linux Machine, compiled into the bundle
 * so the guest needs no curl. It speaks to the loopback session exactly as the
 * page does: the bearer token, a same-origin GET without an `Origin` header
 * (what a browser sends), a POST with `Origin` and a JSON body.
 *
 *   LAZURIO_QUALIFY_TOKEN=<token> update-http GET  <loopback url>
 *   LAZURIO_QUALIFY_TOKEN=<token> update-http POST <loopback url> '<json>'
 *
 * Prints `status=<code>` and then the body; `status=0` and exit 1 when no
 * answer came (a Launchpad that is restarting). It never leaves loopback.
 */
export type SessionAnswer = Readonly<{ status: number; body: string }>;

export type SessionRequest = Readonly<{
  method: "GET" | "POST";
  url: string;
  token: string;
  body?: string | undefined;
  timeoutMs?: number | undefined;
}>;

export async function requestSession(
  input: SessionRequest,
): Promise<SessionAnswer> {
  const url = new URL(input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Loopback sessions only");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
  };
  if (input.method === "POST") {
    headers["Content-Type"] = "application/json";
    headers.Origin = url.origin;
  }
  const response = await fetch(url, {
    method: input.method,
    headers,
    ...(input.method === "POST" ? { body: input.body ?? "" } : {}),
    signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
  });
  return Object.freeze({
    status: response.status,
    body: await response.text(),
  });
}

export const renderAnswer = (answer: SessionAnswer) =>
  `status=${answer.status}\n${answer.body}\n`;

if (import.meta.main) {
  const [method, url, body, ...rest] = process.argv.slice(2);
  const token = process.env.LAZURIO_QUALIFY_TOKEN;
  if (
    (method !== "GET" && method !== "POST") ||
    !url ||
    rest.length > 0 ||
    (method === "GET" && body !== undefined) ||
    !token
  ) {
    console.error(
      "Usage: LAZURIO_QUALIFY_TOKEN=<token> update-http GET <url> | POST <url> <json>",
    );
    process.exit(2);
  }
  try {
    process.stdout.write(
      renderAnswer(await requestSession({ method, url, token, body })),
    );
  } catch (error) {
    process.stdout.write(renderAnswer({ status: 0, body: "" }));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
