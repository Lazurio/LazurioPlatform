import { describe, expect, test } from "bun:test";
import { viewEnvironmentId } from "../src/browser/contract/pure";
import {
  parseShell,
  parseShellAccount,
  type Shell,
  type ShellAccount,
} from "../src/shell/contract";
import {
  acceptIdentityReply,
  createIdentityResponder,
  identityJson,
  identityMessage,
  identityRequestOf,
  maxIdentityFrames,
  parseEmbeddedIdentity,
  parseEnvironmentIdentity,
} from "../src/shell/identity-protocol";
import { mergeAccount } from "../src/shell/merge";
import { shellMessages } from "../src/shell/messages";
import { createShellState } from "../src/shell/state";
import {
  columnHead,
  type EnvironmentIdentity,
  elementIdentity,
  environmentIdentity,
  identityText,
  titleWithIdentity,
  viewIdentity,
} from "../src/shell/view";

// F39's addendum of 2026-10-12: Matěj asked that the switcher and the bar of
// the Environment browser's view never name one Environment two ways. One
// pure function names an Environment (`environmentIdentity`), the column
// head's picker and `<lazurio-environment>` draw it, the shell on an app's
// page answers a framed view with it, and the view takes the answer only
// from its parent about its own Environment. Example names only.

const cs = shellMessages("cs");
const en = shellMessages("en");
const avatar = "https://avatars.githubusercontent.com/u/4242?v=4";

const apps = (base: string) => ({
  apps: `https://launchpad.${base}.lazurio.io/`,
  chat: `https://t3code.${base}.lazurio.io/`,
  automate: null,
});

// Jana's view of the Acme Organization: her work Environment (the page's
// own), her personal one, a Team's and an Automated persona's.
const acmeDocument = (extra: Readonly<Record<string, unknown>> = {}) => ({
  schema: "lazurio.shell.v1",
  locale: "cs",
  current: "vm-01.acme",
  operator: { initials: "JA", login: "jana", avatar: null },
  environments: [
    {
      id: "vm-01.acme",
      label: null,
      kind: "work",
      organizations: ["acme"],
      assignee: "jana",
      apps: apps("vm-01.acme"),
    },
    {
      id: "jana",
      label: null,
      kind: "personal",
      organizations: [],
      assignee: null,
      apps: apps("jana"),
    },
    {
      id: "vm-02.acme",
      label: "Team Sales",
      kind: "team",
      organizations: ["acme"],
      assignee: null,
      apps: apps("vm-02.acme"),
    },
    {
      id: "vm-03.acme",
      label: "Steward",
      kind: "automated",
      organizations: ["acme"],
      assignee: null,
      apps: apps("vm-03.acme"),
    },
  ],
  organizations: [
    {
      slug: "acme",
      name: "Acme Works",
      avatar,
      dashboard: "https://dashboard.lazurio.ai/orgs/acme",
    },
  ],
  dashboard: "https://dashboard.lazurio.ai/home",
  account: "https://dashboard.lazurio.ai/settings/account",
  addOrganization: null,
  ...extra,
});

const parsed = (value: unknown): Shell => {
  const shell = parseShell(value);
  if (shell === null) throw new Error("The fixture is a shell document");
  return shell;
};

// The person's account as the Dashboard words it: a rename of the work
// Environment, and a second work Environment the page does not know.
const accountOf = (locale: "cs" | "en"): ShellAccount => {
  const account = parseShellAccount({
    schema: "lazurio.account.v1",
    locale,
    operator: { initials: "JA", login: "jana", avatar: null },
    environments: [
      {
        id: "vm-01.acme",
        label: null,
        kind: "work",
        organizations: ["acme"],
        assignee: "jana",
        apps: apps("vm-01.acme"),
        name: "Prodej",
        who: "Jana a Petr",
      },
      {
        id: "vm-04.acme",
        label: null,
        kind: "work",
        organizations: ["acme"],
        assignee: "petr",
        apps: apps("vm-04.acme"),
      },
    ],
    organizations: [
      {
        slug: "acme",
        name: "Acme Works",
        avatar,
        dashboard: "https://dashboard.lazurio.ai/orgs/acme",
      },
    ],
  });
  if (account === null) throw new Error("The fixture is an account");
  return account;
};

