import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageRoute } from "../src/launchpad/routes";
import { runTool } from "../src/tools/status";
import { contract } from "./fixtures/contract";
import {
  captureConsole,
  composioCalls,
  connectionsWorld,
  type FakeAccount,
  type FakeComposioState,
  fakeCatalog,
  keyCanary,
  setAccountStatus,
  worldLaunchpad,
} from "./fixtures/fake-connections";

// The connected-apps page's routes (decision F42, proposed,
// docs/connected-apps.md sections 2–6 and 9): a Launchpad on a workstation
// Folder whose tools environment holds a fake `composio` 0.4.x in a private
// home. RED BY DESIGN: every `contract` test fails until its slice lands
// (section 15); the fixture test proves the fake answers as the CLI does.

const posix = test.skipIf(process.platform === "win32");

type Account = { account: string; name: string | null; state: string };
type Connections = {
  kind: string;
  mode: string;
  space: { kind: string };
  capabilities: { disconnect: boolean };
  apps: { toolkit: string; name: string; accounts: Account[] }[];
};

const account = (
  id: string,
  toolkit: string,
  status: string,
  alias: string | null,
): FakeAccount => ({ id, toolkit, status, alias, word_id: `word-${id}` });
const work = account("ca_1", "gmail", "ACTIVE", "práce");
const invoices = account("ca_2", "gmail", "EXPIRED", "faktury");

