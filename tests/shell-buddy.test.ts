import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type MachineBinding,
  parseMachineBinding,
  parseMachineEntry,
} from "../src/folder/machine-binding";
import { shellDocument } from "../src/launchpad/shell-document";
import type { Store } from "../src/shell/account";
import {
  type BuddyBubbleModel,
  buddyLayoutKey,
  createBuddyBubble,
} from "../src/shell/buddy-bubble";
import * as protocol from "../src/shell/buddy-protocol";
import {
  type BuddyContext,
  type BuddyContextFacts,
  type BuddyFrameWindow,
  buddyContext,
  buddyFrameAttributes,
  buddyVectorsSchema,
  createBuddyContextSender,
  parseBuddyContext,
} from "../src/shell/buddy-protocol";
import {
  isShellBuddyOrigin,
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
  type ShellEnvironmentKind,
} from "../src/shell/contract";
import {
  createGuide,
  type GuideActions,
  type GuideEvent,
  type GuideView,
} from "../src/shell/guide";
import { principleIds } from "../src/shell/guide-content";
import { mergeAccount, mergedBuddy } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import { accountDocument } from "./fixtures/account-document";
import {
  describeVectors,
  readVectorFiles,
} from "./fixtures/browser-contract-vectors";
import { bindings } from "./fixtures/machine-bindings";

// Buddy's bubble, the shell's side (decision F60; root decision 0210 point
// 8, plan DEV-6676 P3, the contract of drafts/buddy-web-v1 sections 1 to 3):
// the optional `buddy: {origin}` of `lazurio.shell.v1` and
// `lazurio.account.v1` and how the page merges them, the Launchpad of an
// Osobní Prostředí that names it from its hosted entry, the protocol
// `lazurio.buddy.*` v1 between the host and Buddy's frame with its vectors,
// and `<lazurio-buddy>`'s bubble over a faked page: the launcher only with
// Buddy's origin, the frame made at the first open with exactly its
// attributes, the panel and full screen, the frame's requests, the context
// and the guide's receiver. Example names only.

const buddy = "https://buddy.ada.lazurio.io";

// The vectors: every case of `buddy-vectors/v1/` through the runner of
// decision F50, which Buddy's frame runs against the same files.
const vectorDirectory = join(
  import.meta.dir,
  "..",
  "src",
  "shell",
  "buddy-vectors",
  "v1",
);
const files = readVectorFiles(vectorDirectory);
describeVectors(files, { pure: protocol, node: {} });

test("the vector files are this contract's, and every export of the protocol has a case", () => {
  expect(files.map((file) => [file.schema, file.contract])).toEqual([
    [buddyVectorsSchema, "buddy-protocol"],
  ]);
  const called = new Set(
    files.flatMap((file) => file.cases.map((entry) => entry.call)),
  );
  // The builder and the sender take a parsed document and windows, so
  // their cases are below.
  const below = new Set([
    "buddyContext",
    "buddyContextKind",
    "createBuddyContextSender",
    "parseBuddyContext",
  ]);
  for (const name of Object.keys(protocol))
    if (!below.has(name))
      expect({ name, case: called.has(name) }).toEqual({ name, case: true });
});

// ---- The documents --------------------------------------------------------

/** A shell document of one Environment of `kind`, as its Launchpad
 * produces it. */
function documentOf(
  kind: ShellEnvironmentKind,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const personal = kind === "personal";
  const id = personal
    ? "ada"
    : kind === "workstation"
      ? "local"
      : "vm-03.example";
  return {
    schema: "lazurio.shell.v1",
    locale: "cs",
    current: id,
    operator: { initials: "A", login: "ada", avatar: null },
    environments: [
      {
        id,
        label: kind === "team" ? "Sales" : null,
        kind,
        organizations: personal ? [] : ["example"],
        assignee: kind === "work" ? "ada" : null,
        apps:
          kind === "workstation"
            ? { apps: "/", chat: null, automate: null }
            : {
                apps: `https://launchpad.${id}.lazurio.io/`,
                chat: `https://t3code.${id}.lazurio.io/`,
                automate: `https://mausbot.${id}.lazurio.io/`,
              },
      },
    ],
    organizations: personal
      ? []
      : [
          {
            slug: "example",
            name: "Example Works",
            avatar: null,
            dashboard: "https://dashboard.lazurio.ai/orgs/example",
          },
        ],
    dashboard: "https://dashboard.lazurio.ai/home",
    account: "https://dashboard.lazurio.ai/settings/account",
    addOrganization: null,
    ...extra,
  };
}

