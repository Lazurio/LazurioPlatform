import type { ShellEnvironmentKind } from "./contract";
import type { ShellIcon } from "./icons";
import { type KindLocale, kindName, shownKind } from "./kind-name";

// The principles in motion (decision F56's addendum (3) of 2026-10-19; plan
// DEV-6612, slice 6 of the lane): the scene the guide's card plays above its
// buttons while a principle explains, one beat a step. A port of the story,
// beats and look of the Lazurio prototype's scenes (prototypes-lazurio
// bebea85, app/v1/src/BuddyGuide.tsx and guide-parts.tsx), not of its code,
// after the brand's video standard (design-system-lazurio
// content/brand/video/video.md): a light paper stage of 320 × 180, white
// objects, blue for the answer, the expressive vermilion only for "no", one
// subject at a time.
//
// Pure data: which objects stand where in each beat, whether they are on
// stage, the words of their state the stylesheet draws (guide-scene-styles.ts)
// and when they move; guide-stage.ts builds it in the guide's shadow root and
// sets a beat. The step's text stays the card's and the accessible content:
// a scene adds no sentence, only the names of the things it draws, and is
// hidden from assistive technology. Internal to the shell, keyed by a
// principle's id and its step, never part of interface v1: a host's own
// explanation has none. Trezor keeps its approved video (the Launchpad's
// guide-video.ts) and has no scene.
//
// Its rules (tests/shell-guide-scenes.test.ts): no "=" and no words of
// sameness, the person's laptop is never the agents' computer, two devices
// with Lazurio as a window into theirs; the way from the Osobní to the
// Pracovní Prostředí is one straight solid arrow, pointing from the first to
// the second; three kinds of Environment; at most three words a label.

type Words = Readonly<Record<KindLocale, string>>;
type Point = readonly [number, number];

/** What an object does in each beat of its scene, one entry a beat. */
export type SceneBeats = Readonly<{
  /** Where it stands, in the stage's units from its parent's corner. */
  at: readonly Point[];
  /** Whether it is on stage. */
  show: readonly boolean[];
  /** The words of its state the stylesheet draws (`data-state`). */
  state: readonly string[];
  /** How long it waits before it moves, in milliseconds (motion only). */
  delay: readonly number[];
  /** Its size against how it is drawn. */
  scale: readonly number[];
}>;

/** One element of a scene: its parts (classes of the stylesheet, without
 * their `s-` prefix), its words, a leading icon or the Lazurio symbol, a size
 * in units, a line (its length and angle in degrees from where it stands),
 * what it does per beat when it moves at all, and what it holds. */
export type SceneNode = Readonly<{
  part: string;
  text?: string;
  icon?: ShellIcon;
  logo?: true;
  size?: Point;
  line?: Point;
  beats?: SceneBeats;
  children?: readonly SceneNode[];
}>;

/** A scene as one step of a principle plays it. */
export type GuideScene = Readonly<{
  /** The principle's id. */
  id: string;
  /** The scene in its words: drawn afresh when it changes. */
  key: string;
  /** Its beats, one a step of the principle. */
  beats: number;
  /** The beat of this step. */
  beat: number;
  /** What the stage holds. */
  objects: readonly SceneNode[];
}>;

type PerBeat<T> = T | ((beat: number) => T);

type Spec = Readonly<{
  at: PerBeat<Point>;
  show?: PerBeat<boolean>;
  state?: PerBeat<string>;
  delay?: PerBeat<number>;
  scale?: PerBeat<number>;
}>;

type Extra = Omit<SceneNode, "part" | "beats">;

