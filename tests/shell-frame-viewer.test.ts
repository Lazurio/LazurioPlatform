import { expect, test } from "bun:test";
import { parseShellAccount } from "../src/shell/contract";
import { versionFrame } from "../src/shell/env-frame";
import { accountDocument } from "./fixtures/account-document";
import { observedState } from "./fixtures/shell-state";

// Review of #1244: the frame decides whose Environment a page is only from
// an identity verified for whoever views the page now, never from the account
// this origin remembered (the Environment operator's), and a page of an
// Environment whose document could not be read is framed, never left out.

const identity = {
  subject: "https://auth.example/realms/workspace/1111",
  githubId: 9301,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const changed = (state: { listen: (f: () => void) => () => void }) =>
  new Promise<void>((done) => {
    const stop = state.listen(() => {
      stop();
      done();
    });
  });

test("this origin's fresh answer is the viewer; its identity decides", async () => {
  const { state } = observedState("origin", () =>
    json(200, accountDocument({ identity })),
  );
  expect(state.viewer()).toBeNull();
  const read = changed(state);
  state.requestAccount();
  state.documentUnavailable();
  await read;
  expect(state.viewer()?.identity).toEqual(identity);
});

test("a read that found no account leaves the viewer unknown", async () => {
  const { state } = observedState("origin", () => json(404, {}));
  state.requestAccount();
  state.documentUnavailable();
  // The read settles without a change to draw; wait for it.
  for (let i = 0; i < 50 && state.viewer() === null; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(state.viewer()).toBeNull();
});

test("a host's page provides the account it verified", () => {
  const { state } = observedState("host");
  const account = parseShellAccount(accountDocument({ identity }));
  if (account === null) throw new Error("fixture");
  state.provideAccount(account);
  expect(state.viewer()?.identity).toEqual(identity);
});

test("an Environment's page whose document could not be read is framed red, without a label", () => {
  const { state } = observedState("origin", () => json(404, {}));
  expect(state.documentMissing()).toBe(false);
  state.requestAccount();
  state.documentUnavailable();
  expect(state.documentMissing()).toBe(true);
  expect(versionFrame(undefined, null, null, "cs", true)).toEqual({
    tone: "red",
    dashed: false,
    version: null,
    environment: null,
  });
  expect(versionFrame(undefined, null, "dev", "cs", true)?.version).toBe("DEV");
  // A page that is no Environment's (a production Application) stays unframed.
  expect(versionFrame(undefined, null, null, "cs", false)).toBeNull();
});
