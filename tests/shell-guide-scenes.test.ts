import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  parseShell,
  type Shell,
  type ShellEnvironmentKind,
  shellEnvironmentKinds,
} from "../src/shell/contract";
import {
  createGuide,
  type GuideActions,
  type GuideInvoker,
  type GuideView,
} from "../src/shell/guide";
import { principleIds, principleIn } from "../src/shell/guide-content";
import { guideSceneCss } from "../src/shell/guide-scene-styles";
import {
  type GuideScene,
  guideScene,
  type SceneNode,
  sceneIds,
} from "../src/shell/guide-scenes";
import {
  drawStage,
  type StageElement,
  type StageMaker,
} from "../src/shell/guide-stage";
import { guideLayerCss } from "../src/shell/guide-styles";
import { shellMessages } from "../src/shell/messages";
import { guideWordFindings } from "./fixtures/guide-text";

// The principles in motion (decision F56's addendum (3) of 2026-10-19): the
// scene a principle plays in the guide's card, one beat a step, on the real
// consumer, the shell's engine, with the page and the drawing faked (how it
// moves is checked in a browser, root decision 0178). Which step plays a
// scene and which none, the stage built and a beat set, the words it draws
// under the guide's rules (no "=" and no sameness: the person's laptop is
// never the agents' computer), the one straight solid arrow from the Osobní
// to the Pracovní Prostředí, and the finished frame of each beat where
// motion is reduced.

const locales = ["cs", "en"] as const;
const kinds: readonly (ShellEnvironmentKind | null)[] = [
  null,
  ...shellEnvironmentKinds,
];

/** A shell document whose current Environment is of `kind`. */
function shellOf(kind: ShellEnvironmentKind, locale: "cs" | "en"): Shell {
  const shell = parseShell({
    schema: "lazurio.shell.v1",
    locale,
    current: "vm-01.example",
    operator: { initials: null, login: null, avatar: null },
    environments: [
      {
        id: "vm-01.example",
        label: null,
        kind,
        organizations: ["example"],
        assignee: null,
        apps: {
          apps: "https://launchpad.vm-01.example.lazurio.io/",
          chat: null,
          automate: null,
        },
      },
    ],
    organizations: [
      {
        slug: "example",
        name: "Example",
        avatar: null,
        dashboard: "https://dashboard.lazurio.ai/orgs/example",
      },
    ],
    dashboard: "https://dashboard.lazurio.ai/",
    account: "https://dashboard.lazurio.ai/settings",
    addOrganization: null,
  });
  if (shell === null) throw new Error("The fixture is a valid document");
  return shell;
}

/** The engine over a faked page, as tests/shell-guide.test.ts has it: what
 * the layer is asked to draw. */
function fakePage(shell: Shell | null) {
  const drawn: { view: GuideView | null; actions: GuideActions }[] = [];
  let layers = 0;
  let help: ((id: string, invoker: GuideInvoker | null) => boolean) | null =
    null;
  const guide = createGuide({
    shell: () => shell,
    copy: shellMessages,
    follow: () => () => undefined,
    listenHelp: (play) => {
      help = play;
      return () => {
        help = null;
      };
    },
    layer: () => {
      layers += 1;
      return {
        draw(view, actions) {
          drawn.push({ view, actions });
        },
        say() {},
      };
    },
    announce: () => undefined,
  });
  return {
    guide,
    drawn,
    layers: () => layers,
    click: (id: string) => help?.(id, null) ?? false,
    last: () => drawn.at(-1) ?? null,
  };
}

/** Every scene a principle plays at each of its steps, as the engine hands
 * them to the layer. */
function played(
  id: string,
  kind: ShellEnvironmentKind,
  locale: "cs" | "en",
): (GuideScene | null)[] {
  const page = fakePage(shellOf(kind, locale));
  page.guide.attach({ getAttribute: () => locale });
  page.guide.provide([
    {
      id: "files-team",
      title: "Soubory",
      steps: [{ text: "Číst a měnit je může celý Team", at: "files-list" }],
    },
  ]);
  expect(page.click(id)).toBe(true);
  const scenes: (GuideScene | null)[] = [];
  for (;;) {
    const view = page.last()?.view;
    if (!view) throw new Error("A step is drawn");
    scenes.push(view.scene);
    if (view.stop === view.explanation.steps.length - 1) {
      page.last()?.actions.done();
      return scenes;
    }
    page.last()?.actions.step(view.stop + 1);
  }
}

