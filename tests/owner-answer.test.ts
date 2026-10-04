import { expect, test } from "bun:test";
import { ownerCheck } from "../src/launchpad/organization-owner";
import {
  createOwnerAnswers,
  ownerAnswerMs,
} from "../src/launchpad/owner-answer";

// Decision F36 addendum of 2026-10-04: the page's copy of GitHub's Owner
// answer stands as long as the Launchpad's own, is asked again after it (the
// page wakes at that moment), after a change of the bound login and after a
// catalog read, keeps the last answer while it is being asked again, and
// takes only the answer to the question it is asking now.

test("the page and the Launchpad keep an answer equally long", () => {
  expect(ownerCheck.cacheMs).toBe(ownerAnswerMs);
});

test("an answer is asked once, stands until it expires, then is asked again while the last one shows", () => {
  let now = 1_000;
  const answers = createOwnerAnswers(() => now);
  const first = answers.read("alpha", "alpha-forge");
  expect(first.owner).toBe(false);
  expect(first.ask).not.toBeNull();
  // Being asked: no second question, nothing shown yet.
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: false,
    ask: null,
  });
  answers.settle("alpha", "alpha-forge", first.ask as number, true);
  expect(answers.nextExpiry()).toBe(1_000 + ownerAnswerMs);
  now += ownerAnswerMs - 1;
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: true,
    ask: null,
  });
  now += 1;
  // Expired: asked again, and the last answer stands meanwhile.
  const again = answers.read("alpha", "alpha-forge");
  expect(again.owner).toBe(true);
  expect(again.ask).not.toBeNull();
  expect(answers.nextExpiry()).toBeNull();
  answers.settle("alpha", "alpha-forge", again.ask as number, false);
  expect(answers.read("alpha", "alpha-forge").owner).toBe(false);
});

test("an answer to a question no longer asked changes nothing: after a catalog read, or overtaken", () => {
  const answers = createOwnerAnswers(() => 0);
  const a = answers.read("alpha", "alpha-forge").ask as number;
  answers.clear();
  const b = answers.read("alpha", "alpha-forge").ask as number;
  answers.settle("alpha", "alpha-forge", b, false);
  // The older question's late "yes" does not restore the Owner offer.
  answers.settle("alpha", "alpha-forge", a, true);
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: false,
    ask: null,
  });
  // A late answer after a catalog read is dropped too.
  const c = answers.read("beta", "beta-forge").ask as number;
  answers.clear();
  answers.settle("beta", "beta-forge", c, true);
  expect(answers.read("beta", "beta-forge").owner).toBe(false);
});

test("another bound login is another question; a catalog read forgets every answer", () => {
  const answers = createOwnerAnswers(() => 0);
  const ask = answers.read("alpha", "alpha-forge").ask as number;
  answers.settle("alpha", "alpha-forge", ask, true);
  expect(answers.read("alpha", "Alpha-Forge")).toEqual({
    owner: true,
    ask: null,
  });
  expect(answers.read("alpha", "beta-forge").ask).not.toBeNull();
  answers.clear();
  expect(answers.nextExpiry()).toBeNull();
  expect(answers.read("alpha", "alpha-forge").ask).not.toBeNull();
});