/** The words a scene draws, in each language. */
const words = {
  agentsComputer: { cs: "počítač agentů", en: "agents' computer" },
  yourComputer: { cs: "váš počítač", en: "your computer" },
  environment: { cs: "Prostředí", en: "Environment" },
  admin: { cs: "Admin", en: "Admin" },
  stranger: { cs: "cizí", en: "stranger" },
  agent: { cs: "agent", en: "agent" },
  you: { cs: "Vy", en: "You" },
  chat: { cs: "Chat", en: "Chat" },
  contract: { cs: "Smlouva.pdf", en: "Contract.pdf" },
  report: { cs: "Report.pdf", en: "Report.pdf" },
  askLink: { cs: "Odkaz?", en: "Link?" },
  downloads: { cs: "Stažené", en: "Downloads" },
  files: { cs: "Soubory", en: "Files" },
  mail: { cs: "E-mail", en: "Email" },
  calendar: { cs: "Kalendář", en: "Calendar" },
  signedIn: { cs: "přihlášeno", en: "signed in" },
  notSignedIn: { cs: "nepřihlášeno", en: "not signed in" },
} as const satisfies Readonly<Record<string, Words>>;

type Draw = Readonly<{
  /** An object of this scene: what it does in each beat. */
  o: (part: string, spec: Spec, extra?: Extra) => SceneNode;
  say: (key: keyof typeof words) => string;
  locale: KindLocale;
  /** The agents' computer as the scene names it: the kind it plays in. */
  computerLabel: string;
}>;

/** A value per beat, from a list. */
const per =
  <T>(values: readonly T[]) =>
  (beat: number): T =>
    values[Math.min(beat, values.length - 1)] as T;

const each = <T>(beats: number, value: PerBeat<T>): readonly T[] =>
  Object.freeze(
    Array.from({ length: beats }, (_, beat) =>
      typeof value === "function"
        ? (value as (beat: number) => T)(beat)
        : value,
    ),
  );

/** A part of an object, with its words or what it holds. */
const p = (part: string, extra: Extra = {}): SceneNode => ({ part, ...extra });
const tag = (text: string, tone = ""): SceneNode =>
  p(`tag${tone ? ` ${tone}` : ""}`, { text });
const agent = (small = false, label?: string): SceneNode =>
  p("agent", {
    children: [
      p(small ? "dot sm" : "dot", { icon: "bot" }),
      ...(label === undefined ? [] : [tag(label)]),
    ],
  });
const person = (name: string): SceneNode =>
  p("person", { children: [p("head", { icon: "user" }), tag(name)] });
const you = (name: string): SceneNode =>
  p("you", { icon: "cursor", children: [tag(name, "ink")] });
const lines = (count: number): SceneNode[] =>
  Array.from({ length: count }, () => p("i"));
const title = (text: string, icon?: ShellIcon): SceneNode =>
  p("title", icon === undefined ? { text } : { text, icon });

/** The agents' virtual computer, the picture the scenes come back to: a
 * screen of the kind it plays in, its own browser and apps (`apps`), and an
 * agent's cursor working in it (`work`). It lives elsewhere, never on the
 * person's laptop. */
const computer = (draw: Draw): SceneNode =>
  p("pc", {
    children: [
      p("screen", {
        children: [
          p("bar", {
            icon: "cloud",
            children: [p("name", { text: draw.computerLabel })],
          }),
          p("desk", {
            children: [
              p("win", {
                children: [
                  p("wbar", { icon: "globe", children: [p("i")] }),
                  p("wbody", { children: lines(3) }),
                ],
              }),
              p("dock", {
                children: (
                  ["globe", "mail", "calendar", "folder"] as const
                ).map((icon) => p("app", { icon })),
              }),
              p("acursor", {
                icon: "cursor",
                children: [tag(draw.say("agent"))],
              }),
            ],
          }),
        ],
      }),
      p("stand"),
    ],
  });

/** The person's own laptop, a device of its own: its browser shows Lazurio,
 * and Lazurio is a window into the agents' computer, their screen small in
 * it with an eye. Looking in, never one computer. */
const laptop = (draw: Draw): SceneNode =>
  p("pc laptop", {
    children: [
      p("screen", {
        children: [
          p("bar", { logo: true, children: [p("name", { text: "Lazurio" })] }),
          p("desk", {
            children: [
              p("peek", {
                children: [
                  p("pscreen", {
                    children: [
                      p("pwin", { children: lines(3) }),
                      p("pdock", { children: lines(4) }),
                    ],
                  }),
                  p("peye", { icon: "eye" }),
                ],
              }),
              p("ycursor", { children: [you(draw.say("you"))] }),
            ],
          }),
        ],
      }),
      p("stand"),
    ],
  });

