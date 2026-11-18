import { expect, test } from "bun:test";
import {
  MachineContextError,
  parseMachineContext,
} from "../src/machine/context";
import { binding, handoverEntry, withBuddy } from "./fixtures/machine-bindings";
import personal from "./fixtures/machine-context-personal.json";

// The vendored schema (HumanAndMachine-ai/Machines#1370) accepts two shapes
// whose reader this Platform does not implement yet, which Machines writes only
// for a Platform at or above their minimum: a personal owner keyed on the
// Lazurio account (plan PCH M4) and Buddy's origin in the personal zone (PCH
// M1). A handover with either is refused whole, never projected into a binding
// that would misread it; the same handover with today's shapes still binds.
// Every fixture is synthetic.

type Json = Record<string, unknown>;
const parse = (document: unknown) =>
  parseMachineContext(Buffer.from(JSON.stringify(document)));

test("a personal owner keyed on the Lazurio account is refused, the GitHub principal still binds", () => {
  const account = {
    ...(personal as Json),
    owner: {
      kind: "lazurio-account",
      issuer: "https://auth.example.invalid/realms/workspace",
      subject: "00000000-0000-4000-8000-0000000000c1",
      username: "example-person",
    },
  };
  expect(() => parse(account)).toThrow(MachineContextError);
  expect(binding(personal as Json).owner).toEqual({
    kind: "principal",
    githubLogin: "example",
    githubId: 12345,
  });
});

test("Buddy's origin in the personal zone is refused, his origin as before still binds", () => {
  const host = "example.lazurio.io";
  const before = {
    ...(personal as Json),
    entry: withBuddy(handoverEntry(host), host),
  };
  expect(binding(before).entry?.buddyOrigin).toBe(`https://buddy.${host}`);
  const zone = "example.personal.lazurio.io";
  const personalZone = {
    ...(personal as Json),
    entry: withBuddy(handoverEntry(zone), zone),
  };
  expect(() => parse(personalZone)).toThrow(MachineContextError);
});
