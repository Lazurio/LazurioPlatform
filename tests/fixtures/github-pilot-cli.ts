// The `lazurio github gh|credential` entry of a wired pilot (decision F46),
// pointed at the fake GitHub of LAZURIO_TEST_GITHUB_ORIGIN: what the
// launcher script and Git's helper line run in the integration tests, through
// a real shell, a real Git and a stand-in of the official gh.
import { credentialHelper } from "../../src/github/credential";
import {
  checkoutOrigin,
  runGhLauncher,
  runInherited,
} from "../../src/github/launcher";
import { githubHttp } from "../../src/github/oauth";
import { type PilotPaths, pilotPaths } from "../../src/github/pilot";

const origin = process.env.LAZURIO_TEST_GITHUB_ORIGIN;
const paths = pilotPaths(process.env) as PilotPaths;
if (origin === undefined || paths === undefined) process.exit(3);
const http = githubHttp({ origins: { web: origin, api: origin } });
const [group, command, ...rest] = process.argv.slice(2);
if (group !== "github") process.exit(3);
if (command === "gh") {
  process.exitCode = await runGhLauncher(rest, {
    env: process.env,
    paths,
    http,
    now: () => Date.now(),
    readOrigin: () => checkoutOrigin(process.env),
    runGh: runInherited,
    writeStderr: (text) => process.stderr.write(text),
  });
} else if (command === "credential") {
  const input = await new Response(Bun.stdin.stream()).text();
  const { stdout, code } = await credentialHelper(rest[0] ?? "", input, {
    paths,
    http,
    now: () => Date.now(),
    writeStderr: (text) => process.stderr.write(text),
  });
  process.stdout.write(stdout);
  process.exitCode = code;
} else process.exit(3);
