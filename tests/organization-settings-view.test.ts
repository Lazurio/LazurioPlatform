import { expect, test } from "bun:test";
import { messages } from "../src/launchpad/messages";
import {
  autoEnable,
  connectionLine,
  curatedActions,
  nextSelection,
  organizationDetails,
  organizationView,
  parseToolsOverview,
} from "../src/launchpad/tools-view";
import type { OrganizationSettingsStatus } from "../src/organization-settings/status";
import type { ToolOverview, ToolsOverview } from "../src/tools/overview";

// Settings → Tools on an Organization's Environment (decision F45, root
// decision 0194 point 5): a tool the Organization does not allow has its
// switch locked off and offers no sign-in, and one plain sentence says the
// Organization decides it; the person's choice is kept for when it allows
// it again. Allowed explicitly: a short note. The Organization's settings'
// version and state are in the tool's details.

const tool = (overrides: Partial<ToolOverview> = {}): ToolOverview => ({
  name: "composio",
  command: "composio",
  tier: "recommended",
  setup: "launchpad",
  enabled: false,
  offered: true,
  purpose: "Connects applications.",
  usage: "Use composio.",
  source: "https://docs.composio.dev/docs/cli",
  installed: true,
  path: "/home/operator/.local/bin/composio",
  version: "0.2.0",
  standardPath: true,
  signIn: { state: "signed-in", account: "operator@example.com" },
  prompt: "A prompt.",
  ...overrides,
});
// The person had it on; the Organization does not allow it.
const forbidden = tool({ enabled: true, organization: { allowed: false } });
const status: OrganizationSettingsStatus = {
  source: "dashboard",
  version: "a".repeat(40),
  appliedAt: "2026-10-09T20:00:01.000Z",
  checkedAt: "2026-10-09T20:02:01.000Z",
  error: null,
  unapplied: [],
};
const overview = (tools: ToolOverview[]): ToolsOverview => ({
  kind: "tools-status",
  revision: 3,
  locale: "en",
  sharedEnvironment: false,
  hosted: true,
  tools,
  mcpPrompt: "An MCP prompt.",
});

test("the page reads what the Organization says about a tool, and its settings' state, exactly", () => {
  const parsed = parseToolsOverview(
    JSON.parse(
      JSON.stringify({
        ...overview([forbidden]),
        organizationSettings: status,
      }),
    ),
  );
  expect(parsed?.tools[0]?.organization).toEqual({ allowed: false });
  expect(parsed?.organizationSettings).toEqual(status);
  // Without either, the answer reads as before.
  const plain = parseToolsOverview(
    JSON.parse(JSON.stringify(overview([tool()]))),
  );
  expect(plain?.tools[0]?.organization).toBeUndefined();
  expect(plain?.organizationSettings).toBeUndefined();
  for (const bad of [
    { allowed: "no" },
    {},
    { allowed: false, chosen: true },
    null,
  ])
    expect(
      parseToolsOverview(
        JSON.parse(
          JSON.stringify(
            overview([{ ...forbidden, organization: bad } as never]),
          ),
        ),
      ),
    ).toBeNull();
  for (const bad of [
    { ...status, source: "elsewhere" },
    { ...status, version: "abc" },
    { ...status, error: "other" },
    { ...status, unapplied: ["Bad Key"] },
    { ...status, extra: true },
  ])
    expect(
      parseToolsOverview(
        JSON.parse(
          JSON.stringify({ ...overview([tool()]), organizationSettings: bad }),
        ),
      ),
    ).toBeNull();
});

for (const locale of ["cs", "en"] as const)
  test(`a tool the Organization does not allow is locked off, with why, in ${locale}`, () => {
    const copy = messages(locale);
    const view = organizationView(forbidden, copy);
    expect(view.locked).toBe(true);
    expect(view.line).toBe(
      locale === "cs"
        ? "Composio tu nepovoluje Organizace."
        : "The Organization does not allow Composio here.",
    );
    expect(view.kept).toBe(copy.toolsOrganizationKept);
    // Without the person's earlier choice nothing is said to be kept.
    expect(
      organizationView(
        tool({ enabled: false, organization: { allowed: false } }),
        copy,
      ).kept,
    ).toBeNull();
    // Allowed explicitly: a short note, and the switch is the person's.
    const allowed = organizationView(
      tool({ enabled: true, organization: { allowed: true } }),
      copy,
    );
    expect(allowed).toEqual({
      locked: false,
      line: copy.toolsOrganizationAllows,
      kept: null,
    });
    expect(organizationView(tool(), copy)).toEqual({
      locked: false,
      line: null,
      kept: null,
    });
  });

