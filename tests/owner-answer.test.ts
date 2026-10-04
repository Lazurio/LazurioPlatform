import { expect, test } from "bun:test";
import { ownerCheck } from "../src/launchpad/organization-owner";
import {
  createOwnerAnswers,
  ownerAnswerMs,
} from "../src/launchpad/owner-answer";

// Decision F36 addendum of 2026-10-04: the page's copy of GitHub's Owner
// answer stands as long as the Launchpad's own, is asked again after it,
// after a change of the bound login and after a catalog read, and keeps the
// last answer while it is being asked again.

test("the page and the Launchpad keep an answer equally long", () => {
  expect(ownerCheck.cacheMs).toBe(ownerAnswerMs);
});

test("an answer is asked once, stands until it expires, then is asked again while the last one shows", () => {
  let now = 1_000;
  const answers = createOwnerAnswers(() => now);
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: false,
    ask: true,
  });
  // Being asked: no second request, nothing shown yet.
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: false,
    ask: false,
  });
  answers.settle("alpha", "alpha-forge", true);
  now += ownerAnswerMs - 1;
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: true,
    ask: false,
  });
  now += 1;
  // Expired: asked again, and the last answer stands meanwhile.
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: true,
    ask: true,
  });
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: true,
    ask: false,
  });
  answers.settle("alpha", "alpha-forge", false);
  expect(answers.read("alpha", "alpha-forge").owner).toBe(false);
});

test("another bound login is another question; a catalog read forgets every answer", () => {
  const answers = createOwnerAnswers(() => 0);
  answers.read("alpha", "alpha-forge");
  answers.settle("alpha", "alpha-forge", true);
  expect(answers.read("alpha", "Alpha-Forge")).toEqual({
    owner: true,
    ask: false,
  });
  expect(answers.read("alpha", "beta-forge")).toEqual({
    owner: false,
    ask: true,
  });
  answers.clear();
  expect(answers.read("alpha", "alpha-forge")).toEqual({
    owner: false,
    ask: true,
  });
});
