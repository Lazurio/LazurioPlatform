// A small stand-in for the page's DOM, enough for what the Launchpad's
// dialogs draw ("Připojit Telegram", "Seznamte se s Buddym"): what a dialog
// sets, appends and listens to, and a dialog's `open`, `showModal` and
// `close`. Lines found by class are not looked for here; a test walks the
// nodes instead.

export type Listener = (event: {
  type: string;
  preventDefault(): void;
}) => void;

/** One element of the stand-in: what the dialog sets, appends and listens
 * to, and a dialog's `open`, `showModal` and `close`. */
export class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener[]>();
  readonly dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  value = "";
  disabled = false;
  open = false;
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const node of nodes) this.children.push(FakeNode.of(node));
  }
  prepend(...nodes: (FakeNode | string)[]) {
    this.children.unshift(...nodes.map(FakeNode.of));
  }
  replaceChildren(...nodes: (FakeNode | string)[]) {
    this.children.length = 0;
    this.append(...nodes);
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ type, preventDefault() {} });
  }
  click() {
    this.dispatch("click");
  }
  focus() {}
  /** Lines found by class are not looked for here. */
  querySelector() {
    return null;
  }
  showModal() {
    this.open = true;
  }
  /** The browser's own close: Escape, or the page's `close()`. */
  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  /** This node and every one under it. */
  *walk(): Generator<FakeNode> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }
  static of(node: FakeNode | string): FakeNode {
    if (typeof node !== "string") return node;
    const text = new FakeNode("#text");
    text.textContent = node;
    return text;
  }
}