const acmeMark = {
  kind: "avatar",
  organization: "Acme Works",
  avatar,
  initials: "AW",
} as const;

describe("one identity names an Environment", () => {
  test("a work Environment: its Organization's mark, its kind's name and its person", () => {
    const shell = parsed(acmeDocument());
    expect(environmentIdentity(shell, "vm-01.acme", cs)).toEqual({
      id: "vm-01.acme",
      name: "Pracovní",
      who: "@jana",
      glyph: acmeMark,
    });
    expect(environmentIdentity(shell, "vm-01.acme", en)?.name).toBe("Work");
  });

  test("a personal Environment: your initials, never an Organization", () => {
    const shell = parsed(acmeDocument());
    expect(environmentIdentity(shell, "jana", cs)).toEqual({
      id: "jana",
      name: "Osobní",
      who: "jen vaše",
      glyph: { kind: "initials", text: "JA" },
    });
    // Without the person's initials, the kind's icon.
    const anonymous = parsed(
      acmeDocument({ operator: { initials: null, login: null, avatar: null } }),
    );
    expect(environmentIdentity(anonymous, "jana", en)?.glyph).toEqual({
      kind: "icon",
      icon: "user",
    });
  });

  test("a Team's and an Automated persona's: their own name in their Organization's mark", () => {
    const shell = parsed(acmeDocument());
    expect(environmentIdentity(shell, "vm-02.acme", cs)).toEqual({
      id: "vm-02.acme",
      name: "Team Sales",
      who: "sdílené Teamem",
      glyph: acmeMark,
    });
    expect(environmentIdentity(shell, "vm-03.acme", en)).toEqual({
      id: "vm-03.acme",
      name: "Steward",
      who: "automation",
      glyph: acmeMark,
    });
  });

  test("a workstation: its computer and the laptop, in the space it stands in, or the space a page names", () => {
    const shell = parsed(
      acmeDocument({
        current: "local",
        environments: [
          {
            id: "local",
            label: "Studio",
            kind: "workstation",
            organizations: ["acme"],
            assignee: null,
            apps: { apps: "/", chat: null, automate: null },
          },
        ],
      }),
    );
    expect(environmentIdentity(shell, "local", cs)).toEqual({
      id: "local",
      name: "Studio",
      who: "tento počítač",
      glyph: { kind: "icon", icon: "laptop" },
    });
    // Opened for one Organization (`space`), its mark.
    expect(environmentIdentity(shell, "local", cs, "acme")?.glyph).toEqual(
      acmeMark,
    );
  });

  test("an Environment the document does not list has none", () => {
    const shell = parsed(acmeDocument());
    expect(environmentIdentity(shell, "vm-09.acme", cs)).toBeNull();
    expect(environmentIdentity(shell, "", cs)).toBeNull();
  });

  test("the person's account renames it through the merge, in its language only, and names Environments the page does not know", () => {
    const local = parsed(acmeDocument());
    const merged = mergeAccount(local, accountOf("cs"));
    expect(environmentIdentity(merged, "vm-01.acme", cs)).toEqual({
      id: "vm-01.acme",
      name: "Prodej",
      who: "Jana a Petr",
      glyph: acmeMark,
    });
    expect(environmentIdentity(merged, "vm-04.acme", cs)).toEqual({
      id: "vm-04.acme",
      name: "Pracovní",
      who: "@petr",
      glyph: acmeMark,
    });
    // An account in another language keeps the kind's words.
    const other = mergeAccount(local, accountOf("en"));
    expect(environmentIdentity(other, "vm-01.acme", cs)?.name).toBe("Pracovní");
    // Without the account, the page does not know the other one.
    expect(environmentIdentity(local, "vm-04.acme", cs)).toBeNull();
  });

  test("the column head's picker is the current Environment's identity", () => {
    for (const shell of [
      parsed(acmeDocument()),
      mergeAccount(parsed(acmeDocument()), accountOf("cs")),
    ])
      for (const copy of [cs, en])
        expect(
          columnHead(shell, copy, {
            space: null,
            active: "apps",
            settings: null,
          })?.picker,
        ).toEqual(environmentIdentity(shell, "vm-01.acme", copy) ?? undefined);
  });

  test("a page's title comes first, then its Environment in words, so a tab strip tells pages apart", () => {
    const shell = parsed(acmeDocument());
    const identity = environmentIdentity(shell, "vm-01.acme", cs);
    expect(titleWithIdentity("Inbox (3)", identity)).toBe(
      "Inbox (3) — Acme Works · Pracovní · @jana",
    );
    expect(titleWithIdentity("", identity)).toBe(
      "Acme Works · Pracovní · @jana",
    );
    expect(titleWithIdentity("Inbox (3)", null)).toBe("Inbox (3)");
    expect(titleWithIdentity("", null)).toBe("");
  });

  test("in words: the Organization of its mark, its name and who it is for", () => {
    const shell = parsed(acmeDocument());
    const identity = (id: string) => {
      const found = environmentIdentity(shell, id, cs);
      if (found === null) throw new Error("listed");
      return found;
    };
    expect(identityText(identity("vm-01.acme"))).toBe(
      "Acme Works · Pracovní · @jana",
    );
    expect(identityText(identity("jana"))).toBe("Osobní · jen vaše");
    // An Organization's Dashboard names it once.
    expect(
      identityText({ glyph: acmeMark, name: "Acme Works", who: "Dashboard" }),
    ).toBe("Acme Works · Dashboard");
  });
});

