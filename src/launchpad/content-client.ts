// The client of the content routes (DEV-6644): what lives in this
// Environment (its Organization, the person's Personalspace) and its
// installation by the same Lazurio CLI as `lazurio organization install` and
// `lazurio personalspace install`. The routes are the server's; this module
// only reads their answers, in the shapes below, and refuses anything else.
//
//   GET  /api/content            → { allowed, reason?, items: [...] }
//   POST /api/content/install    {} or { items: [...] }
//                                → 202 { job } · 409 running, with its id · 403
//   GET  /api/content/jobs/<id>  → { id, state, steps: [...], failure? }
//
// A step's and a failure's `item` names one item of the list. The contract
// fixes its meaning, not its spelling, so it is read in the forms a producer
// may write: `{ kind, login }`, `"personalspace"`, `"<kind>:<login>"` or a
// bare GitHub login (an Organization). Pure but for the transport passed in.

export type ContentItemState = "absent" | "present" | "blocked";

export type ContentItem =
  | Readonly<{
      kind: "organization";
      /** The Organization's GitHub login. */
      login: string;
      /** Its display name, when the server knows it. */
      name?: string;
      state: ContentItemState;
      reason?: string;
    }>
  | Readonly<{
      kind: "personalspace";
      /** The person's GitHub login, when the server knows it. */
      login: string | null;
      state: ContentItemState;
      /** Whether the person's Personalspace exists on GitHub. */
      onGitHub?: "exists" | "missing" | "unknown";
      reason?: string;
    }>;

export type ContentList = Readonly<{
  allowed: boolean;
  reason?: string;
  items: readonly ContentItem[];
}>;

/** One item, as a step or a failure names it. */
export type ContentRef = Readonly<
  | { kind: "organization"; login: string }
  | { kind: "personalspace"; login: string | null }
>;

export type ContentStepState = "running" | "done" | "failed" | "skipped";

export type ContentStep = Readonly<{
  item: ContentRef;
  key: string;
  state: ContentStepState;
  detail?: string;
}>;

export type ContentFailure = Readonly<{
  item: ContentRef;
  key: string;
  code: string;
  detail: string;
}>;

export type ContentJob = Readonly<{
  id: string;
  state: "running" | "succeeded" | "failed";
  steps: readonly ContentStep[];
  failure?: ContentFailure;
}>;

/** What `POST /api/content/install` answered. */
export type InstallAnswer =
  | Readonly<{ kind: "started"; job: string }>
  /** One already runs: its id, to follow it. */
  | Readonly<{ kind: "running"; job: string }>
  | Readonly<{ kind: "refused"; reason?: string }>
  | Readonly<{ kind: "failed" }>;

type Data = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Data =>
  !!value && typeof value === "object" && !Array.isArray(value);
const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const isLogin = (value: unknown): value is string =>
  typeof value === "string" && githubLogin.test(value);
const jobId = /^[A-Za-z0-9_-]{1,128}$/;
const stepKey = /^[a-z][a-z0-9-]{0,63}$/;

/** A line of text for the page: no control characters, at most `max`. */
function line(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim();
  return clean === "" ? undefined : [...clean].slice(0, max).join("");
}

/** A technical detail: line breaks kept, other control characters dropped,
 * at most `max` code points (the rest is cut, not refused). */
export function contentDetail(value: unknown, max = 4000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();
  if (clean === "") return undefined;
  const points = [...clean];
  return points.length <= max ? clean : `${points.slice(0, max).join("")}…`;
}

const states: readonly ContentItemState[] = ["absent", "present", "blocked"];

