import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { liveAnnouncement, liveText } from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";

// Apps → Integrace speaks to a screen reader through one live region,
// `#integrations-live` (Pablo's review of #430): a region inserted or shown
// together with its text is often not announced, so it is in the page from
// the start, never hidden, and only its text changes. The notices drawn
// beside it (the failed reading with Zkusit znovu, the last action's line)
// are visual only, so nothing is said twice. How it sounds is checked with a
// screen reader, not here. The confirmation dialog keeps its own status
// line: a modal dialog makes the page behind it inert, so the page's region
// would not be heard while it is open.

const cs = messages("cs");
const en = messages("en");

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

const source = (name: string) =>
  readFile(join(import.meta.dir, "..", "src", "launchpad", name), "utf8");

type Node = Readonly<{
  attributes: ReadonlyMap<string, string>;
  parent: Node | null;
}>;

async function parse(source: string): Promise<Node[]> {
  const nodes: Node[] = [];
  const open: Node[] = [];
  await new HTMLRewriter()
    .on("*", {
      element(element) {
        const node: Node = {
          attributes: new Map(element.attributes),
          parent: open.at(-1) ?? null,
        };
        nodes.push(node);
        if (element.canHaveContent && !element.selfClosing) {
          open.push(node);
          element.onEndTag(() => {
            open.pop();
          });
        }
      },
    })
    .transform(new Response(source))
    .text();
  return nodes;
}

const nodes = await parse(page);
const byId = (id: string) => {
  const found = nodes.filter((node) => node.attributes.get("id") === id);
  expect(found).toHaveLength(1);
  return found[0] as Node;
};

test("the page has one live region, mounted from the start and never hidden; the notices it speaks for are not live regions themselves", () => {
  const live = byId("integrations-live");
  expect(live.attributes.get("role")).toBe("status");
  expect(live.attributes.get("aria-live")).toBe("polite");
  // Read by screen readers, out of sight.
  expect(live.attributes.get("class")).toBe("sr-only");
  // Nothing above it inside the view hides it while the notices change.
  for (let node: Node | null = live; node !== null; node = node.parent) {
    expect(node.attributes.has("hidden")).toBe(false);
    if (node.attributes.get("id") === "view-integrations") break;
  }
  expect(
    nodes.filter((node) =>
      (node.attributes.get("id") ?? "").startsWith("integrations-live"),
    ),
  ).toHaveLength(1);
  for (const id of [
    "integrations-notices",
    "integrations-alert",
    "integrations-problems",
    "integrations-status",
  ]) {
    const node = byId(id);
    expect(node.attributes.has("role")).toBe(false);
    expect(node.attributes.has("aria-live")).toBe(false);
  }
});

test("a failed first reading, a failed refresh and the retry between them are each said", () => {
  const say = (
    state: Partial<Parameters<typeof liveAnnouncement>[0]>,
    copy = cs,
  ) =>
    liveAnnouncement(
      {
        read: false,
        loading: false,
        failed: false,
        note: null,
        update: "idle",
        form: "",
        ...state,
      },
      copy,
    );
  // The first reading: it runs, then fails.
  expect(say({ loading: true })).toBe(cs.integrationsLoading);
  expect(say({ failed: true })).toBe(cs.integrationsLoadFailed);
  // Zkusit znovu after a failed first reading: a reading again, then its
  // failure again, so the region's text changes each time.
  expect(say({ failed: true, loading: true })).toBe(cs.integrationsLoading);
  expect(say({ failed: true })).toBe(cs.integrationsLoadFailed);
  // A refresh of a page that showed a reading: it runs, then fails.
  expect(say({ read: true, loading: true })).toBe(cs.integrationsChecking);
  expect(say({ read: true, failed: true })).toBe(cs.integrationsLoadFailed);
  expect(say({ read: true, failed: true, loading: true })).toBe(
    cs.integrationsChecking,
  );
  expect(say({ read: true, failed: true }, en)).toBe(en.integrationsLoadFailed);
  // The last action's line is said, and stays while the page reads again
  // after it (a connection done, then the reading that shows it).
  const note = { text: "Připojeno: Slack.", tone: "success" as const };
  expect(say({ read: true, note })).toBe("Připojeno: Slack.");
  expect(say({ read: true, note, loading: true })).toBe("Připojeno: Slack.");
  // A failure is said over an older line.
  expect(say({ read: true, note, failed: true })).toBe(
    cs.integrationsLoadFailed,
  );
  // Nothing to say: an empty region.
  expect(say({ read: true })).toBe("");
});