const personal = (locale: KindLocale) => kindName("personal", { locale });
const work = (locale: KindLocale) => kindName("work", { locale });

type Scene = Readonly<{ beats: number; draw: (draw: Draw) => SceneNode[] }>;

const scenes: Readonly<Record<string, Scene>> = {
  /** 1: the Environment is your agents' virtual computer, with its own
   * browser and apps, where they work; at the end two devices stand apart,
   * their computer in the cloud and yours, and Lazurio in your browser is a
   * window into theirs: an eye, and one straight solid arrow from that
   * window to their computer. Never an "=". */
  environment: {
    beats: 4,
    draw: (draw) => [
      draw.o(
        "zoom",
        {
          at: (b) => (b >= 3 ? [6, 44] : [47, 8]),
          scale: (b) => (b >= 3 ? 0.56 : 1),
          state: per(["", "apps", "apps work", "apps work"]),
        },
        { children: [computer(draw)] },
      ),
      draw.o(
        "tag",
        { at: [10, 18], show: (b) => b >= 3, delay: 300 },
        { icon: "cloud", text: draw.say("agentsComputer") },
      ),
      draw.o(
        "zoom",
        { at: [170, 44], scale: 0.6, show: (b) => b >= 3, delay: 450 },
        { children: [laptop(draw)] },
      ),
      draw.o(
        "tag ink",
        { at: [190, 18], show: (b) => b >= 3, delay: 600 },
        { text: draw.say("yourComputer") },
      ),
      draw.o(
        "line arrow",
        { at: [185, 84], show: (b) => b >= 3, delay: 900 },
        { line: [47, 180] },
      ),
    ],
  },
  /** 2: the Osobní Prostředí: Admin and strangers stop at its blue border;
   * beside it a Pracovní Prostředí, which belongs to the Organization, and
   * its Admin walks in. */
  buddy: {
    beats: 4,
    draw: ({ o, say, locale }) => [
      o(
        "box mine",
        { at: [14, 14], state: (b) => (b >= 1 ? "guard" : "") },
        {
          size: [132, 112],
          children: [
            title(personal(locale)),
            p("center", { children: [p("head lg", { icon: "user" })] }),
            p("corner", { icon: "lock" }),
          ],
        },
      ),
      o(
        "box org",
        { at: [174, 14], show: (b) => b >= 2 },
        { size: [132, 112], children: [title(work(locale), "building")] },
      ),
      o(
        "who",
        {
          at: per<Point>([
            [250, 50],
            [156, 22],
            [204, 132],
            [222, 50],
          ]),
          show: (b) => b >= 1,
          state: (b) => (b === 1 ? "knock" : ""),
        },
        { children: [person(say("admin"))] },
      ),
      o(
        "who",
        { at: [156, 72], show: (b) => b === 1, state: "knock" },
        { children: [person(say("stranger"))] },
      ),
      o(
        "mark no",
        { at: [139, 34], show: (b) => b === 1, delay: 500 },
        { icon: "xmark" },
      ),
      o(
        "mark no",
        { at: [139, 84], show: (b) => b === 1, delay: 650 },
        { icon: "xmark" },
      ),
      o(
        "mark",
        { at: [258, 52], show: (b) => b >= 3, delay: 500 },
        { icon: "check" },
      ),
    ],
  },
  /** 3: where agents may go: from the Osobní Prostředí into work, along one
   * straight solid arrow from it to the Pracovní Prostředí (the agent rides
   * above it, so nothing breaks the line); an agent from work stops at the
   * Osobní Prostředí's border; one way only. */
  reach: {
    beats: 4,
    draw: ({ o, locale }) => [
      o(
        "box mine",
        { at: [8, 30], state: (b) => (b === 2 ? "guard" : "") },
        {
          size: [120, 104],
          children: [
            title(personal(locale)),
            p("center", { children: [p("head lg", { icon: "user" })] }),
          ],
        },
      ),
      o(
        "box org",
        { at: [192, 30] },
        { size: [120, 104], children: [title(work(locale), "building")] },
      ),
      o(
        "line arrow",
        {
          at: [134, 66],
          show: (b) => b >= 1,
          state: (b) => (b >= 3 ? "strong" : ""),
        },
        { line: [50, 0] },
      ),
      o(
        "agent-at",
        { at: [148, 38], show: (b) => b === 1 || b === 3, state: "travel" },
        { children: [agent()] },
      ),
      o(
        "agent-at",
        { at: [138, 92], show: (b) => b === 2, state: "bump" },
        { children: [agent()] },
      ),
      o(
        "mark no",
        { at: [119, 94], show: (b) => b === 2, delay: 900 },
        { icon: "xmark" },
      ),
    ],
  },
  /** 4: Soubory: you drop a file into the chat and an agent answers; you
   * ask for a link, it answers with one, and the link downloads the file;
   * then the camera travels to the page Soubory, which only shows what the
   * agents work with. */
  files: {
    beats: 4,
    draw: ({ o, say }) => [
      o(
        "strip",
        { at: (b) => (b >= 3 ? [-320, 0] : [0, 0]) },
        {
          children: [
            o(
              "box",
              { at: [12, 6], state: (b) => (b === 0 ? "hot" : "") },
              {
                size: [198, 150],
                children: [title(say("chat"), "chat"), p("composer")],
              },
            ),
            o(
              "chip",
              { at: [104, 28], state: (b) => (b === 0 ? "hot drag" : "") },
              {
                icon: "page",
                text: say("contract"),
                children: [p("hand", { children: [you(say("you"))] })],
              },
            ),
            o(
              "bubble answer",
              { at: [26, 62], show: (b) => b === 0, delay: 1700 },
              {
                children: [
                  p("dot sm", { icon: "bot" }),
                  p("typing", { children: lines(3) }),
                ],
              },
            ),
            o(
              "bubble ask",
              { at: [104, 60], show: (b) => b >= 1 },
              { icon: "link", text: say("askLink") },
            ),
            o(
              "bubble answer",
              {
                at: [26, 90],
                show: (b) => b >= 1,
                delay: (b) => (b === 1 ? 1000 : 0),
                state: (b) => (b === 2 ? "hot" : ""),
              },
              {
                children: [
                  p("dot sm", { icon: "bot" }),
                  p("link", { icon: "download", text: say("report") }),
                ],
              },
            ),
            o(
              "line",
              { at: [134, 102], show: (b) => b >= 2 },
              { line: [88, 0] },
            ),
            o(
              "tap",
              { at: [92, 100], show: (b) => b === 2, state: "tap" },
              { children: [you(say("you"))] },
            ),
            o(
              "box",
              { at: [226, 76], show: (b) => b >= 2, delay: 400 },
              {
                size: [86, 54],
                children: [
                  title(say("downloads"), "download"),
                  p("tray", { icon: "page", text: say("report") }),
                ],
              },
            ),
            o(
              "box",
              { at: [340, 8], show: (b) => b >= 3 },
              { size: [280, 140], children: [title(say("files"), "folder")] },
            ),
            o(
              "chip",
              { at: [358, 42], show: (b) => b >= 3, delay: 350 },
              { icon: "page", text: say("contract") },
            ),
            o(
              "chip",
              { at: [358, 84], show: (b) => b >= 3, delay: 500, state: "hot" },
              { icon: "page", text: say("report") },
            ),
            o(
              "agent-at",
              {
                at: [470, 58],
                show: (b) => b >= 3,
                delay: 750,
                state: "moving",
              },
              { children: [agent(false, say("agent"))] },
            ),
            o(
              "eye",
              { at: [550, 86], show: (b) => b >= 3, delay: 1000 },
              { icon: "eye" },
            ),
          ],
        },
      ),
    ],
  },
  /** 5: Integrace: you sign the agents' computer in to e-mail, and agents
   * can go there; where nothing is signed in (the calendar, neutral: no
   * lock, no red), they simply do not reach; where you sign it in, agents
   * can go, a second one comes. */
  integrations: {
    beats: 4,
    draw: (draw) => [
      draw.o(
        "zoom",
        { at: [8, 40], scale: 0.6, state: "apps" },
        { children: [computer(draw)] },
      ),
      draw.o(
        "line",
        {
          at: [150, 74],
          show: (b) => b >= 1,
          state: (b) => (b >= 3 ? "strong" : ""),
        },
        { line: [60, -26] },
      ),
      draw.o(
        "tile",
        { at: [208, 20], state: (b) => (b === 0 ? "on sign" : "on") },
        {
          children: [
            p("tname", { icon: "mail", text: draw.say("mail") }),
            p("status", { text: draw.say("signedIn") }),
          ],
        },
      ),
      draw.o(
        "tile",
        { at: [208, 102], state: (b) => (b >= 2 ? "off" : "") },
        {
          children: [
            p("tname", { icon: "calendar", text: draw.say("calendar") }),
            p("status", { text: draw.say("notSignedIn") }),
          ],
        },
      ),
      draw.o(
        "key",
        { at: [176, 24], show: (b) => b === 0, state: "turn" },
        { icon: "key" },
      ),
      draw.o(
        "tap",
        { at: [276, 24], show: (b) => b === 0, state: "tap" },
        { children: [you(draw.say("you"))] },
      ),
      draw.o(
        "agent-at",
        {
          at: (b) => (b >= 1 ? [282, 10] : [104, 52]),
          state: (b) => (b >= 1 ? "moving" : ""),
        },
        { children: [agent(true)] },
      ),
      draw.o(
        "agent-at",
        {
          at: (b) => (b >= 3 ? [262, 10] : [122, 70]),
          state: (b) => (b >= 3 ? "moving" : ""),
        },
        { children: [agent(true)] },
      ),
    ],
  },
};

