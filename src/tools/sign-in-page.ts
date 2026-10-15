import { chmod, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiProvider } from "./ai";
import { challengeUrl } from "./challenge-url";

// The sign-in page of codex and claude (root decision 0201 points 4 and 5,
// F19's addendum of 2026-10-15). Each CLI opens its own sign-in page with the
// platform's default browser and waits on 127.0.0.1 for the page's return.
// On Linux both run `$BROWSER` with the page's address as the one argument,
// also without a display (Codex 0.162.1 through Rust's `webbrowser` crate,
// which splits it at whitespace; Claude Code 2.1.301 as one command); without
// it Codex tries `xdg-settings` and `x-www-browser`, and Claude Code
// `xdg-open` only where a display exists (read from both in a throwaway
// Ubuntu 24.04 container, 2026-10-15). A sign-in started by Lazurio on a
// Remote Environment points `BROWSER` at a private stand-in, so the page the
// CLI would open comes to the sign-in that started it, which opens it where
// the person sees it: in the Environment browser, whose tab the Launchpad
// shows in its right panel, or a T3 Code thread's panel for `lazurio tools
// login`. The return to 127.0.0.1 then completes inside the Environment. On a
// workstation nothing is set: the CLI opens the computer's own browser.

/** The official sign-in pages: only an https page on exactly one of these
 * hosts is opened for the person (`challengeUrl`). Codex signs in at OpenAI's
 * authorization server; Claude Code at claude.com (its `/cai/oauth/authorize`,
 * read from Claude Code 2.1.300), formerly claude.ai, and for the Console at
 * platform.claude.com or console.anthropic.com. */
export const signInPageHosts: Readonly<Record<AiProvider, readonly string[]>> =
  {
    codex: ["auth.openai.com"],
    claude: [
      "claude.com",
      "claude.ai",
      "platform.claude.com",
      "console.anthropic.com",
    ],
  };

/** The sign-in page of `tool` at `candidate`, or undefined when it is not
 * one (another host, scheme or port, credentials in the address). */
export function signInPageOf(
  tool: AiProvider,
  candidate: string,
): string | undefined {
  return challengeUrl(candidate, signInPageHosts[tool]);
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address on this computer: what the CLIs listen on for the return. */
export function loopbackAddress(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" && loopbackHosts.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether the page returns to the CLI on this computer (its `redirect_uri`
 * is on localhost): the sign-in then completes by itself. Claude Code's
 * printed address returns to its own code page instead
 * (`https://platform.claude.com/oauth/code/callback`), which shows a code the
 * CLI waits for. */
export function returnsToCli(page: string): boolean {
  try {
    const redirect = new URL(page).searchParams.get("redirect_uri");
    return redirect !== null && loopbackAddress(redirect);
  } catch {
    return false;
  }
}

/** Claude Code's code page shows `<code>#<state>`, which `claude auth login`
 * reads as one line of its input. Only that shape goes there, as one line:
 * two non-empty parts without whitespace, `#` or anything a line could carry
 * past them. The code is never stored or logged. */
export function signInCode(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const code = input.trim();
  return code.length <= 4096 &&
    /^[A-Za-z0-9._~+/=-]+#[A-Za-z0-9._~+/=-]+$/.test(code)
    ? code
    : undefined;
}

/** The answer of `lazurio browser open --json` (the browser CLI contract's
 * `browser-open`, F38's addendum of 2026-10-15): the link of the opened tab,
 * or null for any other answer. */
export function openedView(
  output: Readonly<{ code: number; stdout?: string | undefined }>,
): Readonly<{ view: string }> | null {
  if (output.code !== 0 || output.stdout === undefined) return null;
  try {
    const value = JSON.parse(output.stdout.trim()) as Record<string, unknown>;
    return value?.kind === "browser-open" &&
      typeof value.link === "string" &&
      /^https:\/\//.test(value.link)
      ? Object.freeze({ view: value.link })
      : null;
  } catch {
    return null;
  }
}

/** The private stand-in for a browser of one sign-in: `browser` is what
 * `BROWSER` names. Each call appends the one address it was given to a file
 * only this account can read; `pages` reads them, `close` removes it all. */
export type PageCapture = Readonly<{
  directory: string;
  browser: string;
  pages: () => Promise<readonly string[]>;
  close: () => Promise<void>;
}>;

const maxPagesBytes = 64 * 1024;
// `BROWSER` is split at `:` and at whitespace by the `webbrowser` crate, and a
// shell script names its file in single quotes: the directory has none of
// them, or nothing is set up.
const safePath = /^[A-Za-z0-9._/-]+$/;

export async function createPageCapture(
  parent: string = tmpdir(),
): Promise<PageCapture> {
  const directory = await mkdtemp(join(parent, "lazurio-sign-in-"));
  try {
    if (!safePath.test(directory))
      throw new Error("The sign-in's directory has an unusable name");
    await chmod(directory, 0o700);
    const pages = join(directory, "pages");
    const browser = join(directory, "browser");
    await writeFile(
      browser,
      [
        "#!/bin/sh",
        "# Lazurio: the page a sign-in of codex or claude opens goes to the",
        "# sign-in that started it (F19's addendum of 2026-10-15).",
        '[ "$#" -ge 1 ] || exit 1',
        "umask 077",
        `printf '%s\\n' "$1" >> '${pages}'`,
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    return Object.freeze({
      directory,
      browser,
      async pages() {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(pages, "r");
          const buffer = Buffer.alloc(maxPagesBytes);
          const { bytesRead } = await handle.read(buffer, 0, maxPagesBytes, 0);
          return buffer
            .subarray(0, bytesRead)
            .toString("utf8")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
        } catch {
          return [];
        } finally {
          await handle?.close();
        }
      },
      close: () => rm(directory, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
