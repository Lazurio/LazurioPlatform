// A synthetic `claude` (Claude Code 2.1) for the MCP contract of decision F42
// (proposed): `--version` and the user-scope commands of `claude mcp` that
// the Launchpad is to run: `add-json --scope user <name> <json>`, `remove
// --scope user <name>`, `get <name>` and `list`, over
// `$HOME/.fake-claude/servers.json`, its user-scope servers. Every call is
// appended to `calls.jsonl` there with mode 0600, because an add carries the
// value of a header or variable. It never reaches a vendor.
import {
  appendFileSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const directory = join(process.env.HOME ?? "", ".fake-claude");
const args = process.argv.slice(2);
appendFileSync(join(directory, "calls.jsonl"), `${JSON.stringify(args)}\n`, {
  mode: 0o600,
});
const servers = JSON.parse(
  readFileSync(join(directory, "servers.json"), "utf8"),
) as Record<string, unknown>;

function save() {
  const temporary = join(directory, `servers.${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify(servers), { mode: 0o600 });
  renameSync(temporary, join(directory, "servers.json"));
}
function end(code: number, text?: string): never {
  if (text !== undefined) process.stderr.write(`${text}\n`);
  process.exit(code);
}

if (args[0] === "--version") {
  console.log("2.1.294 (Claude Code)");
  end(0);
}
if (args[0] !== "mcp") end(1, `Unknown command: ${args.join(" ")}`);
const [, command, ...rest] = args;
const scoped = rest[0] === "--scope" || rest[0] === "-s";
if (scoped && rest[1] !== "user") end(1, "This fake knows the user scope only");
const [name, json] = scoped ? rest.slice(2) : rest;

if (command === "add-json") {
  if (!scoped) end(1, "This fake requires --scope user");
  if (name === undefined || json === undefined)
    end(1, "Usage: add-json <name> <json>");
  if (Object.hasOwn(servers, name))
    end(1, `MCP server ${name} already exists in user config`);
  try {
    servers[name] = JSON.parse(json);
  } catch {
    end(1, "Invalid JSON");
  }
  save();
  console.log(`Added MCP server ${name} to user config`);
  end(0);
}
if (command === "remove") {
  if (name === undefined || !Object.hasOwn(servers, name))
    end(1, `No MCP server found with name: ${name}`);
  delete servers[name];
  save();
  console.log(`Removed MCP server ${name} from user config`);
  end(0);
}
if (command === "get") {
  if (name === undefined || !Object.hasOwn(servers, name))
    end(1, `No MCP server found with name: ${name}`);
  console.log(
    `${name}:\n  Scope: User config (available in all your projects)`,
  );
  end(0);
}
if (command === "list") {
  for (const entry of Object.keys(servers)) console.log(`${entry}: configured`);
  end(0);
}
end(1, `Unknown command: ${args.join(" ")}`);