async function launchpad(composio: Partial<FakeComposioState> = {}) {
  const parent = await realpath(
    await mkdtemp(join(tmpdir(), "connections-routes-")),
  );
  const world = await connectionsWorld(parent, { composio });
  const launchpad = await worldLaunchpad(parent, world, "cs");
  return {
    ...world,
    ...launchpad,
    async close() {
      await launchpad.close();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

const accountsOf = (body: Connections, toolkit: string) =>
  body.apps.find((app) => app.toolkit === toolkit)?.accounts ?? [];

posix(
  "fixture: the fake composio answers as the CLI's help and source document",
  async () => {
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "connections-fixture-")),
    );
    try {
      const { home, path } = await connectionsWorld(parent, {
        composio: { accounts: [work] },
      });
      const env = { PATH: path, HOME: home };
      const run = async (...args: string[]) => {
        const result = await runTool(
          [join(path, "composio"), ...args],
          15_000,
          env,
        );
        if (result === "timeout") throw new Error("The fake timed out");
        return result;
      };
      expect(JSON.parse((await run("whoami")).stdout).email).toBe(
        "op@example.com",
      );
      // An alias in use is refused before anything exists; a second account
      // without an alias only after its link exists, which stays pending.
      const taken = await run(
        "link",
        "gmail",
        "--no-wait",
        "--no-browser",
        "--alias",
        "PRÁCE",
      );
      expect([taken.exitCode, taken.stdout]).toEqual([0, ""]);
      const unnamed = await run("link", "gmail", "--no-wait", "--no-browser");
      expect([unnamed.exitCode, unnamed.stdout]).toEqual([0, ""]);
      const linked = await run(
        "link",
        "linear",
        "--no-wait",
        "--no-browser",
        "--alias",
        "práce",
      );
      expect(JSON.parse(linked.stdout)).toEqual({
        status: "pending",
        message: "Complete authorization by opening the URL",
        connected_account_id: "ca_102",
        redirect_url: "https://connect.composio.dev/link/lk_fake102",
        toolkit: "linear",
        project_type: "CONSUMER",
      });
      // Every status, an alias only beside another account, no ids.
      expect(JSON.parse((await run("connections", "list")).stdout)).toEqual({
        gmail: [
          {
            status: "ACTIVE",
            alias: "práce",
            word_id: "word-ca_1",
            permission_group: null,
          },
          {
            status: "INITIATED",
            alias: null,
            word_id: "word101",
            permission_group: null,
          },
        ],
        linear: [
          { status: "INITIATED", word_id: "word102", permission_group: null },
        ],
      });
      // Only active accounts, with their ids.
      expect(
        JSON.parse((await run("link", "linear", "--list")).stdout),
      ).toEqual({
        toolkit: "linear",
        total: 0,
        items: [],
      });
      expect(
        JSON.parse((await run("link", "gmail", "--list")).stdout).items,
      ).toEqual([
        expect.objectContaining({
          id: "ca_1",
          alias: "práce",
          status: "ACTIVE",
        }),
      ]);
      // Without a terminal the prompt answers No; `--yes` is unknown here.
      const kept = await run("connections", "remove", "ca_1");
      expect([kept.exitCode, kept.stderr.trim()]).toEqual([
        0,
        "No connection removed.",
      ]);
      expect(
        (await run("connections", "remove", "ca_1", "--yes")).exitCode,
      ).toBe(1);
      expect(
        (await run("connections", "remove", "--help")).stdout,
      ).not.toContain("--yes");
      expect(
        JSON.parse((await run("connections", "list")).stdout).gmail,
      ).toHaveLength(2);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  30_000,
);

contract(
  "GET /api/connections/catalog lists the apps to connect: popular first, every cached app once, logos by slug, never the key",
  async () => {
    const lp = await launchpad();
    try {
      const response = await lp.get("/api/connections/catalog");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(keyCanary);
      const body = JSON.parse(text) as {
        kind: string;
        source: string;
        apps: {
          toolkit: string;
          name: string;
          description: string;
          logo: string;
          popular: boolean;
        }[];
      };
      expect(body.kind).toBe("connections-catalog");
      expect(body.source).toBe("cli-cache");
      const slugs = body.apps.map((app) => app.toolkit);
      expect(slugs[0]).toBe("gmail");
      for (const entry of fakeCatalog.filter((entry) => !entry.no_auth))
        expect(slugs.filter((slug) => slug === entry.slug)).toHaveLength(1);
      // An app that needs no connection has nothing to connect.
      expect(slugs).not.toContain("codeinterpreter");
      // Popular first, then the rest in the cache's order.
      expect(slugs.indexOf("airtable")).toBeLessThan(slugs.indexOf("aaa_tool"));
      expect(slugs.indexOf("aaa_tool")).toBeLessThan(slugs.indexOf("zzz_tool"));
      expect(body.apps.find((app) => app.toolkit === "gmail")?.popular).toBe(
        true,
      );
      expect(body.apps.find((app) => app.toolkit === "zzz_tool")?.popular).toBe(
        false,
      );
      for (const app of body.apps)
        expect(app.logo).toBe(`https://logos.composio.dev/api/${app.toolkit}`);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "GET /api/connections lists every account in one of four states, named as it was connected",
  async () => {
    const lp = await launchpad({
      accounts: [
        work,
        invoices,
        account("ca_3", "slack", "INITIATED", null),
        account("ca_4", "notion", "FAILED", null),
      ],
    });
    try {
      const response = await lp.get("/api/connections");
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(keyCanary);
      const body = JSON.parse(text) as Connections;
      expect(body).toMatchObject({
        kind: "connections",
        mode: "operator-account",
        space: { kind: "ready" },
      });
      const states = (toolkit: string) =>
        accountsOf(body, toolkit)
          .map((entry) => [entry.name, entry.state])
          .sort();
      expect(states("gmail")).toEqual([
        ["faktury", "expired"],
        ["práce", "connected"],
      ]);
      expect(states("slack")).toEqual([[null, "pending"]]);
      expect(states("notion")).toEqual([[null, "failed"]]);
      for (const app of body.apps)
        for (const entry of app.accounts)
          expect(entry.account.length).toBeGreaterThan(0);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "POST /api/connections/link starts a connection and returns Composio's link only to its caller",
  async () => {
    const logged = captureConsole();
    const lp = await launchpad();
    try {
      const response = await lp.post("/api/connections/link", {
        toolkit: "linear",
        name: "práce",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "link-pending",
        toolkit: "linear",
        url: "https://connect.composio.dev/link/lk_fake101",
      });
      expect(body.session).toMatch(/^[0-9a-f]{32}$/);
      const call = (await composioCalls(lp.home)).find(
        (args) => args[0] === "link" && args.includes("--no-wait"),
      );
      expect(call).toEqual(
        expect.arrayContaining(["linear", "--no-browser", "--alias", "práce"]),
      );
      expect(call?.[(call?.indexOf("--alias") ?? 0) + 1]).toBe("práce");
      // The link is its holder's: no other answer and no log carries it.
      expect(await (await lp.get("/api/connections")).text()).not.toContain(
        "lk_fake101",
      );
      expect(logged.text()).not.toContain("lk_fake101");
    } finally {
      logged.restore();
      await lp.close();
    }
  },
  30_000,
);

contract(
  "the page learns by polling that the account it started is connected",
  async () => {
    const lp = await launchpad();
    try {
      const started = (await (
        await lp.post("/api/connections/link", {
          toolkit: "linear",
          name: "práce",
        })
      ).json()) as { session?: string };
      const poll = async () =>
        (await (
          await lp.post("/api/connections/link/poll", {
            session: started.session,
          })
        ).json()) as { kind?: string };
      expect((await poll()).kind).toBe("link-pending");
      // The person finishes in the browser.
      await setAccountStatus(lp.home, "ca_101", "ACTIVE");
      let answer = await poll();
      for (
        let attempt = 0;
        attempt < 40 && answer.kind === "link-pending";
        attempt++
      ) {
        await Bun.sleep(250);
        answer = await poll();
      }
      expect(answer).toMatchObject({
        kind: "connected",
        toolkit: "linear",
        account: { name: "práce", state: "connected" },
      });
      const listed = (await (
        await lp.get("/api/connections")
      ).json()) as Connections;
      expect(accountsOf(listed, "linear")).toEqual([
        expect.objectContaining({ name: "práce", state: "connected" }),
      ]);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "a second account needs a name, and a taken name is refused before the CLI runs",
  async () => {
    const lp = await launchpad({ accounts: [work] });
    try {
      const unnamed = await lp.post("/api/connections/link", {
        toolkit: "gmail",
      });
      expect(unnamed.status).toBe(409);
      expect(await unnamed.json()).toMatchObject({
        kind: "blocked",
        reason: "name-required",
      });
      const taken = await lp.post("/api/connections/link", {
        toolkit: "gmail",
        name: "PRÁCE",
      });
      expect(taken.status).toBe(409);
      expect(await taken.json()).toMatchObject({
        kind: "blocked",
        reason: "name-taken",
      });
      expect(
        (await composioCalls(lp.home)).some(
          (args) => args[0] === "link" && args.includes("--no-wait"),
        ),
      ).toBe(false);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "a disconnect is refused without an explicit confirm, and without a CLI that removes without its prompt",
  async () => {
    const lp = await launchpad({ accounts: [work, invoices] });
    try {
      const listed = (await (
        await lp.get("/api/connections")
      ).json()) as Connections;
      expect(listed.capabilities).toEqual({ disconnect: false });
      const selector = accountsOf(listed, "gmail").find(
        (entry) => entry.name === "práce",
      )?.account;
      const unconfirmed = await lp.post("/api/connections/disconnect", {
        account: selector,
      });
      expect(unconfirmed.status).toBe(400);
      expect(await unconfirmed.json()).toMatchObject({
        error: "confirm-required",
      });
      const unsupported = await lp.post("/api/connections/disconnect", {
        account: selector,
        confirm: true,
      });
      expect(unsupported.status).toBe(409);
      expect(await unsupported.json()).toMatchObject({
        kind: "blocked",
        reason: "disconnect-unsupported",
      });
      // The CLI's interactive prompt is never driven.
      expect(
        (await composioCalls(lp.home)).filter(
          (args) =>
            args[0] === "connections" &&
            args[1] === "remove" &&
            !args.includes("--help"),
        ),
      ).toEqual([]);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "with a CLI that removes without its prompt, a confirmed disconnect removes exactly that account",
  async () => {
    const lp = await launchpad({ removeYes: true, accounts: [work, invoices] });
    try {
      const listed = (await (
        await lp.get("/api/connections")
      ).json()) as Connections;
      expect(listed.capabilities).toEqual({ disconnect: true });
      const selector =
        accountsOf(listed, "gmail").find((entry) => entry.name === "práce")
          ?.account ?? "";
      // Never a selector that could match more than one account.
      expect(["gmail", "práce"]).not.toContain(selector);
      const removed = await lp.post("/api/connections/disconnect", {
        account: selector,
        confirm: true,
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ kind: "disconnected" });
      expect(
        (await composioCalls(lp.home)).filter(
          (args) =>
            args[0] === "connections" &&
            args[1] === "remove" &&
            !args.includes("--help"),
        ),
      ).toEqual([["connections", "remove", selector, "--yes"]]);
      const after = (await (
        await lp.get("/api/connections")
      ).json()) as Connections;
      expect(accountsOf(after, "gmail").map((entry) => entry.name)).toEqual([
        "faktury",
      ]);
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "/connections/<toolkit> is a page route: the link an agent sends opens the page",
  async () => {
    expect(pageRoute("/connections") as unknown).toEqual({
      view: "connections",
    });
    expect(pageRoute("/connections/gmail") as unknown).toEqual({
      view: "connections",
      toolkit: "gmail",
    });
    const lp = await launchpad();
    try {
      // A browser follows the link without the session token.
      const page = await fetch(new URL("/connections/gmail", lp.url));
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
    } finally {
      await lp.close();
    }
  },
  30_000,
);

contract(
  "the shell document names the apps whose sign-in expired",
  async () => {
    const lp = await launchpad({ accounts: [work, invoices] });
    try {
      let document: { connections?: unknown } = {};
      for (let attempt = 0; attempt < 10; attempt++) {
        const response = await lp.get("/.lazurio/shell.json");
        expect(response.status).toBe(200);
        document = (await response.json()) as { connections?: unknown };
        if (document.connections !== undefined) break;
        await Bun.sleep(300);
      }
      expect(document.connections).toEqual({
        expired: [{ toolkit: "gmail", name: "Gmail" }],
      });
    } finally {
      await lp.close();
    }
  },
  30_000,
);
