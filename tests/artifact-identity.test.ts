import { expect, test } from "bun:test";
import { artifactIdentity } from "../scripts/artifact-identity";

const input = {
  version: "0.1.0-preview.1",
  target: "darwin-arm64",
  sourceCommit: "a".repeat(40),
  toolchain: "bun@1.4.2",
  lockfile: new TextEncoder().encode("fixture lock"),
  artifact: new TextEncoder().encode("fixture artifact"),
};

test("identity is deterministic and binds artifact and lockfile independently", () => {
  const identity = artifactIdentity(input);
  expect(artifactIdentity(input)).toEqual(identity);
  expect(identity.artifactBytes).toBe(input.artifact.byteLength);
  expect(
    artifactIdentity({ ...input, artifact: new Uint8Array([1]) })
      .artifactSha256,
  ).not.toBe(identity.artifactSha256);
  expect(
    artifactIdentity({ ...input, lockfile: new Uint8Array([1]) })
      .lockfileSha256,
  ).not.toBe(identity.lockfileSha256);
});

test("rejects ambiguous identity and empty inputs", () => {
  for (const change of [
    { version: "latest" },
    { version: "../1.0.0" },
    { version: "01.0.0" },
    { target: "linux" },
    { sourceCommit: "abc123" },
    { toolchain: "bun@latest" },
    { artifact: new Uint8Array() },
    { lockfile: new Uint8Array() },
  ])
    expect(() => artifactIdentity({ ...input, ...change })).toThrow();
});
