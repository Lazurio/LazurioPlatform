import { expect, test } from "bun:test";
import { assignmentText } from "../src/launchpad/machine-view";
import { messages } from "../src/launchpad/messages";

// The Launchpad's "This Environment" shows the recorded assignment as the
// Folder renders it (src/folder/render.ts assignmentLine): the Automated
// Environment of decision 0169 reads distinctly, naming its responsible
// operator, never as a plain operator assignment.
test.each([
  [
    "en",
    { kind: "operator", githubLogin: "example", githubId: 12345 },
    "example (GitHub id 12345)",
  ],
  ["en", { kind: "team" }, "shared by the Team"],
  [
    "en",
    { kind: "automation", githubLogin: "example", githubId: 12345 },
    "an automated Environment of an Organization persona; responsible operator example (GitHub id 12345)",
  ],
  [
    "cs",
    { kind: "operator", githubLogin: "example", githubId: 12345 },
    "example (GitHub id 12345)",
  ],
  ["cs", { kind: "team" }, "sdílený Teamem"],
  [
    "cs",
    { kind: "automation", githubLogin: "example", githubId: 12345 },
    "automatizovaný Environment persony Organizace; odpovědný operátor example (GitHub id 12345)",
  ],
] as const)(
  "the %s assignment line of %o reads %p",
  (locale, assignment, text) => {
    expect(assignmentText(assignment, messages(locale))).toBe(text);
  },
);