test("every principle with a scene plays it at each step, one beat a step; Trezor and a host's explanation play none", () => {
  expect(sceneIds).toEqual([
    "environment",
    "buddy",
    "reach",
    "files",
    "integrations",
  ]);
  for (const locale of locales)
    for (const kind of shellEnvironmentKinds)
      for (const id of principleIds) {
        const scenes = played(id, kind, locale);
        const steps = principleIn(id, locale, kind)?.steps.length ?? 0;
        expect({ id, kind, locale, steps: scenes.length }).toEqual({
          id,
          kind,
          locale,
          steps,
        });
        if (id === "vault") {
          // Trezor keeps its approved video (the Launchpad's guide-video.ts).
          expect({ id, kind, scenes }).toEqual({
            id,
            kind,
            scenes: scenes.map(() => null),
          });
          continue;
        }
        expect({
          id,
          kind,
          beats: scenes.map((scene) => [scene?.id, scene?.beat, scene?.beats]),
        }).toEqual({
          id,
          kind,
          beats: scenes.map((_, stop) => [id, stop, steps]),
        });
      }
  // A page's own explanation has no scene: page scenes would be the host's.
  const page = fakePage(shellOf("team", "cs"));
  page.guide.attach({ getAttribute: () => "cs" });
  page.guide.provide([
    {
      id: "files-team",
      title: "Soubory",
      steps: [{ text: "Číst a měnit je může celý Team", at: "files-list" }],
    },
  ]);
  expect(page.click("files-team")).toBe(true);
  expect(page.last()?.view?.scene).toBeNull();
  expect(guideScene("files-team", 0, "cs", "team")).toBeNull();
  expect(guideScene("vault", 0, "cs", "work")).toBeNull();
});

test("a page that hands over nothing (a fork) gets no scene and nothing drawn", () => {
  const page = fakePage(shellOf("work", "cs"));
  page.guide.attach({ getAttribute: () => null });
  for (const id of principleIds) expect(page.click(id)).toBe(false);
  expect(page.guide.play("environment", null)).toBe(false);
  expect(page.layers()).toBe(0);
  expect(page.drawn).toEqual([]);
});

type FakeElement = StageElement & {
  readonly classes: () => string[];
  readonly attributes: Map<string, string>;
  readonly styles: Map<string, string>;
  readonly children: (FakeElement | string | object)[];
};

/** The elements the stage builds, recorded: their classes, attributes,
 * style and what they hold. */
function fakeMaker(): StageMaker & { icons: string[] } {
  const icons: string[] = [];
  const element = (): FakeElement => {
    const attributes = new Map<string, string>();
    const styles = new Map<string, string>();
    const children: (FakeElement | string | object)[] = [];
    const node = {
      className: "",
      dataset: {} as Record<string, string | undefined>,
      style: {
        setProperty(property: string, value: string) {
          styles.set(property, value);
        },
      },
      setAttribute(name: string, value: string) {
        attributes.set(name, value);
      },
      toggleAttribute(name: string, force: boolean) {
        if (force) attributes.set(name, "");
        else attributes.delete(name);
        return force;
      },
      append(...nodes: (FakeElement | string | object)[]) {
        children.push(...nodes);
      },
      classes: () => node.className.split(" ").filter(Boolean),
      attributes,
      styles,
      children,
    };
    return node;
  };
  return {
    icons,
    element,
    icon: (name) => {
      icons.push(name);
      return { icon: name };
    },
    logo: () => ({ logo: true }),
  };
}

/** Every element under `root`, itself included. */
function elementsOf(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children
      .filter(
        (child): child is FakeElement =>
          typeof child === "object" && "classes" in child,
      )
      .flatMap(elementsOf),
  ];
}

