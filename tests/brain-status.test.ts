import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainPaths, brainPin, brainUnit } from "../src/brain/pin";
import { type BrainHost, brainStatus } from "../src/brain/status";
import { unitMarker } from "../src/update/service-control";

// The read of the person's brain (plan LZD-0033 R11a): who runs it, which
// release answers, and which of Lazurio's keys are handed over. Fixtures are
// fictional; no brain, network or user manager is touched.

async function world(
  options: Readonly<{
    unit?: string;
    globalUnit?: string;
    health?: string | null;
    brain?: boolean;
    keys?: Readonly<Record<string, string>>;
    supported?: boolean;
  }> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "brain-status-"));
  const home = join(root, "home");
  const globalUnits = join(root, "etc-systemd-user");
  const paths = brainPaths(home);
  await mkdir(paths.units, { recursive: true });
  await mkdir(globalUnits, { recursive: true });
  await mkdir(join(paths.brain, "serve"), { recursive: true });
  if (options.unit !== undefined)
    await writeFile(join(paths.units, brainUnit), options.unit);
  if (options.globalUnit !== undefined)
    await writeFile(join(globalUnits, brainUnit), options.globalUnit);
  if (options.brain) await writeFile(join(paths.brain, "config.json"), "{}");
  for (const [file, text] of Object.entries(options.keys ?? {}))
    await writeFile(join(paths.brain, "serve", file), text);
  const host: BrainHost = {
    async context() {
      return options.supported === false
        ? { kind: "unsupported", reason: "not-personal" }
        : { kind: "supported" };
    },
    paths,
    globalUnits,
    async health() {
      return options.health ?? null;
    },
  };
  return host;
}

const interimUnit = `[Unit]
Description=gbrain MCP memory server
[Service]
ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131'
[Install]
WantedBy=default.target
`;
const machinesUnit = `[Service]
ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec /usr/local/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131'
`;
const handover = (token = "x".repeat(40)) =>
  JSON.stringify({ url: "http://127.0.0.1:3131", token });

describe("brain status", () => {
  test("a Work, Team or public Environment has no brain of Lazurio's", async () => {
    expect(await brainStatus(await world({ supported: false }))).toEqual({
      state: "unsupported",
      reason: "not-personal",
    });
  });

  test("nothing there: not installed", async () => {
    const status = await brainStatus(await world());
    expect(status).toMatchObject({
      state: "not-installed",
      owner: "absent",
      pin: brainPin.version,
      running: null,
      brain: false,
      keys: { launchpad: "missing", executor: "missing", probe: "missing" },
    });
  });

  test("the interim installer's unit is adoptable, its brain and key kept", async () => {
    const status = await brainStatus(
      await world({
        unit: interimUnit,
        health: "0.60.315.0",
        brain: true,
        keys: { "lazurio-launchpad.json": handover() },
      }),
    );
    expect(status).toMatchObject({
      state: "adoptable",
      owner: "interim",
      running: "0.60.315.0",
      brain: true,
      keys: { launchpad: "handed-over", executor: "missing" },
    });
  });

  test("Machines' global unit stays Machines' until they hand it over", async () => {
    expect(
      await brainStatus(await world({ globalUnit: machinesUnit })),
    ).toMatchObject({ state: "machines", owner: "machines" });
  });

  test("a unit nobody of these wrote is foreign and left alone", async () => {
    expect(
      await brainStatus(await world({ unit: "[Service]\nExecStart=/opt/x\n" })),
    ).toMatchObject({ state: "foreign", owner: "foreign" });
    expect(
      await brainStatus(await world({ globalUnit: "[Service]\n" })),
    ).toMatchObject({ state: "foreign" });
  });

  test("Lazurio's own unit: running at the pin, outdated, or not running", async () => {
    const own = `${unitMarker}\n[Service]\n`;
    expect(
      await brainStatus(await world({ unit: own, health: brainPin.version })),
    ).toMatchObject({ state: "running", owner: "lazurio" });
    expect(
      await brainStatus(await world({ unit: own, health: "0.60.315.0" })),
    ).toMatchObject({ state: "outdated", running: "0.60.315.0" });
    expect(await brainStatus(await world({ unit: own }))).toMatchObject({
      state: "not-running",
      running: null,
    });
  });

  test("a handover that is not the Launchpad's shape is invalid", async () => {
    const status = await brainStatus(
      await world({
        keys: {
          "lazurio-launchpad.json": "{not json",
          "lazurio-executor.json": JSON.stringify({
            url: "https://example.invalid",
            token: "x".repeat(40),
          }),
          "lazurio-probe.json": handover("short"),
        },
      }),
    );
    expect(status).toMatchObject({
      keys: { launchpad: "invalid", executor: "invalid", probe: "invalid" },
    });
  });
});
