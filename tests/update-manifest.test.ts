import { expect, test } from "bun:test";
import { UpdateFailure } from "../src/update/errors";
import { tagOf, versionOfTag } from "../src/update/identity";
import {
  maxManifestBytes,
  parseManifest,
  renderManifest,
} from "../src/update/manifest";
import { compareVersions } from "../src/update/version";

const valid = {
  schema: 1,
  version: "1.4.0",
  source_commit: "a".repeat(40),
  minimum_updater_version: "1.0.0",
  notes_url: "https://github.com/Lazurio/LazurioPlatform/releases/tag/v1.4.0",
  targets: {
    "linux-x64": {
      file: "lazurio-linux-x64",
      sha256: "b".repeat(64),
      size: 10,
    },
  },
};
const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const reason = (value: unknown) => {
  try {
    parseManifest(value instanceof Uint8Array ? value : encode(value));
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateFailure);
    expect((error as UpdateFailure).failure.code).toBe("release-invalid");
    return (error as UpdateFailure).failure.context.reason;
  }
  return "accepted";
};

test("schema 1 parses, and members a later release adds are tolerated", () => {
  expect(
    parseManifest(encode({ ...valid, later: { anything: true } })),
  ).toEqual({
    schema: 1,
    version: "1.4.0",
    sourceCommit: "a".repeat(40),
    minimumUpdaterVersion: "1.0.0",
    notesUrl: valid.notes_url,
    targets: {
      "linux-x64": {
        file: "lazurio-linux-x64",
        sha256: "b".repeat(64),
        size: 10,
      },
    },
  });
});

test("everything the updater relies on is validated", () => {
  const target = valid.targets["linux-x64"];
  const withTarget = (entry: unknown, name = "linux-x64") => ({
    ...valid,
    targets: { [name]: entry },
  });
  expect(
    Object.entries({
      "not json": new TextEncoder().encode("{"),
      "invalid utf-8": new Uint8Array([0xff, 0xfe]),
      array: [],
      schema: { ...valid, schema: 2 },
      version: { ...valid, version: "1.4" },
      "version with v": { ...valid, version: "v1.4.0" },
      commit: { ...valid, source_commit: "abc" },
      minimum: { ...valid, minimum_updater_version: undefined },
      "notes scheme": { ...valid, notes_url: "http://example.com/" },
      "notes missing": { ...valid, notes_url: 1 },
      targets: { ...valid, targets: [] },
      // The asset name is derived from the target; a path cannot hide in it.
      "foreign file": withTarget({ ...target, file: "../lazurio-linux-x64" }),
      "other file": withTarget({ ...target, file: "lazurio-linux-arm64" }),
      "target name": withTarget({ ...target, file: "lazurio-x" }, "x"),
      digest: withTarget({ ...target, sha256: "B".repeat(64) }),
      "zero size": withTarget({ ...target, size: 0 }),
      "fraction size": withTarget({ ...target, size: 1.5 }),
      "huge size": withTarget({ ...target, size: 2 ** 40 }),
      oversized: new Uint8Array(maxManifestBytes + 1),
    }).map(([name, value]) => [name, reason(value)]),
  ).toEqual([
    ["not json", "json"],
    ["invalid utf-8", "json"],
    ["array", "json"],
    ["schema", "schema"],
    ["version", "version"],
    ["version with v", "version"],
    ["commit", "source-commit"],
    ["minimum", "minimum-updater-version"],
    ["notes scheme", "notes-url"],
    ["notes missing", "notes-url"],
    ["targets", "targets"],
    ["foreign file", "target"],
    ["other file", "target"],
    ["target name", "target"],
    ["digest", "target"],
    ["zero size", "target"],
    ["fraction size", "target"],
    ["huge size", "target"],
    ["oversized", "size"],
  ]);
});

test("the release writer produces what the client parses", () => {
  const manifest = parseManifest(
    renderManifest({
      version: "2.0.0-rc.1",
      sourceCommit: "c".repeat(40),
      minimumUpdaterVersion: "1.0.0",
      repository: "Lazurio/LazurioPlatform",
      targets: {
        "linux-x64": { sha256: "d".repeat(64), size: 7 },
        "darwin-arm64": { sha256: "e".repeat(64), size: 8 },
      },
    }),
  );
  expect(manifest.notesUrl).toBe(
    "https://github.com/Lazurio/LazurioPlatform/releases/tag/v2.0.0-rc.1",
  );
  expect(Object.keys(manifest.targets)).toEqual(["darwin-arm64", "linux-x64"]);
  expect(manifest.targets["darwin-arm64"]?.file).toBe("lazurio-darwin-arm64");
});

test("a tag is v<version> and nothing else", () => {
  expect(tagOf("1.2.3-rc.1")).toBe("v1.2.3-rc.1");
  expect(versionOfTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
  for (const tag of ["1.2.3", "v1.2", "V1.2.3", "v1.2.3/x", "latest", 1])
    expect(versionOfTag(tag)).toBeUndefined();
});

test("version precedence is Semantic Versioning 2.0.0 and refuses invalid input", () => {
  const ascending = [
    "0.0.0-development",
    "0.0.1",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
    "2.0.0-rc.99999999999999999999",
    "2.0.0",
  ];
  for (let left = 0; left < ascending.length; left++)
    for (let right = 0; right < ascending.length; right++)
      expect(
        Math.sign(
          compareVersions(
            ascending[left] as string,
            ascending[right] as string,
          ),
        ),
      ).toBe(Math.sign(left - right));
  expect(() => compareVersions("1.0", "1.0.0")).toThrow();
});
