import { expect, test } from "bun:test";
import {
  readShellDocumentJson,
  shellDocumentPath,
} from "../src/shell/document-read";

const quiet = () => {};
const document = { schema: "lazurio.shell.v1" };
const answer = (status: number) =>
  new Response(JSON.stringify(document), { status });

test("the document is read on its own origin, with no redirect followed", async () => {
  const seen: [string, RequestInit][] = [];
  const value = await readShellDocumentJson(
    async (path, init) => {
      seen.push([path, init]);
      return answer(200);
    },
    100,
    quiet,
    [],
  );
  expect(value).toEqual(document);
  expect(seen).toHaveLength(1);
  const [path, init] = seen[0] as [string, RequestInit];
  expect(path).toBe(shellDocumentPath);
  expect(init.credentials).toBe("same-origin");
  expect(init.cache).toBe("no-store");
  expect(init.redirect).toBe("manual");
});

test("a Launchpad that restarts as the page loads still gives the rail its document", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    let calls = 0;
    const value = await readShellDocumentJson(
      async () => answer(++calls < 3 ? status : 200),
      100,
      quiet,
      [0, 0],
    );
    expect(value).toEqual(document);
    expect(calls).toBe(3);
  }
  let calls = 0;
  const value = await readShellDocumentJson(
    async () => {
      if (++calls === 1) throw new TypeError("network unavailable");
      return answer(200);
    },
    100,
    quiet,
    [0],
  );
  expect(value).toEqual(document);
  expect(calls).toBe(2);
});

test("a stuck attempt is aborted at its deadline and the next one recovers", async () => {
  let calls = 0;
  let aborted = false;
  const value = await readShellDocumentJson(
    (_path, init) => {
      if (++calls > 1) return Promise.resolve(answer(200));
      return new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }),
      );
    },
    10,
    quiet,
    [0],
  );
  expect(aborted).toBe(true);
  expect(value).toEqual(document);
  expect(calls).toBe(2);
});

test("the retries are finite and a final failure says why in one line", async () => {
  let calls = 0;
  const lines: string[] = [];
  const value = await readShellDocumentJson(
    async () => {
      calls++;
      return answer(503);
    },
    100,
    (line) => lines.push(line),
    [0, 0, 0],
  );
  expect(value).toBeNull();
  expect(calls).toBe(4);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("503");
});

test("a refusal, a sign-in redirect and an answer that is no JSON stop at once", async () => {
  const redirect = new Response(null, { status: 200 });
  Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
  Object.defineProperty(redirect, "ok", { value: false });
  Object.defineProperty(redirect, "status", { value: 0 });
  const refusals: [string, () => Response][] = [
    ["401", () => answer(401)],
    ["403", () => answer(403)],
    ["404", () => answer(404)],
    ["redirected to a sign-in", () => redirect],
    ["not JSON", () => new Response("<!doctype html>", { status: 200 })],
  ];
  for (const [reason, respond] of refusals) {
    let calls = 0;
    const lines: string[] = [];
    const value = await readShellDocumentJson(
      async () => {
        calls++;
        return respond();
      },
      100,
      (line) => lines.push(line),
      [0, 0],
    );
    expect(value).toBeNull();
    expect(calls).toBe(1);
    expect(lines[0]).toContain(`(${reason})`);
  }
});