function shellOf(
  kind: ShellEnvironmentKind,
  extra: Readonly<Record<string, unknown>> = {},
): Shell {
  const shell = parseShell(documentOf(kind, extra));
  if (shell === null) throw new Error("The fixture is a valid document");
  return shell;
}

function accountOf(
  extra: Readonly<Record<string, unknown>> = {},
): ShellAccount {
  const account = parseShellAccount(accountDocument(extra));
  if (account === null) throw new Error("The fixture is a valid account");
  return account;
}

test("Buddy's origin: exactly https://buddy.<slug>.lazurio.io", () => {
  expect(isShellBuddyOrigin(buddy)).toBe(true);
  expect(isShellBuddyOrigin("https://buddy.a-b.lazurio.io")).toBe(true);
  for (const refused of [
    "http://buddy.ada.lazurio.io",
    "https://buddy.ada.lazurio.io/",
    "https://buddy.ada.lazurio.io:8443",
    "https://buddy.Ada.lazurio.io",
    "https://buddy.vm-01.example.lazurio.io",
    "https://launchpad.ada.lazurio.io",
    "https://buddy.ada.lazurio.ai",
    "https://buddy.ada.lazurio.io.evil.example",
    "https://buddy.-ada.lazurio.io",
    "https://x@buddy.ada.lazurio.io",
    "https://buddy.ada.lazurio.io/?x",
    "",
    null,
    42,
  ])
    expect({ refused, accepted: isShellBuddyOrigin(refused) }).toEqual({
      refused,
      accepted: false,
    });
});

test("the shell document names Buddy only on his own Osobní Prostředí; anything else is no document", () => {
  const own = shellOf("personal", { buddy: { origin: buddy } });
  expect(own.buddy).toEqual({ origin: buddy });
  // Absent or null: none, as before.
  expect(Object.hasOwn(shellOf("personal"), "buddy")).toBe(false);
  expect(Object.hasOwn(shellOf("personal", { buddy: null }), "buddy")).toBe(
    false,
  );
  // A member a later release adds to it is ignored.
  expect(
    shellOf("personal", { buddy: { origin: buddy, later: 1 } }).buddy,
  ).toEqual({ origin: buddy });
  for (const [kind, value] of [
    // Another Environment's Buddy, and an origin that is no Buddy's.
    ["personal", { origin: "https://buddy.bob.lazurio.io" }],
    ["personal", { origin: "https://launchpad.ada.lazurio.io" }],
    ["personal", { origin: "http://buddy.ada.lazurio.io" }],
    ["personal", {}],
    ["personal", buddy],
    // A work, Team or Automated Environment, or your computer, never names
    // one itself: the account does.
    ["work", { origin: buddy }],
    ["team", { origin: buddy }],
    ["automated", { origin: buddy }],
    ["workstation", { origin: buddy }],
  ] as const)
    expect({
      kind,
      value,
      parsed: parseShell(documentOf(kind, { buddy: value })),
    }).toEqual({ kind, value, parsed: null });
  // A page that belongs to no Environment carries none, not even null.
  const dashboard = { ...documentOf("work"), current: null };
  expect(parseShell(dashboard)).not.toBeNull();
  expect(parseShell({ ...dashboard, buddy: null })).toBeNull();
  expect(parseShell({ ...dashboard, buddy: { origin: buddy } })).toBeNull();
});

test("the account names Buddy of a personal Environment it lists; anything else is no account", () => {
  expect(accountOf({ buddy: { origin: buddy } }).buddy).toEqual({
    origin: buddy,
  });
  expect(Object.hasOwn(accountOf(), "buddy")).toBe(false);
  expect(Object.hasOwn(accountOf({ buddy: null }), "buddy")).toBe(false);
  for (const value of [
    // Not listed, or not personal (a Team Environment's base is two labels
    // and is no Buddy's anyway).
    { origin: "https://buddy.bob.lazurio.io" },
    { origin: "https://buddy.vm-01.example.lazurio.io" },
    { origin: "https://launchpad.ada.lazurio.io" },
    { origin: `${buddy}/` },
    {},
    buddy,
    [],
  ])
    expect({
      value,
      parsed: parseShellAccount(accountDocument({ buddy: value })),
    }).toEqual({ value, parsed: null });
});