describe("<lazurio-environment>'s attributes", () => {
  test("`environment` names an Environment by its id, in any case; absent or empty, the page's own", () => {
    const shell = parsed(acmeDocument());
    const own = environmentIdentity(shell, "vm-01.acme", cs);
    expect(elementIdentity(shell, null, null)).toEqual(own);
    expect(elementIdentity(shell, "", null)).toEqual(own);
    expect(elementIdentity(shell, "  ", null)).toEqual(own);
    expect(elementIdentity(shell, "VM-02.Acme ", null)?.id).toBe("vm-02.acme");
    expect(elementIdentity(shell, "jana", null)?.name).toBe("Osobní");
  });

  test("`lang` picks the words, else the document's language", () => {
    const shell = parsed(acmeDocument());
    expect(elementIdentity(shell, "vm-02.acme", "en")?.who).toBe(
      "shared by the Team",
    );
    expect(elementIdentity(shell, "vm-02.acme", "de")?.who).toBe(
      "sdílené Teamem",
    );
  });

  test("`space` is the page's space as its column head reads it: on a workstation opened for one Organization both name it alike", () => {
    // Pablo's review of #339: the column head named it in the page's space,
    // the element in the Environment's own.
    const shell = parsed(
      acmeDocument({
        current: "local",
        environments: [
          {
            id: "local",
            label: "Studio",
            kind: "workstation",
            organizations: ["acme"],
            assignee: null,
            apps: { apps: "/", chat: null, automate: null },
          },
        ],
      }),
    );
    // On an Environment's page the picker is an identity (`columnHead`).
    const head = (space: string | null) =>
      columnHead(shell, cs, { space, active: "apps", settings: null })
        ?.picker as EnvironmentIdentity | undefined;
    expect(head("acme")?.glyph).toEqual(acmeMark);
    for (const space of ["acme", "personal", "nope", null])
      expect(elementIdentity(shell, null, "cs", space)).toEqual(
        head(space) ?? null,
      );
    // Without the page's space, the element names it in its own space.
    expect(elementIdentity(shell, "local", "cs")?.glyph).toEqual({
      kind: "icon",
      icon: "laptop",
    });
    // Another Environment stands in its own space whatever the page's is.
    const hosted = parsed(acmeDocument());
    expect(elementIdentity(hosted, "vm-02.acme", "cs", "personal")).toEqual(
      environmentIdentity(hosted, "vm-02.acme", cs),
    );
  });

  test("nothing for a value that is no id, an unknown Environment, or a page of no Environment without one", () => {
    const shell = parsed(acmeDocument());
    for (const value of [
      "vm-09.acme",
      "https://browser.vm-01.acme.lazurio.io",
      "a.b.c",
      "-bad",
      "vm_01.acme",
    ])
      expect(elementIdentity(shell, value, null)).toBeNull();
    const dashboard = parsed(acmeDocument({ current: null }));
    expect(elementIdentity(dashboard, null, null)).toBeNull();
    expect(elementIdentity(dashboard, "vm-01.acme", null)?.name).toBe(
      "Pracovní",
    );
  });
});

