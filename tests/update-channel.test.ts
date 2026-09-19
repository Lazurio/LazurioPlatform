import { expect, test } from "bun:test";
import { parseChannelDocument } from "../src/update/channel";
import { UpdateFailure } from "../src/update/errors";
import { compareVersions } from "../src/update/version";

const sha = "a".repeat(64);
const document = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      sequence: 3,
      version: "1.2.0",
      minimumVersion: "1.0.0",
      targets: { "linux-x64": `artifacts/${sha}/lazurio` },
      ...overrides,
    }),
  );
const reason = (bytes: Buffer, channel: "stable" | "preview" = "stable") => {
  try {
    parseChannelDocument(bytes, channel);
    return "accepted";
  } catch (error) {
    return error instanceof UpdateFailure
      ? `${error.failure.code}:${error.failure.context.reason}`
      : "threw";
  }
};

test("the channel parser accepts exactly the documented shape for the requested channel", () => {
  const parsed = parseChannelDocument(document(), "stable");
  expect(parsed).toMatchObject({
    channel: "stable",
    sequence: 3,
    version: "1.2.0",
    minimumVersion: "1.0.0",
    targets: { "linux-x64": `artifacts/${sha}/lazurio` },
  });
  expect(parsed.documentSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(reason(document({ channel: "preview" }), "preview")).toBe("accepted");
  expect(reason(document(), "preview")).toBe("channel-invalid:wrong-channel");
  expect(reason(document({ channel: "pilot" }))).toBe(
    "channel-invalid:wrong-channel",
  );
  expect(reason(document({ schemaVersion: 2 }))).toBe(
    "channel-invalid:unsupported-schema",
  );
  expect(reason(document({ extra: true }))).toBe(
    "channel-invalid:unknown-fields",
  );
  expect(reason(document({ sequence: 0 }))).toBe("channel-invalid:sequence");
  expect(reason(document({ sequence: 1.5 }))).toBe("channel-invalid:sequence");
  expect(reason(document({ version: "1.2" }))).toBe("channel-invalid:version");
  expect(reason(document({ minimumVersion: 1 }))).toBe(
    "channel-invalid:version",
  );
  for (const targets of [
    { "windows-x64": `artifacts/${sha}/lazurio` },
    { "linux-x64": `artifacts/${sha}/../lazurio` },
    { "linux-x64": `artifacts/${sha.slice(1)}/lazurio` },
    { "linux-x64": 7 },
    [],
  ])
    expect(reason(document({ targets }))).toBe("channel-invalid:targets");
  expect(reason(Buffer.from('{"schemaVersion":1,"schemaVersion":1}'))).toBe(
    "channel-invalid:malformed",
  );
  expect(reason(Buffer.from([0xff, 0xfe]))).toBe("channel-invalid:malformed");
});

test("version precedence follows Semantic Versioning, so 'never downgrade' is exact", () => {
  const ascending = [
    "0.0.0-development",
    "0.0.0",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.2.0",
    "1.10.0",
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