test("merged: on the Osobní Prostředí its own document's, else the account's for it; elsewhere only the account's; never on your computer", () => {
  const account = accountOf({ buddy: { origin: buddy } });
  // On the Osobní Prostředí.
  const own = shellOf("personal", { buddy: { origin: buddy } });
  expect(mergeAccount(own, null).buddy).toEqual({ origin: buddy });
  expect(mergeAccount(own, accountOf()).buddy).toEqual({ origin: buddy });
  expect(mergeAccount(shellOf("personal"), account).buddy).toEqual({
    origin: buddy,
  });
  expect(mergeAccount(shellOf("personal"), null).buddy).toBeUndefined();
  // A work or Team Environment: the account decides (the same tailnet).
  expect(mergeAccount(shellOf("work"), account).buddy).toEqual({
    origin: buddy,
  });
  expect(mergeAccount(shellOf("team"), account).buddy).toEqual({
    origin: buddy,
  });
  expect(mergeAccount(shellOf("automated"), account).buddy).toEqual({
    origin: buddy,
  });
  expect(mergeAccount(shellOf("work"), accountOf()).buddy).toBeUndefined();
  expect(mergeAccount(shellOf("work"), null).buddy).toBeUndefined();
  // Your computer and a page that is no Environment's (the Dashboard) never.
  expect(mergeAccount(shellOf("workstation"), account).buddy).toBeUndefined();
  const dashboard = parseShell({ ...documentOf("work"), current: null });
  if (dashboard === null) throw new Error("The fixture is a valid document");
  expect(mergeAccount(dashboard, account).buddy).toBeUndefined();
  // A document of another Environment that names one by mistake (or a host
  // that hands over an unparsed one) is never taken.
  const forged = { ...shellOf("work"), buddy: { origin: buddy } } as Shell;
  expect(mergedBuddy(forged, null)).toBeUndefined();
  expect(mergeAccount(forged, accountOf()).buddy).toBeUndefined();
  const elsewhere = {
    ...shellOf("personal"),
    buddy: { origin: "https://buddy.bob.lazurio.io" },
  } as Shell;
  expect(mergedBuddy(elsewhere, null)).toBeUndefined();
  // Without anything to change, the document is the one given.
  const plain = shellOf("work");
  expect(mergeAccount(plain, null)).toBe(plain);
  expect(mergeAccount(own, null)).toBe(own);
});

// ---- The hosted entry and the Launchpad's document ------------------------

const personalEntry = bindings.personalEntry as MachineBinding & {
  entry: NonNullable<MachineBinding["entry"]>;
};
const withBuddy = (binding: MachineBinding, origin: string): unknown =>
  JSON.parse(
    JSON.stringify({
      ...binding,
      entry: { ...binding.entry, buddyOrigin: origin },
    }),
  );

test("the binding records Buddy's origin only on a personal Machine, of its own base host", () => {
  const recorded = parseMachineBinding(
    withBuddy(personalEntry, "https://buddy.example.lazurio.io"),
  );
  expect(recorded?.entry?.buddyOrigin).toBe("https://buddy.example.lazurio.io");
  // Without it the binding is what it was, byte for byte.
  expect(
    JSON.stringify(
      parseMachineBinding(JSON.parse(JSON.stringify(personalEntry))),
    ),
  ).toBe(JSON.stringify(personalEntry));
  for (const origin of [
    "https://buddy.other.lazurio.io",
    "https://launchpad.example.lazurio.io",
    "https://buddy.example.lazurio.io/",
    "http://buddy.example.lazurio.io",
  ])
    expect(() =>
      parseMachineEntry({ ...personalEntry.entry, buddyOrigin: origin }),
    ).toThrow("Invalid hosted entry Buddy origin");
  const work = bindings.organizationEntry;
  expect(() =>
    parseMachineBinding(
      withBuddy(work, "https://buddy.workspace.example.lazurio.io"),
    ),
  ).toThrow();
});

test("the Launchpad of an Osobní Prostředí names Buddy where its entry routes him; nowhere else", () => {
  const catalog = { kind: "catalog", organizations: [] } as const;
  const recorded = parseMachineBinding(
    withBuddy(personalEntry, "https://buddy.example.lazurio.io"),
  );
  const own = shellDocument({
    preset: "hosted-personal",
    machine: recorded,
    locale: "cs",
    catalog,
  });
  expect(own.current).toBe("example");
  expect(own.buddy).toEqual({ origin: "https://buddy.example.lazurio.io" });
  // The same parser as every consumer's takes it.
  expect(parseShell(JSON.parse(JSON.stringify(own)))?.buddy).toEqual(own.buddy);
  for (const [preset, machine] of [
    ["hosted-personal", bindings.personalEntry],
    ["hosted-organization-personal", bindings.organizationEntry],
    ["local", null],
  ] as const)
    expect(
      Object.hasOwn(
        shellDocument({ preset, machine, locale: "cs", catalog }),
        "buddy",
      ),
    ).toBe(false);
});