const isLive = (node: Node) =>
  node.attributes.has("aria-live") ||
  ["status", "alert", "log"].includes(node.attributes.get("role") ?? "");
const within = (node: Node, id: string) => {
  for (let at: Node | null = node; at !== null; at = at.parent)
    if (at.attributes.get("id") === id) return true;
  return false;
};

test("Integrace has exactly one live region in its view, and its confirmation dialog one of its own", () => {
  expect(
    nodes
      .filter((node) => within(node, "view-integrations"))
      .filter(isLive)
      .map((node) => node.attributes.get("id")),
  ).toEqual(["integrations-live"]);
  expect(
    nodes
      .filter((node) => within(node, "integrations-confirm"))
      .filter(isLive)
      .map((node) => node.attributes.get("id")),
  ).toEqual(["integrations-confirm-status"]);
});

test("nothing the Integrace page draws is a live region of its own: no notice, update line or form status sets role or aria-live", async () => {
  // The page draws its notices without a DOM in these tests; what it may
  // set on them is checked where it draws them (Pablo's review of #430:
  // the update line was a second live region).
  for (const name of ["integrations-panel.ts", "custom-server-form.ts"]) {
    const text = await source(name);
    expect(text).not.toMatch(/setAttribute\(\s*"aria-live"/);
    expect(text).not.toMatch(/setAttribute\(\s*"role",\s*"(status|alert|log)"/);
    expect(text).not.toMatch(/\.role\s*=\s*"(status|alert|log)"/);
  }
});

test("Composio's update is said through the one region: running once, a failure, and the success as the last action's line; drawing again says nothing again", () => {
  const say = (state: Partial<Parameters<typeof liveAnnouncement>[0]>) =>
    liveAnnouncement(
      {
        read: true,
        loading: false,
        failed: false,
        note: null,
        update: "idle",
        form: "",
        ...state,
      },
      cs,
    );
  // The click: the update runs.
  const running = say({ update: "updating" });
  expect(running).toBe(cs.integrationsComposioUpdating);
  expect(liveText("", running)).toBe(running);
  // Drawn again while it runs (a reading, a menu, a search): nothing new.
  expect(liveText(running, say({ update: "updating" }))).toBeNull();
  // The reading after a finished update still says the update runs.
  expect(say({ update: "updating", loading: true })).toBe(running);
  // It failed: said once, and not again while the line stays.
  const failed = say({ update: "failed" });
  expect(failed).toBe(cs.integrationsComposioUpdateFailed);
  expect(liveText(running, failed)).toBe(failed);
  expect(liveText(failed, say({ update: "failed" }))).toBeNull();
  // It succeeded: the line about the last action says so.
  const done = {
    text: cs.integrationsComposioUpdated,
    tone: "success" as const,
  };
  expect(say({ note: done })).toBe(cs.integrationsComposioUpdated);
  // A later action's line is heard over a failed update; a failed reading
  // over both.
  const connected = { text: "Připojeno: Slack.", tone: "success" as const };
  expect(say({ update: "failed", note: connected })).toBe("Připojeno: Slack.");
  expect(say({ update: "failed", failed: true })).toBe(
    cs.integrationsLoadFailed,
  );
  expect(say({ update: "updating", failed: true })).toBe(
    cs.integrationsLoadFailed,
  );
});

test("a custom server's page says its own line through the same region", () => {
  const say = (state: Partial<Parameters<typeof liveAnnouncement>[0]>) =>
    liveAnnouncement(
      {
        read: true,
        loading: false,
        failed: false,
        note: null,
        update: "idle",
        form: "",
        ...state,
      },
      en,
    );
  expect(say({ form: en.integrationsMcpSaveFailed })).toBe(
    en.integrationsMcpSaveFailed,
  );
  expect(say({ form: en.integrationsMcpLoadFailed, loading: true })).toBe(
    en.integrationsMcpLoadFailed,
  );
  expect(say({ form: "" })).toBe("");
});