test("the stage builds a scene hidden from assistive technology and sets each beat's places, presence and state", () => {
  for (const id of sceneIds) {
    const scene = guideScene(id, 0, "cs", "work");
    if (scene === null) throw new Error(id);
    const stage = drawStage(scene, fakeMaker());
    const root = stage.element as FakeElement;
    expect(root.classes()).toEqual(["s-scene"]);
    expect(root.dataset.scene).toBe(id);
    // Decorative: the step's text is the accessible content, and nothing
    // in the scene names itself to assistive technology.
    expect([...root.attributes]).toEqual([["aria-hidden", "true"]]);
    const all = elementsOf(root);
    for (const each of all.slice(1))
      expect({
        id,
        aria: [...each.attributes.keys()].filter(
          (name) => name.startsWith("aria-") || name === "role",
        ),
      }).toEqual({ id, aria: [] });
    // Its objects are the nodes with beats, in the order they are drawn.
    const nodes: SceneNode[] = [];
    const walk = (node: SceneNode) => {
      if (node.beats !== undefined) nodes.push(node);
      for (const child of node.children ?? []) walk(child);
    };
    for (const node of scene.objects) walk(node);
    const objects = all.filter((each) => each.classes().includes("s-o"));
    expect(objects.length).toBe(nodes.length);
    for (let beat = 0; beat < scene.beats; beat += 1) {
      stage.beat(beat);
      expect(root.dataset.beat).toBe(String(beat));
      objects.forEach((element, index) => {
        const beats = nodes[index]?.beats;
        if (beats === undefined) throw new Error("An object has beats");
        const [x, y] = beats.at[beat] ?? [0, 0];
        const shown = beats.show[beat] === true;
        const line = nodes[index]?.line !== undefined;
        expect({
          id,
          beat,
          index,
          in: element.attributes.has("data-in"),
          translate: element.styles.get("translate"),
          state: element.dataset.state,
        }).toEqual({
          id,
          beat,
          index,
          in: shown,
          translate: `${x}px ${y + (shown || line ? 0 : 10)}px`,
          state: beats.state[beat] ?? "",
        });
      });
    }
    // Entering, every object stands at its place off stage, with no state
    // yet; the next beat brings them in.
    stage.enter(2);
    expect(objects.every((each) => !each.attributes.has("data-in"))).toBe(true);
    expect(objects.every((each) => each.dataset.state === "")).toBe(true);
  }
});

/** Every word a scene draws, in every language and kind. */
function sceneWords(): { id: string; text: string }[] {
  const found: { id: string; text: string }[] = [];
  for (const locale of locales)
    for (const kind of kinds)
      for (const id of sceneIds) {
        const walk = (node: SceneNode) => {
          if (node.text !== undefined) found.push({ id, text: node.text });
          for (const child of node.children ?? []) walk(child);
        };
        for (const node of guideScene(id, 0, locale, kind)?.objects ?? [])
          walk(node);
      }
  return found;
}

test("a scene adds no sentence: names of things only, no '=' and no words of sameness, three kinds of Environment", () => {
  const words = sceneWords();
  expect(words.length).toBeGreaterThan(0);
  const found = words.flatMap(({ id, text }) => [
    ...guideWordFindings(text).map((rule) => `${id}: ${rule}`),
    ...(text.split(/\s+/).length > 3 ? [`${id}: a sentence: ${text}`] : []),
    ...(/[.!:;]\s*$|[.!:;]\s/.test(text) && !/\.pdf$/.test(text)
      ? [`${id}: punctuation of a sentence: ${text}`]
      : []),
  ]);
  expect(found).toEqual([]);
  // The rules catch an "=" and words of sameness in a scene's words.
  for (const wrong of ["=", "váš počítač = jejich", "totéž", "the same"])
    expect(guideWordFindings(wrong).length).toBeGreaterThan(0);
});