/** The ids of the principles that have a scene, in the tour's order. */
export const sceneIds: readonly string[] = Object.freeze(Object.keys(scenes));

/** How the scene of a principle names the agents' computer in an Environment
 * of `kind`: its kind (an automated Environment is a work one), else the
 * plain word; on your own computer the picture still shows the agents'
 * computer in the cloud, as the prototype's does. */
function computerLabel(
  kind: ShellEnvironmentKind | null,
  locale: KindLocale,
): string {
  if (kind === null || shownKind(kind) === "workstation")
    return words.environment[locale];
  return kindName(kind, { locale });
}

const built = new Map<string, readonly SceneNode[]>();

/** The scene of the principle `id` at its step `stop` (its beat), in
 * `locale` and the words of an Environment of `kind`; null for an id that
 * has none (Trezor, a host's explanation). */
export function guideScene(
  id: string,
  stop: number,
  locale: KindLocale,
  kind: ShellEnvironmentKind | null,
): GuideScene | null {
  if (!Object.hasOwn(scenes, id)) return null;
  const scene = scenes[id] as Scene;
  const label = computerLabel(kind, locale);
  const key = `${id}:${locale}:${label}`;
  let objects = built.get(key);
  if (objects === undefined) {
    const o = (part: string, spec: Spec, extra: Extra = {}): SceneNode => ({
      part,
      ...extra,
      beats: Object.freeze({
        at: each(scene.beats, spec.at),
        show: each(scene.beats, spec.show ?? true),
        state: each(scene.beats, spec.state ?? ""),
        delay: each(scene.beats, spec.delay ?? 0),
        scale: each(scene.beats, spec.scale ?? 1),
      }),
    });
    objects = Object.freeze(
      scene.draw({
        o,
        say: (name) => words[name][locale],
        locale,
        computerLabel: label,
      }),
    );
    built.set(key, objects);
  }
  return Object.freeze({
    id,
    key,
    beats: scene.beats,
    beat: Math.max(0, Math.min(stop, scene.beats - 1)),
    objects,
  });
}