// ---- The context ------------------------------------------------------------

const factsOf = (
  shell: Shell,
  extra: Partial<BuddyContextFacts> = {},
): BuddyContextFacts => ({
  shell,
  space: null,
  active: "apps",
  lang: null,
  path: "/files",
  theme: "light",
  guide: null,
  ...extra,
});

test("the context of a work Environment's page: the facts of the page, in the picker's words", () => {
  const merged = mergeAccount(
    shellOf("work"),
    accountOf({ buddy: { origin: buddy } }),
  );
  expect(buddyContext(factsOf(merged))).toEqual({
    type: "lazurio.buddy.context",
    v: 1,
    lang: "cs",
    theme: "light",
    // The account's name is in English, the document in Czech: the kind's
    // word, as the picker shows it.
    environment: { id: "vm-03.example", kind: "work", name: "Pracovní" },
    organization: { slug: "example", name: "Example Works" },
    app: "apps",
    page: { path: "/files" },
    guide: null,
  });
  const english = mergeAccount(
    shellOf("work", { locale: "en" }),
    accountOf({ buddy: { origin: buddy } }),
  );
  expect(
    buddyContext(
      factsOf(english, {
        active: "chat",
        path: "/0f7e2c1a",
        theme: "dark",
        guide: { explainer: "files", step: 2 },
      }),
    ),
  ).toEqual({
    type: "lazurio.buddy.context",
    v: 1,
    lang: "en",
    theme: "dark",
    environment: { id: "vm-03.example", kind: "work", name: "Work" },
    organization: { slug: "example", name: "Example Works" },
    app: "chat",
    page: { path: "/0f7e2c1a" },
    guide: { explainer: "files", step: 2 },
  });
});

test("the context: the kinds of root decision 0207, the element's language, and nothing on your computer or the Dashboard", () => {
  const personal = buddyContext(
    factsOf(shellOf("personal"), { active: "automate", lang: "en" }),
  );
  expect(personal?.environment).toEqual({
    id: "ada",
    kind: "personal",
    name: "Personal",
  });
  expect(personal?.organization).toBeNull();
  expect(personal?.lang).toBe("en");
  expect(buddyContext(factsOf(shellOf("team")))?.environment).toEqual({
    id: "vm-03.example",
    kind: "team",
    name: "Sales",
  });
  // An automated Environment is a work one.
  expect(buddyContext(factsOf(shellOf("automated")))?.environment?.kind).toBe(
    "work",
  );
  expect(buddyContext(factsOf(shellOf("workstation")))).toBeNull();
  const dashboard = parseShell({ ...documentOf("work"), current: null });
  if (dashboard === null) throw new Error("The fixture is a valid document");
  expect(buddyContext(factsOf(dashboard))).toBeNull();
  // Settings, and a page without a column head.
  expect(
    buddyContext(factsOf(shellOf("work"), { active: "settings" }))?.app,
  ).toBe("settings");
  expect(
    buddyContext(factsOf(shellOf("work"), { active: null }))?.app,
  ).toBeNull();
  expect(
    buddyContext(factsOf(shellOf("work"), { active: "module" }))?.app,
  ).toBeNull();
});

test("the context never says a query, a fragment or anything that is no page path", () => {
  for (const path of [
    "/files?token=secret",
    "/x#wsTicket=secret",
    "//evil.example/",
    "files",
    `/${"p".repeat(600)}`,
    "/a b",
  ])
    expect({
      path,
      sent: buddyContext(factsOf(shellOf("work"), { path }))?.page,
    }).toEqual({ path, sent: { path: "/" } });
  // A guide step out of the protocol's bounds is no context at all.
  expect(
    buddyContext(
      factsOf(shellOf("work"), { guide: { explainer: "files", step: 0 } }),
    ),
  ).toBeNull();
});

