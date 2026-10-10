import { expect, test } from "bun:test";
import {
  OwnerSelectionError,
  ownerOfCredentialPath,
  ownerOfEndpoint,
  ownerOfGhCommand,
  ownerOfRemote,
  ownerOfSelector,
} from "../src/github/owner";

// Which Organization's sign-in a command uses (decision F46): brokered-gh's
// selection rules (--repo/-R, GH_REPO, then the checkout's origin; selectors
// that disagree are refused) plus the endpoint of gh api and the repository
// or URL right after the subcommand.

const owner = (args: string[], env: Record<string, string> = {}) =>
  ownerOfGhCommand(args, env);

test("the selectors of brokered-gh name the owner, and disagreeing ones are refused", () => {
  expect(owner(["pr", "list", "--repo", "Example/app"])).toEqual({
    owner: "Example",
    source: "selector",
  });
  expect(owner(["pr", "list", "-R", "Example/app"])?.owner).toBe("Example");
  expect(owner(["pr", "list", "--repo=Example/app"])?.owner).toBe("Example");
  expect(owner(["pr", "list"], { GH_REPO: "Example/app" })?.owner).toBe(
    "Example",
  );
  expect(owner(["pr", "list", "-R", "github.com/Example/app"])?.owner).toBe(
    "Example",
  );
  // The same owner in another spelling is the same owner.
  expect(
    owner(["pr", "list", "-R", "example/other"], { GH_REPO: "EXAMPLE/app" })
      ?.owner,
  ).toBe("EXAMPLE");
  expect(() =>
    owner(["pr", "list", "-R", "Other/app"], { GH_REPO: "Example/app" }),
  ).toThrow(OwnerSelectionError);
  expect(() =>
    owner(["pr", "list", "-R", "Example/app", "--repo", "Other/app"]),
  ).toThrow(new OwnerSelectionError("selectors-disagree"));
  expect(() => owner(["pr", "list", "-R"])).toThrow(
    new OwnerSelectionError("selector-invalid"),
  );
  // Another host is not the pilot's.
  expect(() =>
    owner(["pr", "list", "-R", "ghe.example.com/Example/app"]),
  ).toThrow(new OwnerSelectionError("host-not-github"));
  expect(() => ownerOfSelector("https://gitlab.example/Example/app")).toThrow(
    new OwnerSelectionError("host-not-github"),
  );
  expect(() => ownerOfSelector("not a repository")).toThrow(
    new OwnerSelectionError("selector-invalid"),
  );
});

test("gh api names the owner of repos/ and orgs/ endpoints, never a placeholder", () => {
  expect(ownerOfEndpoint("repos/Example/app/pulls")).toBe("Example");
  expect(ownerOfEndpoint("/repos/Example/app")).toBe("Example");
  expect(ownerOfEndpoint("orgs/Example/teams")).toBe("Example");
  expect(ownerOfEndpoint("/orgs/Example")).toBe("Example");
  expect(ownerOfEndpoint("https://api.github.com/repos/Example/app")).toBe(
    "Example",
  );
  // The Owner check and the content role of Lazurio itself.
  expect(ownerOfEndpoint("user/memberships/orgs/Example")).toBe("Example");
  expect(ownerOfEndpoint("repos/{owner}/{repo}/pulls")).toBeNull();
  expect(ownerOfEndpoint("user/installations")).toBeNull();
  expect(ownerOfEndpoint("graphql")).toBeNull();
  expect(
    owner(["api", "-X", "GET", "repos/Example/app/issues", "-f", "state=open"])
      ?.owner,
  ).toBe("Example");
  // A field value is not an endpoint.
  expect(owner(["api", "user", "-f", "note=repos/Other/app"])).toBeNull();
  // The `owner` variable of a GraphQL query, as Lazurio's repository read
  // sends it.
  expect(
    owner([
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "--raw-field",
      "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}",
      "--raw-field",
      "owner=Example",
      "--raw-field",
      "name=app",
    ])?.owner,
  ).toBe("Example");
  expect(owner(["api", "graphql", "-F", "owner=Example"])?.owner).toBe(
    "Example",
  );
  expect(owner(["api", "graphql", "--field=owner=Example"])?.owner).toBe(
    "Example",
  );
  expect(
    owner(["api", "graphql", "-f", "query=query{viewer{login}}"]),
  ).toBeNull();
  // Only for GraphQL: a REST field named owner is a value, not a selector.
  expect(owner(["api", "user", "-f", "owner=Example"])).toBeNull();
  expect(
    owner(["api", "repos/Example/app"], { GH_REPO: "Example/other" })?.owner,
  ).toBe("Example");
  expect(() =>
    owner(["api", "repos/Other/app"], { GH_REPO: "Example/app" }),
  ).toThrow(OwnerSelectionError);
});