describe("the identity on the wire and in the view's page", () => {
  const all = (shell: Shell) =>
    shell.environments.map((entry) => {
      const found = environmentIdentity(shell, entry.id, cs);
      if (found === null) throw new Error("listed");
      return found;
    });

  test("every identity reads back as itself, from JSON and from the page", () => {
    for (const identity of all(parsed(acmeDocument()))) {
      expect(
        parseEnvironmentIdentity(JSON.parse(JSON.stringify(identity))),
      ).toEqual(identity);
      expect(parseEmbeddedIdentity(identityJson(identity))).toEqual(identity);
    }
    // A later version's members are ignored.
    const [work] = all(parsed(acmeDocument()));
    if (work === undefined) throw new Error("listed");
    expect(parseEnvironmentIdentity({ ...work, more: 1 })).toEqual(work);
  });

  test("the page's JSON ends and opens nothing, whatever a name says", () => {
    const identity: EnvironmentIdentity = {
      id: "vm-01.acme",
      name: "</script><script>alert(1)</script>",
      who: "a\u2028b\u2029c",
      glyph: { kind: "initials", text: "<!" },
    };
    const text = identityJson(identity);
    expect(text).not.toContain("<");
    expect(text).not.toContain("\u2028");
    expect(text).not.toContain("\u2029");
    expect(parseEmbeddedIdentity(text)).toEqual(identity);
    for (const broken of [undefined, null, "", "{", "null", "[]"])
      expect(parseEmbeddedIdentity(broken)).toBeNull();
  });

  test("only display words, an https avatar and a known glyph", () => {
    const work = {
      id: "vm-01.acme",
      name: "Pracovní",
      who: "@jana",
      glyph: acmeMark,
    };
    expect(parseEnvironmentIdentity(work)).toEqual(work);
    const refused: unknown[] = [
      null,
      "Pracovní",
      { ...work, id: "VM-01.acme" },
      { ...work, id: "a.b.c" },
      { ...work, name: "" },
      { ...work, name: "x".repeat(129) },
      { ...work, who: "line\nbreak" },
      { ...work, glyph: null },
      { ...work, glyph: { ...acmeMark, avatar: "http://example.com/a.png" } },
      { ...work, glyph: { ...acmeMark, avatar: "javascript:alert(1)" } },
      { ...work, glyph: { ...acmeMark, avatar: `${avatar}#x` } },
      { ...work, glyph: { ...acmeMark, initials: "TOO-LONG!" } },
      { ...work, glyph: { kind: "icon", icon: "skull" } },
      { ...work, glyph: { kind: "initials", text: "" } },
      { ...work, glyph: { kind: "picture", src: avatar } },
    ];
    for (const value of refused)
      expect(parseEnvironmentIdentity(value)).toBeNull();
    expect(
      parseEnvironmentIdentity({
        ...work,
        glyph: { ...acmeMark, avatar: null },
      })?.glyph,
    ).toEqual({ ...acmeMark, avatar: null });
  });
});