test("parseBuddyContext refuses an object of another prototype and members it does not know", () => {
  const good = buddyContext(factsOf(shellOf("work"))) as BuddyContext;
  expect(parseBuddyContext({ ...good })).toEqual(good);
  expect(
    parseBuddyContext(Object.assign(Object.create(null), good)),
  ).toBeNull();
  class Context {
    constructor() {
      Object.assign(this, good);
    }
  }
  expect(parseBuddyContext(new Context())).toBeNull();
  expect(
    parseBuddyContext({ ...good, [Symbol("extra")]: true } as unknown),
  ).toBeNull();
  const withGetter = { ...good };
  Object.defineProperty(withGetter, "lang", {
    get: () => "cs",
    enumerable: true,
  });
  expect(parseBuddyContext(withGetter)).toBeNull();
});

// ---- The sends ---------------------------------------------------------------

type Posted = { message: unknown; target: string };
const windowOf = (posted: Posted[]): BuddyFrameWindow => ({
  postMessage(message, target) {
    posted.push({ message, target });
  },
});

test("the context goes after ready, then only when it changed, only to the frame on exactly Buddy's origin", () => {
  const posted: Posted[] = [];
  let frame: BuddyFrameWindow | null = null;
  let path = "/files";
  const sender = createBuddyContextSender({
    origin: buddy,
    frame: () => frame,
    context: () => buddyContext(factsOf(shellOf("work"), { path })),
  });
  // Nothing before ready, nor without a frame.
  expect(sender.changed()).toBe(false);
  expect(sender.ready()).toBe(false);
  frame = windowOf(posted);
  sender.reset();
  expect(sender.changed()).toBe(false);
  expect(sender.ready()).toBe(true);
  expect(sender.changed()).toBe(false);
  path = "/settings/general";
  expect(sender.changed()).toBe(true);
  expect(sender.changed()).toBe(false);
  // A frame loaded anew hears it again.
  expect(sender.ready()).toBe(true);
  expect(posted.map(({ target }) => target)).toEqual([buddy, buddy, buddy]);
  expect(
    posted.map(({ message }) => (message as BuddyContext).page.path),
  ).toEqual(["/files", "/settings/general", "/settings/general"]);
  // Never to an origin that is no Buddy's, never `*`.
  const none: Posted[] = [];
  const star = createBuddyContextSender({
    origin: "*",
    frame: () => windowOf(none),
    context: () => buddyContext(factsOf(shellOf("work"))),
  });
  expect(star.ready()).toBe(false);
  expect(none).toEqual([]);
});

// ---- The bubble over a faked page ---------------------------------------

function memory(): Store & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** The bubble over a faked page: the document it reads, what it draws,
 * where the focus goes, what it posts, and the guide it asks. */
function fakeBubble(
  options: Readonly<{
    origin?: string | null;
    session?: Store;
    known?: readonly string[];
    tour?: boolean;
    plays?: boolean;
  }> = {},
) {
  const log = {
    drawn: [] as (BuddyBubbleModel | null)[],
    focus: [] as string[],
    posted: [] as Posted[],
    played: [] as string[],
  };
  const page = {
    origin: options.origin === undefined ? buddy : options.origin,
    shell: mergeAccount(
      shellOf("work"),
      accountOf({ buddy: { origin: buddy } }),
    ),
    active: "chat" as string | null,
    path: "/files",
    playing: null as string | null,
  };
  const frame = windowOf(log.posted);
  const session = options.session ?? memory();
  const bubble = createBuddyBubble({
    origin: () => page.origin,
    facts: () => ({
      shell: page.shell,
      space: null,
      active: page.active,
      lang: null,
      path: page.path,
      theme: "light",
    }),
    frameWindow: () => (log.drawn.at(-1)?.frame ? frame : null),
    session,
    draw: (model) => {
      log.drawn.push(model);
    },
    focus: (target) => {
      log.focus.push(target);
    },
    guide: {
      known: () => options.known ?? principleIds,
      playing: () => page.playing,
      tour: () => options.tour ?? false,
      kind: () => "work",
      play: (explainer) => {
        log.played.push(explainer);
        if (options.plays === false) return false;
        page.playing = explainer;
        return true;
      },
    },
  });
  const last = () => log.drawn.at(-1) ?? null;
  const fromFrame = (data: unknown, origin = buddy) =>
    bubble.receive({ data, origin, source: frame });
  const contexts = () =>
    log.posted
      .map(({ message }) => message as { type: string })
      .filter((message) => message.type === "lazurio.buddy.context");
  return { bubble, log, page, frame, session, last, fromFrame, contexts };
}