function item(value: unknown): ContentItem | null {
  if (!isRecord(value) || !states.includes(value.state as ContentItemState))
    return null;
  const state = value.state as ContentItemState;
  const reason = line(value.reason);
  const why = reason === undefined ? {} : { reason };
  if (value.kind === "organization") {
    if (!isLogin(value.login)) return null;
    const name = line(value.name, 128);
    return Object.freeze({
      kind: "organization",
      login: value.login,
      ...(name === undefined ? {} : { name }),
      state,
      ...why,
    });
  }
  if (value.kind === "personalspace") {
    if (!(value.login === null || isLogin(value.login))) return null;
    const onGitHub =
      value.onGitHub === "exists" ||
      value.onGitHub === "missing" ||
      value.onGitHub === "unknown"
        ? value.onGitHub
        : undefined;
    return Object.freeze({
      kind: "personalspace",
      login: value.login as string | null,
      state,
      ...(onGitHub === undefined ? {} : { onGitHub }),
      ...why,
    });
  }
  return null;
}

/** The answer of `GET /api/content`, or null when it has another shape. An
 * item of a kind this page does not know is left out. */
export function parseContentList(value: unknown): ContentList | null {
  if (
    !isRecord(value) ||
    typeof value.allowed !== "boolean" ||
    !Array.isArray(value.items)
  )
    return null;
  const items: ContentItem[] = [];
  for (const entry of value.items) {
    const read = item(entry);
    if (read !== null) items.push(read);
    else if (
      !isRecord(entry) ||
      entry.kind === "organization" ||
      entry.kind === "personalspace"
    )
      return null;
  }
  const reason = line(value.reason);
  return Object.freeze({
    allowed: value.allowed,
    ...(reason === undefined ? {} : { reason }),
    items: Object.freeze(items),
  });
}

/** The item a step or a failure names, in any of the forms above. */
export function parseContentRef(value: unknown): ContentRef | null {
  if (isRecord(value)) {
    if (value.kind === "personalspace")
      return {
        kind: "personalspace",
        login: isLogin(value.login) ? value.login : null,
      };
    if (value.kind === "organization" && isLogin(value.login))
      return { kind: "organization", login: value.login };
    return null;
  }
  if (typeof value !== "string") return null;
  if (value === "personalspace") return { kind: "personalspace", login: null };
  const [kind, login, ...rest] = value.split(":");
  if (rest.length === 0 && login !== undefined) {
    if (kind === "personalspace")
      return { kind: "personalspace", login: isLogin(login) ? login : null };
    if (kind === "organization" && isLogin(login))
      return { kind: "organization", login };
    return null;
  }
  return isLogin(value) ? { kind: "organization", login: value } : null;
}

const stepStates: readonly ContentStepState[] = [
  "running",
  "done",
  "failed",
  "skipped",
];

/** The answer of `GET /api/content/jobs/<id>`, or null. */
export function parseContentJob(value: unknown): ContentJob | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !jobId.test(value.id) ||
    !(
      value.state === "running" ||
      value.state === "succeeded" ||
      value.state === "failed"
    ) ||
    !Array.isArray(value.steps)
  )
    return null;
  const steps: ContentStep[] = [];
  for (const entry of value.steps) {
    if (!isRecord(entry)) return null;
    const ref = parseContentRef(entry.item);
    if (
      ref === null ||
      typeof entry.key !== "string" ||
      !stepKey.test(entry.key) ||
      !stepStates.includes(entry.state as ContentStepState)
    )
      return null;
    const detail = contentDetail(entry.detail);
    steps.push(
      Object.freeze({
        item: ref,
        key: entry.key,
        state: entry.state as ContentStepState,
        ...(detail === undefined ? {} : { detail }),
      }),
    );
  }
  let failure: ContentFailure | undefined;
  if (value.failure !== undefined && value.failure !== null) {
    const raw = value.failure;
    if (!isRecord(raw)) return null;
    const ref = parseContentRef(raw.item);
    if (ref === null || typeof raw.key !== "string" || !stepKey.test(raw.key))
      return null;
    failure = Object.freeze({
      item: ref,
      key: raw.key,
      code: line(raw.code, 80) ?? "",
      detail: contentDetail(raw.detail) ?? "",
    });
  }
  return Object.freeze({
    id: value.id,
    state: value.state,
    steps: Object.freeze(steps),
    ...(failure === undefined ? {} : { failure }),
  });
}

