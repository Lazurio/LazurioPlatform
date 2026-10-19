import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as protocol from "../src/shell/guide-protocol";
import {
  acceptGuidePlay,
  createGuideReceiver,
  type GuideHostState,
  guideMessage,
  guideReply,
  guideVectorsSchema,
} from "../src/shell/guide-protocol";
import {
  describeVectors,
  readVectorFiles,
} from "./fixtures/browser-contract-vectors";

// The guide's protocol between Buddy's frame and the host page (decision
// F56; root decision 0180's addendum of 2026-10-18): the frame may only ask
// for an explanation by its id, and the host takes it only from the bubble's
// frame on exactly Buddy's origin, with exactly `type`, `v` and `explainer`,
// `v` 1, an id it knows on this page, and nothing else playing; otherwise it
// answers `busy`, or drops the message without an answer. Its executable
// vectors (`src/shell/guide-vectors/v1/`) are its truth, run here by the
// runner of the Environment browser's contract (decision F50), whose format
// they share: Buddy's web builds its sender against the same files. No
// listener exists until Buddy has an origin (plan DEV-6612 M7).

const vectorDirectory = join(
  import.meta.dir,
  "..",
  "src",
  "shell",
  "guide-vectors",
  "v1",
);
const files = readVectorFiles(vectorDirectory);

describeVectors(files, { pure: protocol, node: {} });

test("one v1 vector file of the guide's protocol, each case named once", () => {
  expect(readdirSync(vectorDirectory).sort()).toEqual(["guide-protocol.json"]);
  for (const file of files) {
    expect(file.schema).toBe(guideVectorsSchema);
    expect(`${file.contract}.json`).toBe(file.file);
    const named = file.cases.map((entry) => `${entry.call}: ${entry.name}`);
    expect(new Set(named).size).toBe(named.length);
  }
});

test("every export has a case and every case names an export, but the receiver, which needs windows", () => {
  const called = new Set(
    files.flatMap((file) => file.cases.map((entry) => entry.call)),
  );
  const exported = Object.keys(protocol).filter(
    (name) => name !== "createGuideReceiver",
  );
  expect([...called].sort()).toEqual(exported.sort());
});

const origin = "https://buddy.example.lazurio.io";
const host = (over: Partial<GuideHostState> = {}): GuideHostState => ({
  buddyOrigin: origin,
  known: ["files", "files-team"],
  playing: null,
  tour: false,
  ...over,
});
const play = (explainer = "files") => ({
  type: guideMessage.play,
  v: 1,
  explainer,
});

test("only the id is copied: the decision holds exactly the action and the id", () => {
  const decision = acceptGuidePlay(
    { data: play(), origin, fromBuddyFrame: true },
    host(),
  );
  expect(decision).toEqual({ action: "play", explainer: "files" });
  expect(Object.keys(decision ?? {}).sort()).toEqual(["action", "explainer"]);
});

test("a message whose prototype is not a plain object's is refused", () => {
  const strange = Object.assign(Object.create({ html: "<b>x</b>" }), play());
  expect(
    acceptGuidePlay({ data: strange, origin, fromBuddyFrame: true }, host()),
  ).toBeNull();
});

test("an answer holds exactly type, v, explainer and a known kind, nothing else", () => {
  expect(guideReply("started", "files", "team")).toEqual({
    type: "lazurio.guide.started",
    v: 1,
    explainer: "files",
    kind: "team",
  });
  const without = guideReply("busy", "files", null);
  expect(without).toEqual({
    type: "lazurio.guide.busy",
    v: 1,
    explainer: "files",
  });
  expect(Object.keys(without ?? {}).sort()).toEqual(["explainer", "type", "v"]);
  // A text is never a kind.
  expect(
    Object.keys(guideReply("done", "files", "Týmové") ?? {}),
  ).not.toContain("kind");
});

type Posted = { message: unknown; target: string };
function frameOf(posted: Posted[]) {
  return {
    postMessage(message: unknown, target: string) {
      posted.push({ message, target });
    },
  };
}