test("without Buddy's origin the bubble draws nothing, makes no frame and hears nothing", () => {
  const { bubble, log, fromFrame } = fakeBubble({ origin: null });
  bubble.update();
  bubble.toggle();
  expect(bubble.escape()).toBe(false);
  fromFrame({ type: "lazurio.buddy.ready", v: 1 });
  bubble.changed();
  expect(log.drawn.every((model) => model === null)).toBe(true);
  expect(log.posted).toEqual([]);
  expect(log.focus).toEqual([]);
});

test("with Buddy's origin: the launcher with his picture, no frame before the first click, then exactly the frame's attributes", () => {
  const { bubble, last, log } = fakeBubble();
  bubble.update();
  expect(last()).toEqual({
    origin: buddy,
    launcher: {
      avatar: `${buddy}/assets/avatar.webp`,
      label: "Buddy",
      expanded: false,
    },
    frame: null,
    layout: "closed",
    app: "chat",
  });
  bubble.toggle();
  expect(last()?.frame).toEqual({
    src: `${buddy}/`,
    title: "Buddy",
    sandbox:
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    referrerpolicy: "origin",
    allow: "clipboard-write",
  });
  expect(last()?.frame).toMatchObject(buddyFrameAttributes);
  expect(last()?.layout).toBe("panel");
  expect(last()?.launcher.expanded).toBe(true);
  expect(log.focus).toEqual(["frame"]);
  // Closed, the frame stays: opened again, the conversation is as it was.
  const frame = last()?.frame;
  bubble.toggle();
  expect(last()?.layout).toBe("closed");
  expect(last()?.frame).toBe(frame ?? null);
  expect(log.focus).toEqual(["frame", "launcher"]);
});

test("full screen: the frame asks for it, Escape returns to the panel, the choice kept for the tab", () => {
  const session = memory();
  const { bubble, last, fromFrame, log } = fakeBubble({ session });
  bubble.update();
  bubble.toggle();
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "fullscreen" });
  expect(last()?.layout).toBe("fullscreen");
  expect(session.items.get(buddyLayoutKey)).toBe("fullscreen");
  // Closed and opened again: full screen, as chosen.
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "closed" });
  expect(last()?.layout).toBe("closed");
  expect(log.focus.at(-1)).toBe("launcher");
  bubble.toggle();
  expect(last()?.layout).toBe("fullscreen");
  // A page of the same tab opens in it too.
  const next = fakeBubble({ session });
  next.bubble.update();
  next.bubble.toggle();
  expect(next.last()?.layout).toBe("fullscreen");
  // Escape: back to the panel, and that is the choice now; then closed.
  expect(bubble.escape()).toBe(true);
  expect(last()?.layout).toBe("panel");
  expect(session.items.get(buddyLayoutKey)).toBe("panel");
  expect(bubble.escape()).toBe(true);
  expect(last()?.layout).toBe("closed");
  expect(bubble.escape()).toBe(false);
});

test("the frame resizes or closes a window the person opened; it never opens one, and a refused message changes nothing", () => {
  const { bubble, last, fromFrame, log, frame } = fakeBubble();
  bubble.update();
  // Before the first click there is no frame to hear.
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "panel" });
  expect(last()?.layout).toBe("closed");
  bubble.toggle();
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "closed" });
  expect(last()?.layout).toBe("closed");
  const drawn = log.drawn.length;
  // Closed: no request opens it.
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "panel" });
  fromFrame({ type: "lazurio.buddy.layout", v: 1, mode: "fullscreen" });
  expect(log.drawn.length).toBe(drawn);
  bubble.toggle();
  for (const refused of [
    // Another origin, another window, another shape.
    () =>
      fromFrame(
        { type: "lazurio.buddy.layout", v: 1, mode: "fullscreen" },
        "https://buddy.bob.lazurio.io",
      ),
    () =>
      bubble.receive({
        data: { type: "lazurio.buddy.layout", v: 1, mode: "fullscreen" },
        origin: buddy,
        source: windowOf([]),
      }),
    () => fromFrame({ type: "lazurio.buddy.layout", v: 2, mode: "fullscreen" }),
    () =>
      fromFrame({
        type: "lazurio.buddy.layout",
        v: 1,
        mode: "fullscreen",
        width: 2000,
      }),
  ]) {
    refused();
    expect(last()?.layout).toBe("panel");
  }
  expect(frame).toBeDefined();
});

