import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

// Trust for chats started from the phone (decision F71 point 8,
// Lazurio/LazurioPlatform#720). A phone cannot answer Codex's question
// whether a folder is trusted, so a chat started there in an untrusted
// folder stops. Lazurio adds `[projects."<path>"] trust_level = "trusted"`
// to `$CODEX_HOME/config.toml` for the Folder and the operator's home, as
// Codex itself writes it when the person answers the question.
//
// It follows `src/tools/codex-apps.ts`: only lines Lazurio adds, each with a
// marker; an entry the person already has for that path (trusted or not) is
// theirs and stays as it is; nothing is removed; a file Lazurio cannot edit
// safely (a link, a file that does not parse, `projects` in another form) is
// left alone and reported; the write is a new file renamed over the old one,
// with the old one's mode, only when the old one did not change meanwhile.

export const codexTrustMarker = "# lazurio: phone-trust";

export type CodexTrustRefusal =
  | "config-unreadable"
  | "config-shape"
  | "config-not-regular"
  | "config-changed"
  | "write-failed";

export type CodexTrustOutcome = Readonly<{
  kind: "unchanged" | "changed" | "refused";
  reason?: CodexTrustRefusal;
}>;

const configBytesMax = 1024 * 1024;

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parse(text: string): Table | null {
  try {
    const value: unknown = Bun.TOML.parse(text);
    return isTable(value) ? value : null;
  } catch {
    return null;
  }
}

/** A TOML basic string: JSONs escapes are TOMLs; what TOML still refuses
 * (DEL) fails the check of the new text below. */
const quoted = (value: string) => JSON.stringify(value);

/** The text with a trusted entry for each path that has none; null when the
 * text cannot be edited safely. */
export function codexTrustedText(
  text: string,
  paths: readonly string[],
): string | null {
  const parsed = parse(text);
  if (parsed === null) return null;
  const projects = parsed.projects;
  if (projects !== undefined && !isTable(projects)) return null;
  const missing = [...new Set(paths)].filter(
    (path) => path !== "" && (projects === undefined || !(path in projects)),
  );
  if (missing.length === 0) return text;
  const added = missing
    .map(
      (path) =>
        `[projects.${quoted(path)}] ${codexTrustMarker}\ntrust_level = "trusted" ${codexTrustMarker}\n`,
    )
    .join("\n");
  const base =
    text === "" ? "" : text.endsWith("\n") ? `${text}\n` : `${text}\n\n`;
  const next = `${base}${added}`;
  const check = parse(next);
  const checked = isTable(check?.projects) ? check.projects : null;
  if (
    checked === null ||
    !missing.every(
      (path) =>
        isTable(checked[path]) &&
        (checked[path] as Table).trust_level === "trusted",
    )
  )
    return null;
  return next;
}

type Read =
  | Readonly<{ kind: "text"; text: string; mode: number | null }>
  | Readonly<{ kind: "refused"; reason: CodexTrustRefusal }>;

async function readConfig(file: string): Promise<Read> {
  let mode: number | null = null;
  try {
    const status = await lstat(file);
    if (!status.isFile())
      return { kind: "refused", reason: "config-not-regular" };
    if (status.size > configBytesMax)
      return { kind: "refused", reason: "config-unreadable" };
    mode = status.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { kind: "text", text: "", mode: null };
    return { kind: "refused", reason: "config-unreadable" };
  }
  try {
    return { kind: "text", text: await readFile(file, "utf8"), mode };
  } catch {
    return { kind: "refused", reason: "config-unreadable" };
  }
}

/** Idempotent: writes only when an entry is missing. */
export async function convergeCodexTrust(
  codexHome: string,
  paths: readonly string[],
): Promise<CodexTrustOutcome> {
  const file = join(codexHome, "config.toml");
  const read = await readConfig(file);
  if (read.kind === "refused") return read;
  const next = codexTrustedText(read.text, paths);
  if (next === null) return { kind: "refused", reason: "config-shape" };
  if (next === read.text) return { kind: "unchanged" };
  if (read.mode === null)
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const temporary = join(
    codexHome,
    `.config.toml.lazurio-${randomBytes(6).toString("hex")}`,
  );
  try {
    const handle = await open(temporary, "wx", read.mode ?? 0o600);
    try {
      await handle.writeFile(next, "utf8");
      await handle.chmod(read.mode ?? 0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const again = await readConfig(file);
    if (again.kind !== "text" || again.text !== read.text) {
      await unlink(temporary).catch(() => undefined);
      return { kind: "refused", reason: "config-changed" };
    }
    await rename(temporary, file);
  } catch {
    await unlink(temporary).catch(() => undefined);
    return { kind: "refused", reason: "write-failed" };
  }
  return { kind: "changed" };
}