test("the agents' computer is named by the kind it plays in; on your computer it is yours", () => {
  const label = (kind: ShellEnvironmentKind | null, locale: "cs" | "en") => {
    const texts: string[] = [];
    const walk = (node: SceneNode) => {
      if (
        node.part === "name" &&
        node.text !== undefined &&
        node.text !== "Lazurio"
      )
        texts.push(node.text);
      for (const child of node.children ?? []) walk(child);
    };
    for (const node of guideScene("environment", 0, locale, kind)?.objects ??
      [])
      walk(node);
    return texts;
  };
  expect(label("work", "cs")).toEqual(["Pracovní Prostředí"]);
  expect(label("automated", "cs")).toEqual(["Pracovní Prostředí"]);
  expect(label("team", "cs")).toEqual(["Týmové Prostředí"]);
  expect(label("personal", "en")).toEqual(["Personal Environment"]);
  expect(label("workstation", "cs")).toEqual(["váš počítač"]);
  expect(label("workstation", "en")).toEqual(["your computer"]);
  expect(label(null, "en")).toEqual(["Environment"]);
  // A scene is drawn again only when its words change.
  expect(guideScene("environment", 1, "cs", "work")?.key).toBe(
    guideScene("environment", 3, "cs", "automated")?.key,
  );
  expect(guideScene("environment", 1, "cs", "work")?.key).not.toBe(
    guideScene("environment", 1, "cs", "team")?.key,
  );
});

/** The objects of a scene by the first of their parts' names. */
const objectsOf = (
  id: string,
  kind: ShellEnvironmentKind | null = "work",
  locale: "cs" | "en" = "cs",
) =>
  (guideScene(id, 0, locale, kind)?.objects ?? []).flatMap(function flat(
    node: SceneNode,
  ): SceneNode[] {
    return [
      ...(node.beats === undefined ? [] : [node]),
      ...(node.children ?? []).flatMap(flat),
    ];
  });

test("two devices, never one: the agents' computer and your laptop stand apart, Lazurio a window into theirs, one straight arrow from it to them", () => {
  const objects = objectsOf("environment");
  const last = 3;
  const holds = (node: SceneNode, part: string) =>
    node.children?.some((child) => child.part === part) ?? false;
  const theirs = objects.find((node) => holds(node, "pc"));
  const yours = objects.find((node) => holds(node, "pc laptop"));
  if (theirs?.beats === undefined || yours?.beats === undefined)
    throw new Error("Both devices are drawn");
  expect(theirs.beats.show[last]).toBe(true);
  expect(yours.beats.show[last]).toBe(true);
  // Apart: their computer (226 units wide, drawn at its scale) ends before
  // your laptop begins.
  const [theirX] = theirs.beats.at[last] ?? [0, 0];
  const [yourX] = yours.beats.at[last] ?? [0, 0];
  const theirRight = theirX + 226 * (theirs.beats.scale[last] ?? 1);
  expect(theirRight).toBeLessThan(yourX);
  // Lazurio in your laptop's bar, a window into theirs: their screen small
  // in it, with an eye.
  const flat = (node: SceneNode): SceneNode[] => [
    node,
    ...(node.children ?? []).flatMap(flat),
  ];
  const laptop = flat(yours);
  expect(laptop.some((node) => node.logo === true)).toBe(true);
  expect(laptop.some((node) => node.part === "peek")).toBe(true);
  expect(
    laptop.some((node) => node.part === "peye" && node.icon === "eye"),
  ).toBe(true);
  // One arrow, straight, from your window to their computer.
  const arrows = objects.filter((node) => node.line !== undefined);
  expect(arrows.map((node) => node.part)).toEqual(["line arrow"]);
  const [arrow] = arrows;
  if (arrow?.beats === undefined || arrow.line === undefined)
    throw new Error("The arrow is drawn");
  const [startX] = arrow.beats.at[last] ?? [0, 0];
  const [length, angle] = arrow.line;
  expect(angle).toBe(180);
  expect(startX).toBeGreaterThanOrEqual(yourX);
  expect(startX - length).toBeGreaterThanOrEqual(theirRight);
  expect(arrow.beats.show.slice(0, last)).toEqual([false, false, false]);
});

