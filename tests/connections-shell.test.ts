import { expect } from "bun:test";
import { shellDocument } from "../src/launchpad/shell-document";
import { parseShell, type Shell } from "../src/shell/contract";
import { shellMessages } from "../src/shell/messages";
import { columnSetupLine } from "../src/shell/view";
import { contract } from "./fixtures/contract";
import { organizationWithEntry } from "./fixtures/machine-bindings";

// The shell's column head for expired connections (decision F42, proposed,
// docs/connected-apps.md section 9): an additive member `connections` of
// `lazurio.shell.v1` beside `setup`, and one line in Chat and Automate. RED
// BY DESIGN until its slice lands (section 15).

const shellCs = shellMessages("cs");
const launchpad = "https://launchpad.workspace.example.lazurio.io";
const gmail = { toolkit: "gmail", name: "Gmail" };
const slack = { toolkit: "slack", name: "Slack" };
const notion = { toolkit: "notion", name: "Notion" };

const document = (): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(
      shellDocument({
        preset: "hosted-organization-personal",
        machine: organizationWithEntry(),
        locale: "cs",
        catalog: { kind: "catalog", organizations: [] },
      }),
    ),
  );
function hosted(members: Record<string, unknown>): Shell {
  const shell = parseShell({ ...document(), ...members });
  if (shell === null) throw new Error("fixture");
  return shell;
}

contract(
  "the column head names expired connections in Chat and Automate and links their cards in the Launchpad",
  () => {
    const one = hosted({ connections: { expired: [gmail] } });
    expect(columnSetupLine(one, shellCs, "chat")).toMatchObject({
      text: "Gmail: přihlášení vypršelo",
      links: [
        { label: "Přihlásit znovu", href: `${launchpad}/connections/gmail` },
      ],
    });
    expect(columnSetupLine(one, shellCs, "automate")?.text).toBe(
      "Gmail: přihlášení vypršelo",
    );
    // Apps says it itself, on its "Připojené aplikace" item.
    expect(columnSetupLine(one, shellCs, "apps")).toBeNull();
    expect(
      columnSetupLine(
        hosted({ connections: { expired: [gmail, slack] } }),
        shellCs,
        "chat",
      ),
    ).toMatchObject({
      text: "Gmail a Slack: přihlášení vypršelo",
      links: [{ label: "Přihlásit znovu", href: `${launchpad}/connections` }],
    });
    expect(
      columnSetupLine(
        hosted({ connections: { expired: [gmail, slack, notion] } }),
        shellCs,
        "chat",
      )?.text,
    ).toBe("3 aplikace: přihlášení vypršelo");
    // One line at a time: what the Environment still lacks comes first.
    expect(
      columnSetupLine(
        hosted({
          setup: { github: "missing" },
          connections: { expired: [gmail] },
        }),
        shellCs,
        "chat",
      )?.text,
    ).toBe("Bez GitHubu agenti nepracují.");
    // The member describes the current Environment, in its exact shape only.
    expect(
      parseShell({
        ...document(),
        current: null,
        connections: { expired: [gmail] },
      }),
    ).toBeNull();
    expect(
      parseShell({
        ...document(),
        connections: { expired: [{ toolkit: "Gmail!", name: "Gmail" }] },
      }),
    ).toBeNull();
  },
);
