import { homedir } from "node:os";
import type { AiProbe } from "../tools/ai-probe";
import { codexHome } from "../tools/codex-apps";
import type { ToolRunner } from "../tools/status";
import {
  codexAppServerManaged,
  restartCodexAppServer,
} from "../update/codex-app-server";
import { convergeCodexTrust } from "./codex-trust";
import { codexControlSocketPath, openControlSocket } from "./control-socket";
import type { ConnectionsHost } from "./pairing";

/** This process's Connections host: the operator's Codex (its home, its
 * daemon's control socket and Lazurio's unit), the AI probe the page already
 * reads, and the Folder whose trust chats from the phone need. Trusted
 * composition, never HTTP input; tests supply their own host. */
export function processConnectionsHost(
  input: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    platform: string;
    run: ToolRunner;
    ai: AiProbe;
    kind: () => Promise<string | null>;
    folder: () => Promise<string>;
  }>,
): ConnectionsHost {
  const home = input.env.HOME ?? homedir();
  const codex = () => codexHome({ home, env: input.env });
  return Object.freeze({
    kind: input.kind,
    ai: () => input.ai.state(),
    connect: async () => {
      const directory = codex();
      if (directory === null) throw new Error("no Codex home");
      return openControlSocket(codexControlSocketPath(directory));
    },
    restartable: () =>
      codexAppServerManaged({ platform: input.platform, env: input.env }),
    restart: () =>
      restartCodexAppServer({
        platform: input.platform,
        env: input.env,
        run: input.run,
      }),
    trust: async () => {
      const directory = codex();
      if (directory === null) return { kind: "refused" };
      return convergeCodexTrust(directory, [await input.folder(), home]);
    },
  });
}