test("on your computer one device: yours, with Lazurio and the agents' work on the same screen, no second device and no arrow", () => {
  const flat = (node: SceneNode): SceneNode[] => [
    node,
    ...(node.children ?? []).flatMap(flat),
  ];
  for (const locale of locales) {
    const objects = objectsOf("environment", "workstation", locale);
    // One object on stage in every beat: the computer itself.
    expect(objects.length).toBe(1);
    const [device] = objects;
    if (device?.beats === undefined) throw new Error("The device is drawn");
    expect(device.beats.show).toEqual([true, true, true, true]);
    expect(device.beats.scale).toEqual([1, 1, 1, 1]);
    // Its apps, the agents at work, then Lazurio on the same screen.
    expect(device.beats.state).toEqual([
      "",
      "apps",
      "apps work",
      "apps work watch",
    ]);
    const parts = flat(device);
    expect(parts.filter((node) => node.part.startsWith("pc"))).toHaveLength(1);
    expect(parts.some((node) => node.part === "pc laptop")).toBe(false);
    expect(parts.some((node) => node.line !== undefined)).toBe(false);
    // Named "váš počítač" from the first step, never the agents' computer.
    const texts = parts.flatMap((node) =>
      node.text === undefined ? [] : [node.text],
    );
    expect(texts).toContain(locale === "cs" ? "váš počítač" : "your computer");
    for (const theirs of ["počítač agentů", "agents' computer", "Prostředí"])
      expect(texts).not.toContain(theirs);
    const bar = parts.find((node) => node.part === "bar");
    expect(bar?.icon).toBe("laptop");
    // Lazurio on that same computer, with its eye on what the agents do.
    const lazurio = parts.find((node) => node.part === "lzwin");
    if (lazurio === undefined) throw new Error("Lazurio is on the screen");
    expect(flat(lazurio).some((node) => node.logo === true)).toBe(true);
    expect(flat(lazurio).some((node) => node.icon === "eye")).toBe(true);
  }
  // Every other kind keeps its two devices and the arrow.
  for (const kind of [null, "work", "team", "personal", "automated"] as const)
    expect(
      objectsOf("environment", kind).filter((node) => node.line !== undefined),
    ).toHaveLength(1);
  // Lazurio's window on the screen is drawn only once the last beat says so.
  const rules = rulesOf(guideSceneCss).filter((rule) =>
    rule.selector.includes(".s-lzwin"),
  );
  expect(rules.find((rule) => rule.selector === ".s-lzwin")?.body).toContain(
    "opacity: 0",
  );
  expect(
    rules.find((rule) => rule.selector === '[data-state~="watch"] .s-lzwin')
      ?.body,
  ).toContain("opacity: 1");
});

test("where agents may go: one straight solid arrow, from the Osobní Prostředí to the Pracovní Prostředí, and nothing the other way", () => {
  const objects = objectsOf("reach");
  const boxes = objects.filter((node) => node.part.startsWith("box"));
  const mine = boxes.find((node) => node.part.includes("mine"));
  const work = boxes.find((node) => node.part.includes("org"));
  if (mine?.beats === undefined || work?.beats === undefined)
    throw new Error("Both Environments are drawn");
  const title = (node: SceneNode) =>
    node.children?.find((child) => child.part === "title")?.text;
  expect(title(mine)).toBe("Osobní Prostředí");
  expect(title(work)).toBe("Pracovní Prostředí");
  const lines = objects.filter((node) => node.line !== undefined);
  expect(lines.map((node) => node.part)).toEqual(["line arrow"]);
  const [arrow] = lines;
  if (arrow?.beats === undefined || arrow.line === undefined)
    throw new Error("The arrow is drawn");
  const [length, angle] = arrow.line;
  // Straight and pointing right: from the Osobní Prostředí (left) to the
  // Pracovní Prostředí (right), between them.
  expect(angle).toBe(0);
  const [mineX] = mine.beats.at[0] ?? [0, 0];
  const [workX] = work.beats.at[0] ?? [0, 0];
  const [startX] = arrow.beats.at[1] ?? [0, 0];
  expect(startX).toBeGreaterThanOrEqual(mineX + (mine.size?.[0] ?? 0));
  expect(startX + length).toBeLessThanOrEqual(workX);
  expect(mineX).toBeLessThan(workX);
  // Drawn from the second step on, the whole way.
  expect(arrow.beats.show).toEqual([false, true, true, true]);
  // Nothing stands on it, so it never reads as broken: the agent that
  // travels along it rides above it, the one from work stays below it (a
  // dot of 22 units).
  const [, lineY] = arrow.beats.at[1] ?? [0, 0];
  for (const node of objects.filter((each) => each.part === "agent-at"))
    node.beats?.at.forEach(([x, y], beat) => {
      if (node.beats?.show[beat] !== true) return;
      const across = x + 22 > startX && x < startX + length;
      expect({
        beat,
        clear: !across || y + 22 < lineY - 1 || y > lineY + 4,
      }).toEqual({
        beat,
        clear: true,
      });
    });
  // Solid: a line is a filled bar, and nothing about it is dashed; the only
  // dashed things of every scene are the frame of the Lazurio window into
  // the agents' computer and an app not signed in.
  const dashed = [...guideSceneCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /dash/.test(body ?? ""))
    .map(([, selector]) => (selector ?? "").trim());
  expect(dashed).toEqual([".s-peek", '.s-tile[data-state~="off"]']);
  expect(guideSceneCss).not.toContain("stroke-dasharray");
});