test("ready brings the context; it follows the page's changes without repeating itself", () => {
  const { bubble, page, fromFrame, contexts } = fakeBubble();
  bubble.update();
  bubble.toggle();
  // Nothing before the frame says it is ready.
  bubble.changed();
  expect(contexts()).toEqual([]);
  fromFrame({ type: "lazurio.buddy.ready", v: 1 });
  expect(contexts()).toEqual([
    expect.objectContaining({ app: "chat", page: { path: "/files" } }),
  ]);
  bubble.changed();
  bubble.update();
  expect(contexts().length).toBe(1);
  page.path = "/settings/general";
  page.active = "settings";
  bubble.changed();
  expect(contexts().at(-1)).toEqual(
    expect.objectContaining({
      app: "settings",
      page: { path: "/settings/general" },
    }),
  );
  // The frame loaded again (a sign-in): it hears the context anew.
  fromFrame({ type: "lazurio.buddy.ready", v: 1 });
  expect(contexts().length).toBe(3);
});

test("the guide's last step is in the context until the page's path changes", () => {
  const { bubble, page, fromFrame, contexts } = fakeBubble();
  bubble.update();
  bubble.toggle();
  fromFrame({ type: "lazurio.buddy.ready", v: 1 });
  bubble.guideShown("files", 0);
  expect(contexts().at(-1)).toEqual(
    expect.objectContaining({ guide: { explainer: "files", step: 1 } }),
  );
  bubble.guideShown("files", 2);
  expect(contexts().at(-1)).toEqual(
    expect.objectContaining({ guide: { explainer: "files", step: 3 } }),
  );
  page.path = "/integrations";
  bubble.changed();
  expect(contexts().at(-1)).toEqual(
    expect.objectContaining({ guide: null, page: { path: "/integrations" } }),
  );
});

test("the frame asks for an explanation: the window steps aside while it plays, the frame hears started and done, the window returns", () => {
  const { bubble, last, fromFrame, log, page } = fakeBubble();
  bubble.update();
  bubble.toggle();
  fromFrame({ type: "lazurio.guide.play", v: 1, explainer: "files" });
  expect(log.played).toEqual(["files"]);
  expect(last()?.layout).toBe("closed");
  const started: GuideEvent = { type: "started", explainer: "files" };
  bubble.guided(started);
  page.playing = null;
  bubble.guided({ type: "done", explainer: "files" });
  expect(last()?.layout).toBe("panel");
  expect(log.focus.at(-1)).toBe("frame");
  const replies = log.posted
    .map(({ message, target }) => ({ message, target }))
    .filter(({ message }) =>
      (message as { type: string }).type.startsWith("lazurio.guide."),
    );
  expect(replies).toEqual([
    {
      message: {
        type: "lazurio.guide.started",
        v: 1,
        explainer: "files",
        kind: "work",
      },
      target: buddy,
    },
    {
      message: {
        type: "lazurio.guide.done",
        v: 1,
        explainer: "files",
        kind: "work",
      },
      target: buddy,
    },
  ]);
  // A "?" of the page is not the frame's: it hears nothing of it.
  const before = log.posted.length;
  bubble.guided({ type: "started", explainer: "vault" });
  bubble.guided({ type: "closed", explainer: "vault" });
  expect(log.posted.length).toBe(before);
});

test("an explanation asked while another plays or Začínáme comes first answers busy; a hidden frame asks nothing", () => {
  const busy = fakeBubble({ tour: true });
  busy.bubble.update();
  busy.bubble.toggle();
  busy.fromFrame({ type: "lazurio.guide.play", v: 1, explainer: "files" });
  expect(busy.log.played).toEqual([]);
  expect(busy.last()?.layout).toBe("panel");
  expect(busy.log.posted.map(({ message }) => message)).toEqual([
    { type: "lazurio.guide.busy", v: 1, explainer: "files", kind: "work" },
  ]);
  const hidden = fakeBubble();
  hidden.bubble.update();
  hidden.bubble.toggle();
  hidden.bubble.toggle();
  hidden.fromFrame({ type: "lazurio.guide.play", v: 1, explainer: "files" });
  expect(hidden.log.played).toEqual([]);
  expect(hidden.log.posted).toEqual([]);
  // An explanation that does not play brings the window straight back.
  const none = fakeBubble({ plays: false });
  none.bubble.update();
  none.bubble.toggle();
  none.fromFrame({ type: "lazurio.guide.play", v: 1, explainer: "files" });
  expect(none.last()?.layout).toBe("panel");
});

