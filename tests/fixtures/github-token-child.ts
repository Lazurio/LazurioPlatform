// One process asking for the owning Organization's token, as the gh launcher
// and the Git helper of separate commands do at the same moment: the
// cross-process race of the pilot's refresh (decision F46). Prints the
// answer without the token's value beyond what the test compares.
import { githubHttp } from "../../src/github/oauth";
import {
  owningOrganization,
  type PilotPaths,
  pilotPaths,
  readPilot,
} from "../../src/github/pilot";
import { organizationToken } from "../../src/github/store";

const origin = process.env.LAZURIO_TEST_GITHUB_ORIGIN;
if (origin === undefined) process.exit(3);
const paths = pilotPaths(process.env) as PilotPaths;
const pilot = await readPilot(paths);
if (pilot.kind !== "on") process.exit(3);
const answer = await organizationToken({
  paths,
  organization: owningOrganization(pilot.config),
  http: githubHttp({ origins: { web: origin, api: origin } }),
  now: () => Date.now(),
});
console.log(
  JSON.stringify(
    answer.kind === "token"
      ? { kind: answer.kind, token: answer.token, refreshed: answer.refreshed }
      : answer,
  ),
);