/** The declarations of a stylesheet, each with the at-rule it stands in. */
function rulesOf(
  css: string,
): { media: string | null; selector: string; body: string }[] {
  const rules: { media: string | null; selector: string; body: string }[] = [];
  let at = 0;
  const media: (string | null)[] = [null];
  let depth = 0;
  let selector = "";
  let start = 0;
  for (; at < css.length; at += 1) {
    const character = css[at];
    if (character === "{") {
      const head = css.slice(start, at).trim();
      if (head.startsWith("@media")) media.push(head);
      else if (head.startsWith("@keyframes")) media.push("@keyframes");
      else selector = head;
      depth += 1;
      start = at + 1;
    } else if (character === "}") {
      const body = css.slice(start, at).trim();
      if (selector !== "") {
        rules.push({ media: media.at(-1) ?? null, selector, body });
        selector = "";
      } else media.pop();
      depth -= 1;
      start = at + 1;
    }
  }
  expect(depth).toBe(0);
  return rules.filter((rule) => rule.media !== "@keyframes");
}

test("with less motion each beat is its finished frame: the scenes move only where motion is not reduced", () => {
  expect(guideLayerCss).toContain(guideSceneCss);
  const rules = rulesOf(guideSceneCss);
  const motion = "@media (prefers-reduced-motion: no-preference)";
  const moves = (body: string) =>
    /(?:^|;)\s*(?:animation|transition)[\w-]*\s*:\s*(?!none\b)/.test(body);
  // Outside the motion block nothing animates or transitions: the plain
  // rules are the beats' still frames.
  expect(
    rules
      .filter((rule) => rule.media !== motion && moves(rule.body))
      .map((rule) => rule.selector),
  ).toEqual([]);
  // Inside it, only where the layer is not still (`data-still`, set when
  // the person's system asked for less motion as the guide appeared).
  const moving = rules.filter((rule) => rule.media === motion);
  expect(moving.length).toBeGreaterThan(0);
  for (const rule of moving)
    for (const selector of rule.selector.split(","))
      expect(selector.trim()).toStartWith(".layer:not([data-still]) ");
  // Every animation loops or ends where the still frame stands: none holds
  // a last frame of its own.
  const animations = moving.flatMap((rule) =>
    [...rule.body.matchAll(/animation\s*:\s*([^;]+)/g)].flatMap(([, value]) =>
      (value ?? "").split(","),
    ),
  );
  expect(animations.length).toBeGreaterThan(0);
  for (const animation of animations) {
    expect(animation).not.toMatch(/\b(?:forwards|both)\b/);
    expect(animation).toMatch(/\b(?:infinite|backwards)\b/);
  }
  // Every animation it names is defined.
  const named = new Set(
    animations.map((animation) => animation.trim().split(/\s+/)[0]),
  );
  const defined = new Set(
    [...guideSceneCss.matchAll(/@keyframes\s+([\w-]+)/g)].map(
      ([, name]) => name,
    ),
  );
  for (const name of named)
    expect({ name, defined: defined.has(name) }).toEqual({
      name,
      defined: true,
    });
});

test("the scene modules listen to nothing and touch no page at load", async () => {
  for (const file of [
    "src/shell/guide-scenes.ts",
    "src/shell/guide-stage.ts",
    "src/shell/guide-scene-styles.ts",
  ]) {
    const source = await readFile(file, "utf8");
    expect({
      file,
      listens: /addEventListener|postMessage|document\./.test(source),
    }).toEqual({
      file,
      listens: false,
    });
  }
});