// The host's side, with fake windows: `self` is the page's window, a frame's
// window has it as its parent.
const fakeFrame = (parent: unknown) => {
  const posted: [unknown, string][] = [];
  const frame = {
    parent,
    closed: false,
    postMessage: (message: unknown, targetOrigin: string) => {
      posted.push([message, targetOrigin]);
    },
  };
  return { frame, posted };
};
const view = "https://browser.vm-01.acme.lazurio.io";
const ask = { type: identityMessage.request };
// The host's answer as the contract writes it, of v1 (F50 point 3).
const reply = (identity: EnvironmentIdentity | null) => ({
  type: identityMessage.reply,
  v: 1,
  identity,
});

describe("the host answers its own frames on a view's origin", () => {
  test("a view's origin names its Environment; any other origin none", () => {
    expect(viewEnvironmentId(view)).toBe("vm-01.acme");
    expect(viewEnvironmentId("https://browser.jana.lazurio.io")).toBe("jana");
    for (const origin of [
      "https://t3code.vm-01.acme.lazurio.io",
      "https://launchpad.jana.lazurio.io",
      "http://browser.vm-01.acme.lazurio.io",
      "https://browser.vm-01.acme.lazurio.io:8443",
      "https://browser.a.b.acme.lazurio.io",
      "https://browser.vm-01.acme.example.com",
      "https://browser.lazurio.io",
      "null",
      "",
    ])
      expect(viewEnvironmentId(origin)).toBeNull();
  });

  test("a request counts only from a frame of this page on a view's origin", () => {
    const self = {};
    const { frame } = fakeFrame(self);
    const request = (source: unknown, origin = view, data: unknown = ask) =>
      identityRequestOf({ data, origin, source }, self);
    expect(request(frame)).toBe("vm-01.acme");
    // Another window's frame, the page itself, a port, nothing.
    expect(request(fakeFrame({}).frame)).toBeNull();
    expect(request(self)).toBeNull();
    expect(request({ postMessage: () => {} })).toBeNull();
    expect(request(null)).toBeNull();
    // A frame whose parent cannot be read is no frame of this page.
    const guarded = {
      get parent(): unknown {
        throw new Error("SecurityError");
      },
    };
    expect(request(guarded)).toBeNull();
    // Another origin, another message.
    expect(request(frame, "https://t3code.vm-01.acme.lazurio.io")).toBeNull();
    expect(request(frame, view, { type: "lazurio-browser:info" })).toBeNull();
    expect(request(frame, view, "lazurio-browser:identity-request")).toBeNull();
  });

  test("it answers at once, to exactly the frame's origin, with what the page knows, and again whenever that changes", () => {
    const self = {};
    let known: Shell | null = null;
    let requested = 0;
    const responder = createIdentityResponder({
      self,
      identity: (environment) =>
        known === null ? null : environmentIdentity(known, environment, cs),
      request: () => {
        requested += 1;
      },
    });
    const { frame, posted } = fakeFrame(self);
    // Before the page's document arrives: none, and the page reads it.
    responder.receive({ data: ask, origin: view, source: frame });
    expect(requested).toBe(1);
    expect(posted).toEqual([[reply(null), view]]);
    // The document arrives: the frame hears the identity.
    known = parsed(acmeDocument());
    responder.changed();
    const first = environmentIdentity(known, "vm-01.acme", cs);
    expect(posted.at(-1)).toEqual([reply(first), view]);
    // A change that does not change the answer sends nothing.
    responder.changed();
    expect(posted).toHaveLength(2);
    // The account arrives later and renames it: the frame hears that too.
    known = mergeAccount(known, accountOf("cs"));
    responder.changed();
    expect(posted.at(-1)).toEqual([
      reply(environmentIdentity(known, "vm-01.acme", cs)),
      view,
    ]);
    expect(posted.every(([, origin]) => origin === view)).toBe(true);
    // A new page in the frame asks again and hears it anew.
    responder.receive({ data: ask, origin: view, source: frame });
    expect(posted).toHaveLength(4);
    expect(posted.at(-1)?.[0]).toEqual(posted.at(-2)?.[0]);
    // Nothing for a frame of another page or a message of another kind.
    const stranger = fakeFrame({});
    responder.receive({ data: ask, origin: view, source: stranger.frame });
    responder.receive({ data: { type: "x" }, origin: view, source: frame });
    expect(stranger.posted).toEqual([]);
    expect(posted).toHaveLength(4);
  });

  test("an Environment the page does not know is answered with none; a closed frame is forgotten", () => {
    const self = {};
    let known = parsed(acmeDocument());
    const responder = createIdentityResponder({
      self,
      identity: (environment) => environmentIdentity(known, environment, cs),
      request: () => {},
    });
    const foreign = fakeFrame(self);
    const origin = "https://browser.vm-04.acme.lazurio.io";
    responder.receive({ data: ask, origin, source: foreign.frame });
    expect(foreign.posted).toEqual([[reply(null), origin]]);
    foreign.frame.closed = true;
    known = mergeAccount(known, accountOf("cs"));
    responder.changed();
    expect(foreign.posted).toHaveLength(1);
  });

  test("at most a bounded number of frames are kept, the earliest first to go", () => {
    const self = {};
    let name = "Pracovní";
    const responder = createIdentityResponder({
      self,
      identity: (id) => ({
        id,
        name,
        who: "@jana",
        glyph: { kind: "icon", icon: "user" },
      }),
      request: () => {},
    });
    const frames = Array.from({ length: maxIdentityFrames + 1 }, () =>
      fakeFrame(self),
    );
    for (const { frame } of frames)
      responder.receive({ data: ask, origin: view, source: frame });
    name = "Prodej";
    responder.changed();
    expect(frames[0]?.posted).toHaveLength(1);
    expect(frames.slice(1).every(({ posted }) => posted.length === 2)).toBe(
      true,
    );
  });

  test("wired to the shell's state, the answer follows the account the host provides later", () => {
    const self = {};
    const state = createShellState({
      source: () => "host",
      read: async () => null,
      report: () => undefined,
      store: null,
      log: () => undefined,
    });
    const responder = createIdentityResponder({
      self,
      identity: (environment) => {
        const shell = state.drawn();
        return shell === null
          ? null
          : environmentIdentity(
              shell,
              environment,
              shellMessages(shell.locale),
            );
      },
      request: () => state.requestAccount(),
    });
    state.listen(() => responder.changed());
    const { frame, posted } = fakeFrame(self);
    responder.receive({ data: ask, origin: view, source: frame });
    state.provideShell(parsed(acmeDocument()));
    state.provideAccount(accountOf("cs"));
    expect(
      posted.map(([message]) => (message as ReturnType<typeof reply>).identity),
    ).toEqual([
      null,
      environmentIdentity(parsed(acmeDocument()), "vm-01.acme", cs),
      environmentIdentity(
        mergeAccount(parsed(acmeDocument()), accountOf("cs")),
        "vm-01.acme",
        cs,
      ),
    ]);
  });
});