test("the person takes over while an explanation plays: the frame still hears its end, the window does not return by itself", () => {
  const { bubble, last, fromFrame, log } = fakeBubble();
  bubble.update();
  bubble.toggle();
  fromFrame({ type: "lazurio.guide.play", v: 1, explainer: "files" });
  bubble.guided({ type: "started", explainer: "files" });
  bubble.toggle();
  expect(last()?.layout).toBe("panel");
  bubble.toggle();
  bubble.guided({ type: "closed", explainer: "files" });
  expect(last()?.layout).toBe("closed");
  expect(
    log.posted.map(({ message }) => (message as { type: string }).type),
  ).toEqual(["lazurio.guide.started", "lazurio.guide.closed"]);
});

test("another origin is another frame; without one the bubble is gone", () => {
  const { bubble, page, last } = fakeBubble();
  bubble.update();
  bubble.toggle();
  expect(last()?.frame?.src).toBe(`${buddy}/`);
  page.origin = "https://buddy.bob.lazurio.io";
  bubble.update();
  expect(last()).toEqual(
    expect.objectContaining({
      origin: "https://buddy.bob.lazurio.io",
      frame: null,
      layout: "closed",
    }),
  );
  page.origin = null;
  bubble.update();
  expect(last()).toBeNull();
});

// ---- The guide with Buddy's bubble ----------------------------------------

test("with Buddy's bubble a fork's page knows the principles, listens to no '?' and invites nobody to get a Buddy", () => {
  let shows = false;
  const counts = { listening: 0, following: 0 };
  const drawn: { view: GuideView; actions: GuideActions }[] = [];
  const guide = createGuide({
    shell: () => shellOf("work"),
    copy: shellMessages,
    follow: () => {
      counts.following += 1;
      return () => {
        counts.following -= 1;
      };
    },
    listenHelp: () => {
      counts.listening += 1;
      return () => {
        counts.listening -= 1;
      };
    },
    layer: () => ({
      draw(view, actions) {
        if (view !== null) drawn.push({ view, actions });
      },
      say() {},
    }),
    announce: () => undefined,
    buddy: () => shows,
  });
  guide.attach({ getAttribute: () => null });
  expect(guide.known()).toEqual([]);
  expect(guide.play("buddy", null)).toBe(false);
  shows = true;
  guide.changed();
  expect(guide.known()).toEqual(principleIds);
  expect(counts).toEqual({ listening: 0, following: 1 });
  expect(guide.play("buddy", null)).toBe(true);
  expect(guide.attention.playing()).toBe("buddy");
  // At its last step, nobody is asked to get the Buddy who is here.
  drawn.at(-1)?.actions.step(9);
  const end = drawn.at(-1)?.view;
  expect(end?.stop).toBe((end?.explanation.steps.length ?? 0) - 1);
  expect(end?.invite).toBeNull();
  // The tour's wish is readable for the frame's `busy`.
  guide.attention.tour(true);
  expect(guide.attention.tourWants()).toBe(true);
  // The bubble gone: the engine lets go of the page.
  shows = false;
  guide.changed();
  expect(guide.known()).toEqual([]);
  expect(counts).toEqual({ listening: 0, following: 0 });
  expect(guide.attention.playing()).toBeNull();
});

// ---- The element ------------------------------------------------------------

test("<lazurio-buddy> makes its shadow root only through the guide's layer or the bubble's view, and the view frames with exactly the model's attributes", async () => {
  const elements = await readFile("src/shell/elements.ts", "utf8");
  const view = await readFile("src/shell/buddy-element.ts", "utf8");
  const element = elements.slice(
    elements.indexOf("export class LazurioBuddy"),
    elements.indexOf("/** Whether the nearest ancestor"),
  );
  expect(element).not.toContain("attachShadow");
  expect(element).toContain("createBuddyBubbleView(this");
  // The view is made only for a model to draw.
  expect(element).toMatch(
    /if \(model !== null\)\s+this\.view \?\?= createBuddyBubbleView/,
  );
  for (const attribute of ["sandbox", "referrerpolicy", "allow"])
    expect(view).toContain(
      `made.setAttribute("${attribute}", model.frame.${attribute});`,
    );
  expect(view).toContain("made.src = model.frame.src;");
  expect(view).not.toContain("credentialless");
});