test("the repository or URL right after the subcommand names the owner", () => {
  expect(owner(["repo", "clone", "Example/app"])).toEqual({
    owner: "Example",
    source: "argument",
  });
  expect(
    owner(["repo", "clone", "https://github.com/Example/app.git"])?.owner,
  ).toBe("Example");
  expect(owner(["repo", "view", "Example/app", "--json", "name"])?.owner).toBe(
    "Example",
  );
  expect(owner(["repo", "create", "Example/new", "--private"])?.owner).toBe(
    "Example",
  );
  expect(owner(["repo", "list", "Example"])?.owner).toBe("Example");
  expect(
    owner(["pr", "view", "https://github.com/Example/app/pull/12"])?.owner,
  ).toBe("Example");
  expect(
    owner(["issue", "view", "https://github.com/Example/app/issues/3"])?.owner,
  ).toBe("Example");
  // Not a repository: a plain name, a number, a flag, a branch elsewhere.
  expect(owner(["repo", "create", "new-module"])).toBeNull();
  expect(owner(["pr", "view", "12"])).toBeNull();
  expect(owner(["pr", "create", "--head", "feature/x"])).toBeNull();
  expect(owner(["repo", "list", "--limit", "5"])).toBeNull();
  expect(owner(["pr", "checkout", "feature/x"])).toBeNull();
  // Arguments after -- belong to git.
  expect(
    owner(["repo", "clone", "Example/app", "--", "Other/app"])?.owner,
  ).toBe("Example");
  expect(owner(["pr", "list", "--", "-R", "Other/app"])).toBeNull();
  // A command naming nothing leaves the choice to the checkout or the owning
  // Organization.
  expect(owner(["auth", "status"])).toBeNull();
  expect(owner(["api", "user"])).toBeNull();
});

test("a remote's owner is read from github.com only", () => {
  expect(ownerOfRemote("https://github.com/Example/app.git")).toBe("Example");
  expect(ownerOfRemote("https://someone@github.com/Example/app")).toBe(
    "Example",
  );
  expect(ownerOfRemote("git@github.com:Example/app.git")).toBe("Example");
  expect(ownerOfRemote("ssh://git@github.com/Example/app.git")).toBe("Example");
  expect(ownerOfRemote("git@GitHub.com:Example/app.git")).toBe("Example");
  expect(ownerOfRemote("git@github-work:Example/app.git")).toBeNull();
  expect(ownerOfRemote("https://gitlab.example/Example/app.git")).toBeNull();
  expect(ownerOfRemote("http://github.com/Example/app.git")).toBeNull();
  expect(ownerOfRemote("/srv/git/app.git")).toBeNull();
});

test("Git's credential path names the owner", () => {
  expect(ownerOfCredentialPath("Example/app.git")).toBe("Example");
  expect(ownerOfCredentialPath("/Example/app.git")).toBe("Example");
  expect(ownerOfCredentialPath("Example")).toBe("Example");
  expect(ownerOfCredentialPath(undefined)).toBeNull();
  expect(ownerOfCredentialPath("")).toBeNull();
  expect(ownerOfCredentialPath("-x/app.git")).toBeNull();
});
