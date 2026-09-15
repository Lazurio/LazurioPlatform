import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { initializeHandoverFolder } from "../folder/initialize-folder";
import { parseFolderProfile } from "../folder/profile";
import {
  bindMachineOperator,
  MachineContextError,
  readMachineContext,
} from "./context";

export const machineHelp = `machine inspect
Read the root-issued /etc/lazurio/lazurio.machine.json on Linux only.
Output contains private Machine/Organization context; do not publish it.
The declaration grants no permissions, provider identity or access.
machine folder-init --locale <cs|en> --detail <concise|technical>
  --coordination <direct|coordinator>
Initialize the declared operator's empty, precreated standard Lazurio Folder.
Limited pilot: Linux / remote / human. All three choices required.
Run as the declared operator, never root. No path or custody override.
No Organization checkout, gateway change, resident removal or migration.
An interrupted recognized journal can be completed using folder-resume;
missing/damaged journals require operator diagnosis, never blanket cleanup.`;

export async function runMachineCommand(args: string[]) {
  const [command, ...options] = args;
  if (command !== "inspect" && command !== "folder-init")
    throw new Error("Unknown Machine command");
  const { values, tokens } = parseArgs({
    args: options,
    strict: true,
    tokens: true,
    options:
      command === "inspect"
        ? {}
        : {
            locale: { type: "string" },
            detail: { type: "string" },
            coordination: { type: "string" },
          },
  });
  if (
    tokens.length !== (command === "inspect" ? 0 : 3) ||
    new Set(tokens.map((token) => (token.kind === "option" ? token.name : "")))
      .size !== tokens.length
  )
    throw new Error("Explicit nonduplicate Machine options required");
  const profile =
    command === "folder-init"
      ? parseFolderProfile({
          os: "linux",
          access: "remote",
          purpose: "human",
          ...values,
        })
      : null;
  try {
    const observed = await readMachineContext();
    if (!profile)
      return {
        code: 0,
        result: {
          kind: "machine-context-observed",
          ...observed,
          authority: "none",
        },
      };
    const operator = userInfo();
    const folder = bindMachineOperator(observed.context, {
      platform: process.platform,
      uid: operator.uid,
      username: operator.username,
      homedir: operator.homedir,
    });
    const result = await initializeHandoverFolder(folder, profile);
    return {
      code: 0,
      result: { ...result, machineContextDigest: observed.digest },
    };
  } catch (error) {
    if (error instanceof MachineContextError)
      return {
        code: 2,
        result: {
          kind: "blocked",
          reason: error.code,
          next: "Ask the Machines operator to verify the handover; do not edit the identity file or reset product trust.",
        },
      };
    throw error;
  }
}