describe("the answer names a view's Environment as the column heads of its apps do", () => {
  test("for each hosted kind, merged or not, in every space its pages stand in; a workstation, which has no view, never", () => {
    const head = (shell: Shell, space: string | null) =>
      columnHead(shell, cs, { space, active: "apps", settings: null })
        ?.picker as EnvironmentIdentity | undefined;
    for (const merged of [false, true])
      for (const [id, space] of [
        ["vm-01.acme", "acme"],
        ["vm-02.acme", "acme"],
        ["vm-03.acme", "acme"],
        ["jana", "personal"],
      ] as const) {
        const page = parsed({ ...acmeDocument(), current: id });
        const shell = merged ? mergeAccount(page, accountOf("cs")) : page;
        // The Launchpad of a hosted Environment names no space, or its own.
        for (const named of [null, space])
          expect([id, named, viewIdentity(shell, id, cs)]).toEqual([
            id,
            named,
            head(shell, named) ?? null,
          ]);
      }
    // A workstation opened for one Organization: its column head shows that
    // Organization's mark, and no view is ever answered as the computer, so
    // a person's own Environment that reads as `local` is never named so.
    const studio = parsed(
      acmeDocument({
        current: "local",
        environments: [
          {
            id: "local",
            label: "Studio",
            kind: "workstation",
            organizations: ["acme"],
            assignee: null,
            apps: { apps: "/", chat: null, automate: null },
          },
        ],
      }),
    );
    expect(viewIdentity(studio, "local", cs)).toBeNull();
    expect(viewEnvironmentId("https://browser.local.lazurio.io")).toBe("local");
    const self = {};
    const responder = createIdentityResponder({
      self,
      identity: (environment) => viewIdentity(studio, environment, cs),
      request: () => {},
    });
    const { frame, posted } = fakeFrame(self);
    responder.receive({
      data: ask,
      origin: "https://browser.local.lazurio.io",
      source: frame,
    });
    expect(posted).toEqual([[reply(null), "https://browser.local.lazurio.io"]]);
    // On a hosted page the whole path, request to answer, is the column head's.
    const hosted = parsed(acmeDocument());
    const answering = createIdentityResponder({
      self,
      identity: (environment) => viewIdentity(hosted, environment, cs),
      request: () => {},
    });
    const second = fakeFrame(self);
    answering.receive({ data: ask, origin: view, source: second.frame });
    expect(second.posted).toEqual([
      [reply(head(hosted, "acme") ?? null), view],
    ]);
  });
});