test("the receiver plays an accepted request and answers every state to exactly Buddy's origin, never *", () => {
  const posted: Posted[] = [];
  const frame = frameOf(posted);
  const played: string[] = [];
  let playing: string | null = null;
  const receiver = createGuideReceiver({
    origin,
    frame: () => frame,
    known: () => ["files"],
    playing: () => playing,
    tour: () => false,
    kind: () => "automated",
    play: (explainer) => {
      played.push(explainer);
    },
  });
  expect(receiver.receive({ data: play(), origin, source: frame })).toEqual({
    action: "play",
    explainer: "files",
  });
  expect(played).toEqual(["files"]);
  for (const state of ["started", "done", "closed"] as const)
    expect(receiver.reply(state, "files")).toBe(true);
  // While one plays, another request is answered busy, and nothing plays.
  playing = "files";
  receiver.receive({ data: play(), origin, source: frame });
  expect(played).toEqual(["files"]);
  expect(posted.map(({ target }) => target)).toEqual([
    origin,
    origin,
    origin,
    origin,
  ]);
  expect(posted.map(({ message }) => message)).toEqual([
    { type: "lazurio.guide.started", v: 1, explainer: "files", kind: "work" },
    { type: "lazurio.guide.done", v: 1, explainer: "files", kind: "work" },
    { type: "lazurio.guide.closed", v: 1, explainer: "files", kind: "work" },
    { type: "lazurio.guide.busy", v: 1, explainer: "files", kind: "work" },
  ]);
});

test("the receiver answers nothing to a refused request, another frame, or before the frame exists", () => {
  const posted: Posted[] = [];
  const frame = frameOf(posted);
  const other = frameOf(posted);
  let current: typeof frame | null = null;
  const played: string[] = [];
  const receiver = createGuideReceiver({
    origin,
    frame: () => current,
    known: () => ["files"],
    playing: () => null,
    tour: () => true,
    kind: () => "work",
    play: (explainer) => {
      played.push(explainer);
    },
  });
  // The frame is not loaded yet: its window is not the bubble's.
  expect(receiver.receive({ data: play(), origin, source: frame })).toBeNull();
  current = frame;
  // Another frame on Buddy's origin, another origin, an unknown id.
  expect(receiver.receive({ data: play(), origin, source: other })).toBeNull();
  expect(
    receiver.receive({
      data: play(),
      origin: "https://evil.example",
      source: frame,
    }),
  ).toBeNull();
  expect(
    receiver.receive({ data: play("billing"), origin, source: frame }),
  ).toBeNull();
  expect(posted).toEqual([]);
  // Začínáme wants attention: busy, to Buddy's origin only, nothing played.
  receiver.receive({ data: play(), origin, source: frame });
  expect(played).toEqual([]);
  expect(posted).toEqual([
    {
      message: {
        type: "lazurio.guide.busy",
        v: 1,
        explainer: "files",
        kind: "work",
      },
      target: origin,
    },
  ]);
});

test("a receiver with an origin that is no https origin answers nothing", () => {
  const posted: Posted[] = [];
  const frame = frameOf(posted);
  const receiver = createGuideReceiver({
    origin: "*",
    frame: () => frame,
    known: () => ["files"],
    playing: () => null,
    tour: () => false,
    kind: () => "work",
    play: () => undefined,
  });
  expect(receiver.receive({ data: play(), origin: "*", source: frame })).toBe(
    null,
  );
  expect(receiver.reply("started", "files")).toBe(false);
  expect(posted).toEqual([]);
});

test("until Buddy has an origin, the shell registers no listener for the protocol", async () => {
  // The shell's script (src/shell/index.ts over elements.ts) defines the
  // elements; neither the elements nor the guide's engine wire the
  // protocol's receiver to a message listener in this release (plan
  // DEV-6612: the wiring comes with milestone M7). The page's one message
  // listener is the Environment browser's identity answer.
  const listeners = (source: string) =>
    source.match(/addEventListener\(\s*"message"/g)?.length ?? 0;
  for (const file of [
    "src/shell/elements.ts",
    "src/shell/guide.ts",
    "src/shell/guide-layer.ts",
    "src/shell/guide-content.ts",
    "src/shell/guide-scenes.ts",
    "src/shell/guide-stage.ts",
    "src/shell/index.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect({ file, receiver: source.includes("createGuideReceiver") }).toEqual({
      file,
      receiver: false,
    });
    expect({
      file,
      listeners: listeners(source),
    }).toEqual({ file, listeners: file === "src/shell/elements.ts" ? 1 : 0 });
  }
  const elements = await readFile("src/shell/elements.ts", "utf8");
  const at = elements.indexOf('addEventListener("message"');
  expect(elements.slice(at - 500, at)).toContain("createIdentityResponder");
});
