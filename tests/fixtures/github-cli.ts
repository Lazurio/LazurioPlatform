// Compiled synthetic provider transport. Never accesses credentials or network.
export {};

if (
  process.env.GH_DEBUG ||
  process.env.HTTPS_PROXY ||
  process.env.GH_HOST !== "github.com" ||
  process.env.GH_PROMPT_DISABLED !== "1"
)
  process.exit(4);
const args = process.argv.slice(2);
if (
  args[0] !== "api" ||
  args[1] !== "graphql" ||
  args[2] !== "--hostname" ||
  args[3] !== "github.com" ||
  args[4] !== "--raw-field" ||
  !args[5]?.startsWith("query=query(") ||
  args[6] !== "--raw-field" ||
  args[7] !== "owner=Example" ||
  args[8] !== "--raw-field" ||
  args[9] !== "name=fixture" ||
  args.length !== 10
)
  process.exit(5);
const mode = process.env.GH_CONFIG_DIR;
if (mode === "slow") await Bun.sleep(1000);
if (mode === "warning")
  console.error("synthetic provider warning must not escape");
if (mode === "oversize") console.log("x".repeat(70_000));
else
  console.log(
    JSON.stringify({
      data: {
        viewer: { id: "User_fixture", login: "fixture-user" },
        repository: {
          id: "Repository_fixture",
          nameWithOwner: "Example/fixture",
          viewerPermission: "READ",
          isArchived: false,
          isDisabled: false,
        },
      },
    }),
  );