/** A job's id as an answer names it: `job` (the id, or the job itself) or
 * `id`. */
function answerJob(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidates = [
    value.job,
    isRecord(value.job) ? value.job.id : undefined,
    value.id,
  ];
  for (const candidate of candidates)
    if (typeof candidate === "string" && jobId.test(candidate))
      return candidate;
  return null;
}

/** What `POST /api/content/install` answered, by its status. */
export function installAnswer(status: number, value: unknown): InstallAnswer {
  if (status >= 200 && status < 300) {
    const job = answerJob(value);
    return job === null ? { kind: "failed" } : { kind: "started", job };
  }
  if (status === 409) {
    const job = answerJob(value);
    return job === null ? { kind: "failed" } : { kind: "running", job };
  }
  if (status === 403) {
    const reason = isRecord(value) ? line(value.reason) : undefined;
    return reason === undefined
      ? { kind: "refused" }
      : { kind: "refused", reason };
  }
  return { kind: "failed" };
}

/** Whether a step's or a failure's item is this item of the list. */
export function refersTo(ref: ContentRef, entry: ContentItem): boolean {
  if (ref.kind !== entry.kind) return false;
  if (ref.kind === "personalspace") return true;
  return (
    entry.kind === "organization" &&
    ref.login.toLowerCase() === entry.login.toLowerCase()
  );
}

/** One request of the page: its status and JSON body (null when it has
 * none). The page supplies it with its credential. */
export type ContentTransport = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<Readonly<{ status: number; value: unknown }>>;

export function createContentClient(transport: ContentTransport) {
  return {
    /** What lives here, or null: no such route, or an answer of another
     * shape. */
    async list(): Promise<ContentList | null> {
      try {
        const { status, value } = await transport("GET", "/api/content");
        return status === 200 ? parseContentList(value) : null;
      } catch {
        return null;
      }
    },
    /** Starts the installation of everything missing (no `items`), or of
     * the items named. */
    async install(items?: readonly ContentRef[]): Promise<InstallAnswer> {
      try {
        const { status, value } = await transport(
          "POST",
          "/api/content/install",
          items === undefined ? {} : { items },
        );
        return installAnswer(status, value);
      } catch {
        return { kind: "failed" };
      }
    },
    /** One job, or null when it is unknown or unreadable. */
    async job(id: string): Promise<ContentJob | null> {
      if (!jobId.test(id)) return null;
      try {
        const { status, value } = await transport(
          "GET",
          `/api/content/jobs/${encodeURIComponent(id)}`,
        );
        const job = status === 200 ? parseContentJob(value) : null;
        return job?.id === id ? job : null;
      } catch {
        return null;
      }
    },
    /** Reads a job until it is no longer running, calling `seen` with every
     * answer; resolves with the last one (null when it could not be read
     * `attempts` times in a row, or `stopped` says so). */
    async follow(
      id: string,
      seen: (job: ContentJob) => void,
      options: Readonly<{
        intervalMs?: number;
        attempts?: number;
        stopped?: () => boolean;
        wait?: (ms: number) => Promise<void>;
      }> = {},
    ): Promise<ContentJob | null> {
      const wait =
        options.wait ??
        ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
      const attempts = options.attempts ?? 5;
      let failures = 0;
      let last: ContentJob | null = null;
      for (;;) {
        if (options.stopped?.() === true) return last;
        const job = await this.job(id);
        if (job === null) {
          failures += 1;
          if (failures >= attempts) return null;
        } else {
          failures = 0;
          last = job;
          seen(job);
          if (job.state !== "running") return job;
        }
        await wait(options.intervalMs ?? 1000);
      }
    },
  };
}

export type ContentClient = ReturnType<typeof createContentClient>;