describe("the view takes an answer only from its parent about its own Environment", () => {
  const shell = parsed(acmeDocument());
  const own = environmentIdentity(shell, "vm-01.acme", cs);
  const parentOrigin = "https://t3code.jana.lazurio.io";
  const accept = (
    data: unknown,
    options: {
      origin?: string;
      fromParent?: boolean;
      ancestor?: string | null;
      own?: string | null;
    } = {},
  ) =>
    acceptIdentityReply(
      {
        data,
        origin: options.origin ?? parentOrigin,
        fromParent: options.fromParent ?? true,
      },
      options.ancestor === undefined ? parentOrigin : options.ancestor,
      options.own === undefined ? "vm-01.acme" : options.own,
    );

  test("from the parent on the origin the browser names, about this Environment or none", () => {
    expect(accept(reply(own))).toEqual({ identity: own, majors: null });
    expect(accept(reply(null))).toEqual({ identity: null, majors: null });
    expect(accept(reply(own), { fromParent: false })).toBeNull();
    expect(
      accept(reply(own), { origin: "https://t3code.vm-01.acme.lazurio.io" }),
    ).toBeNull();
    // About another Environment, or this view cannot tell its own.
    expect(
      accept(reply(environmentIdentity(shell, "vm-02.acme", cs))),
    ).toBeNull();
    expect(accept(reply(own), { own: null })).toBeNull();
    expect(accept(reply(null), { own: null })).toEqual({
      identity: null,
      majors: null,
    });
    // Anything else.
    for (const data of [
      null,
      "x",
      { type: identityMessage.request },
      { type: identityMessage.reply },
      { type: identityMessage.reply, identity: { id: "vm-01.acme" } },
      { type: "lazurio-browser:info", identity: own },
    ])
      expect(accept(data)).toBeNull();
  });

  test("where the browser names no parent, only from an app origin of an Environment", () => {
    for (const ancestor of [null, "null"]) {
      expect(accept(reply(own), { ancestor })).toEqual({
        identity: own,
        majors: null,
      });
      expect(
        accept(reply(own), {
          ancestor,
          origin: "https://launchpad.vm-01.acme.lazurio.io",
        }),
      ).toEqual({ identity: own, majors: null });
      for (const origin of [
        "https://evil.example",
        "http://t3code.jana.lazurio.io",
        "https://t3code.jana.lazurio.io:8443",
        "https://lazurio.io",
        "null",
      ])
        expect(accept(reply(own), { ancestor, origin })).toBeNull();
    }
  });
});
