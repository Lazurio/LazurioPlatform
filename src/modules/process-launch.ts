import { isAbsolute } from "node:path";
import { array, object } from "./manifest";

export function parseProcessLaunch(input: unknown) {
  const value = object(input, ["executable", "args", "cwd", "env"]);
  const string = (value: unknown) => {
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("Invalid process input");
    return value;
  };
  const executable = string(value.executable);
  const cwd = string(value.cwd);
  const args = array(value.args).map(string);
  if (!isAbsolute(executable))
    throw new Error("Explicit executable path required");
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
    throw new Error("Explicit environment required");
  const env: Record<string, string> = Object.create(null);
  for (const key of Reflect.ownKeys(value.env)) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error("Invalid environment key");
    const entry = Object.getOwnPropertyDescriptor(value.env, key);
    if (!entry || !("value" in entry))
      throw new Error("Environment values must be data");
    env[key] = string(entry.value);
  }
  return Object.freeze({
    executable,
    cwd,
    args: Object.freeze(args),
    env: Object.freeze(env),
  });
}
