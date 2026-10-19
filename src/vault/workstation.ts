import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock } from "../platform/flock";
import { parseUniqueJson } from "../providers/unique-json";
import { writeDurableFile } from "../update/durable-file";
import type { VaultContext } from "./context";
import { bitwardenRegionOf } from "./endpoints";
import { plainObject, readOwned, serialize } from "./store";

/** Local non-secret admission metadata. Credentials retain their existing owner. */
type Binding = Readonly<{
  organization: string;
  server: string;
  account: string;
  name: string;
}>;
type Bindings = Readonly<{ schema: 1; bindings: readonly Binding[] }>;

export function workstationOrganization(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(value))
    throw new Error("Invalid workstation Organization");
  return value.toLowerCase();
}

function serverOf(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    bitwardenRegionOf(url.origin) !== null ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    !url.hostname.includes(".")
  )
    throw new Error("Invalid workstation vault service");
  return url.origin;
}

async function inspect(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return false;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Unsafe workstation vault directory");
  return true;
}

async function readBindings(directory: string): Promise<Bindings> {
  if (!(await inspect(directory))) return { schema: 1, bindings: [] };
  const text = await readOwned(join(directory, "bindings.json"));
  if (text === null) return { schema: 1, bindings: [] };
  const value = plainObject(parseUniqueJson(text));
  if (
    value?.schema !== 1 ||
    !Array.isArray(value.bindings) ||
    Object.keys(value).length !== 2
  )
    throw new Error("Invalid workstation bindings");
  const organizations = new Set<string>();
  const accounts = new Set<string>();
  const bindings = value.bindings.map((entry: unknown): Binding => {
    const item = plainObject(entry);
    if (
      item === null ||
      Object.keys(item).length !== 4 ||
      typeof item.organization !== "string" ||
      typeof item.server !== "string" ||
      typeof item.account !== "string" ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 100 ||
      /\p{Cc}/u.test(item.name)
    )
      throw new Error("Invalid workstation binding");
    const organization = workstationOrganization(item.organization);
    const server = serverOf(item.server);
    if (
      organization !== item.organization ||
      server !== item.server ||
      !/^workstation-[0-9a-f-]{36}@[a-z0-9.-]+$/.test(item.account) ||
      item.account.split("@")[1] !== new URL(server).hostname ||
      organizations.has(organization) ||
      accounts.has(item.account)
    )
      throw new Error("Invalid workstation identity");
    organizations.add(organization);
    accounts.add(item.account);
    return { organization, server, account: item.account, name: item.name };
  });
  return { schema: 1, bindings };
}

/** Idempotent explicit onboarding; never imports another account's custody. */
export async function configureWorkstationVault(
  directory: string,
  input: {
    organization: string;
    server: string;
    name: string;
  },
): Promise<Binding> {
  const organization = workstationOrganization(input.organization);
  const server = serverOf(input.server);
  if (
    !input.name.trim() ||
    input.name.length > 100 ||
    /\p{Cc}/u.test(input.name)
  )
    throw new Error("Invalid workstation vault name");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspect(directory);
  const lock = await acquireFileLock(join(directory, "lock"), {
    timeoutMs: 10_000,
  });
  try {
    const state = await readBindings(directory);
    const existing = state.bindings.find(
      (binding) => binding.organization === organization,
    );
    if (existing !== undefined) {
      if (existing.server !== server || existing.name !== input.name)
        throw new Error("Disconnect the existing workstation vault first");
      return existing;
    }
    const binding = {
      organization,
      server,
      name: input.name,
      account: `workstation-${randomUUID()}@${new URL(server).hostname}`,
    };
    await writeDurableFile(
      directory,
      "bindings.json",
      serialize({
        schema: 1,
        bindings: [...state.bindings, binding],
      }),
    );
    return binding;
  } finally {
    await lock.release();
  }
}

export async function disconnectWorkstationVault(
  directory: string,
  organization: string,
): Promise<void> {
  const selected = workstationOrganization(organization);
  if (!(await inspect(directory))) return;
  const lock = await acquireFileLock(join(directory, "lock"), {
    timeoutMs: 10_000,
  });
  try {
    const state = await readBindings(directory);
    await writeDurableFile(
      directory,
      "bindings.json",
      serialize({
        schema: 1,
        bindings: state.bindings.filter(
          (entry) => entry.organization !== selected,
        ),
      }),
    );
  } finally {
    await lock.release();
  }
}

export async function workstationVaultContext(
  directory: string,
  organization: string,
): Promise<VaultContext | null> {
  const selected = workstationOrganization(organization);
  const state = await readBindings(directory);
  const binding = state.bindings.find(
    (entry) => entry.organization === selected,
  );
  if (binding === undefined) return null;
  return Object.freeze({
    kind: "own",
    vault: binding.server,
    host: new URL(binding.server).hostname,
    account: binding.account,
    name: binding.name,
    environment: "work",
    organization: selected,
    assignment: null,
  });
}
