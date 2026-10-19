import type { GuideScene, SceneBeats, SceneNode } from "./guide-scenes";
import type { ShellIcon } from "./icons";

// The stage of a principle's scene (decision F56's addendum (3) of
// 2026-10-19): guide-scenes.ts's data built as plain elements in the guide's
// card, inside `<lazurio-buddy>`'s shadow root, and a beat set on it. Every
// part is a span with its classes (`s-` and the part's names, so none meets
// the card's own); an object that moves stands where its beat says
// (`translate`, `scale`), is on stage or not (`data-in`), carries the words of
// its state (`data-state`) and how long it waits (`--d`). The stylesheet
// (guide-scene-styles.ts) draws the rest; it moves only where motion is not
// reduced, so a beat set is its still frame. The whole stage is decorative:
// `aria-hidden`, the card's step text says it.

/** An element as the stage builds it. */
export type StageElement = {
  className: string;
  readonly dataset: Record<string, string | undefined>;
  readonly style: { setProperty(property: string, value: string): void };
  setAttribute(name: string, value: string): void;
  toggleAttribute(name: string, force: boolean): boolean;
  append(...nodes: (StageElement | string | object)[]): void;
};

/** What the stage is built with: plain elements, an icon of the shell's
 * set, and the Lazurio symbol. */
export type StageMaker = Readonly<{
  element: () => StageElement;
  icon: (name: ShellIcon) => object;
  logo: () => object;
}>;

export type Stage = Readonly<{
  /** The scene's root, decorative, 320 × 180 units. */
  element: StageElement;
  /** The scene in its words (`GuideScene.key`). */
  key: string;
  /** Shows a beat: every object where it then stands. */
  beat: (beat: number) => void;
  /** Every object of a beat at its place but off stage, so that showing
   * the beat next brings them in. */
  enter: (beat: number) => void;
}>;

export function drawStage(scene: GuideScene, make: StageMaker): Stage {
  const objects: { element: StageElement; beats: SceneBeats; line: boolean }[] =
    [];
  const build = (node: SceneNode): StageElement => {
    const element = make.element();
    const classes = node.part.split(" ").map((part) => `s-${part}`);
    if (node.beats !== undefined) classes.push("s-o");
    element.className = classes.join(" ");
    if (node.icon !== undefined) element.append(make.icon(node.icon));
    if (node.logo === true) element.append(make.logo());
    if (node.text !== undefined) element.append(node.text);
    if (node.size !== undefined) {
      element.style.setProperty("width", `${node.size[0]}px`);
      element.style.setProperty("height", `${node.size[1]}px`);
    }
    if (node.line !== undefined) {
      element.style.setProperty("width", `${node.line[0]}px`);
      element.style.setProperty("rotate", `${node.line[1]}deg`);
    }
    for (const child of node.children ?? []) element.append(build(child));
    if (node.beats !== undefined)
      objects.push({
        element,
        beats: node.beats,
        line: node.line !== undefined,
      });
    return element;
  };
  const root = make.element();
  root.className = "s-scene";
  root.setAttribute("aria-hidden", "true");
  root.dataset.scene = scene.id;
  for (const node of scene.objects) root.append(build(node));
  const set = (beat: number, entering: boolean): void => {
    const at = Math.max(0, Math.min(beat, scene.beats - 1));
    root.dataset.beat = String(at);
    for (const { element, beats, line } of objects) {
      const [x, y] = beats.at[at] ?? [0, 0];
      const shown = !entering && beats.show[at] === true;
      // What is not on stage waits a little below its place, so it rises
      // in; a line is drawn from its start instead.
      element.style.setProperty(
        "translate",
        `${x}px ${y + (shown || line ? 0 : 10)}px`,
      );
      element.style.setProperty("scale", String(beats.scale[at] ?? 1));
      element.style.setProperty("--d", `${beats.delay[at] ?? 0}ms`);
      element.toggleAttribute("data-in", shown);
      // Entering, nothing has its state yet, so what a state sets going
      // starts as the object comes in.
      element.dataset.state = entering ? "" : (beats.state[at] ?? "");
    }
  };
  return Object.freeze({
    element: root,
    key: scene.key,
    beat: (beat: number) => set(beat, false),
    enter: (beat: number) => set(beat, true),
  });
}
