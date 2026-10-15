import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { liveAnnouncement } from "../src/launchpad/integrations-view";
import { messages } from "../src/launchpad/messages";

// Apps → Integrace speaks to a screen reader through one live region,
// `#integrations-live` (Pablo's review of #430): a region inserted or shown
// together with its text is often not announced, so it is in the page from
// the start, never hidden, and only its text changes. The notices drawn
// beside it (the failed reading with Zkusit znovu, the last action's line)
// are visual only, so nothing is said twice. How it sounds is checked with a
// screen reader, not here.

const cs = messages("cs");
const en = messages("en");

const page = await readFile(
  join(import.meta.dir, "..", "src", "launchpad", "index.html"),
  "utf8",
);

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
      { read: false, loading: false, failed: false, note: null, ...state },
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