test("a locked tool offers no sign-in or installation, still a sign-out, and is not switched on by one", () => {
  const copy = messages("en");
  expect(curatedActions(forbidden, copy)).toEqual({
    primary: null,
    logout: true,
    linkSsh: false,
  });
  const { signIn: _, ...missing } = forbidden;
  expect(curatedActions({ ...missing, installed: false }, copy)).toEqual({
    primary: null,
    logout: false,
    linkSsh: false,
  });
  expect(
    autoEnable(forbidden, { kind: "signed-in", already: false } as never),
  ).toBe(false);
});

test("a change of another tool carries the person's kept choice of the locked one", () => {
  const wacli = tool({
    name: "wacli",
    command: "wacli",
    tier: "optional",
    enabled: false,
  });
  expect(nextSelection([forbidden, wacli], "wacli", true)).toEqual([
    "composio",
    "wacli",
  ]);
  expect(
    nextSelection(
      [tool({ enabled: false, organization: { allowed: false } }), wacli],
      "wacli",
      true,
    ),
  ).toEqual(["wacli"]);
});

for (const locale of ["cs", "en"] as const)
  test(`the details say where the settings come from, which version applies and why nothing new came, in ${locale}`, () => {
    const copy = messages(locale);
    const at = (iso: string) => `<${iso}>`;
    expect(organizationDetails(status, copy, at)).toEqual([
      copy.toolsOrganizationHow,
      copy.toolsOrganizationFromDashboard,
      copy.toolsOrganizationVersion
        .replace("{version}", "aaaaaaa")
        .replace("{time}", "<2026-10-09T20:00:01.000Z>"),
      copy.toolsOrganizationChecked.replace(
        "{time}",
        "<2026-10-09T20:02:01.000Z>",
      ),
    ]);
    const lines = (overrides: Partial<OrganizationSettingsStatus>) =>
      organizationDetails({ ...status, ...overrides }, copy, at);
    expect(lines({ error: "dashboard_unreachable" })).toContain(
      copy.toolsOrganizationUnreachable,
    );
    expect(lines({ error: "identity_unavailable" })).toContain(
      copy.toolsOrganizationIdentity,
    );
    expect(lines({ error: "settings_invalid" })).toContain(
      copy.toolsOrganizationInvalid,
    );
    expect(lines({ error: "repository_unavailable" })).toContain(
      copy.toolsOrganizationRepository,
    );
    expect(lines({ error: "state_unreadable" })).toContain(
      copy.toolsOrganizationState,
    );
    expect(lines({ unapplied: ["integrations.composio.allowed"] })).toContain(
      copy.toolsOrganizationUnapplied,
    );
    expect(
      lines({
        source: "repository",
        version: null,
        appliedAt: null,
        checkedAt: null,
      }),
    ).toEqual([
      copy.toolsOrganizationHow,
      copy.toolsOrganizationFromRepository,
      copy.toolsOrganizationNotApplied,
      copy.toolsOrganizationNotChecked,
    ]);
    // Without a Launchpad that asks (the CLI, a test), only how to change it.
    expect(organizationDetails(undefined, copy, at)).toEqual([
      copy.toolsOrganizationHow,
    ]);
  });

test("a locked tool not added yet is not said to be used once it is", () => {
  const copy = messages("cs");
  const { signIn: _, path: __, version: ___, ...missing } = forbidden;
  expect(connectionLine({ ...missing, installed: false }, copy).text).toBe(
    copy.toolsNotAdded,
  );
  // Without the Organization's refusal the person's switch says it.
  const { organization: ____, ...free } = missing;
  expect(connectionLine({ ...free, installed: false }, copy).text).toBe(
    copy.toolsEnabledNotInstalled.replace("{name}", "composio"),
  );
});
