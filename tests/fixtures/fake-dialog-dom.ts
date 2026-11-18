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
  /** Inline custom properties, as his figure and the beats set them. */
  readonly style = {
    values: new Map<string, string>(),
    setProperty(name: string, value: string) {
      this.values.set(name, value);
    },
    removeProperty(name: string) {
      this.values.delete(name);
    },
  };
  textContent = "";
  className = "";
  value = "";
  disabled = false;
  open = false;
  /** Classes over `className`, as the beats toggle them. */
  readonly classList = {
    names: () => this.className.split(" ").filter((name) => name !== ""),
    add: (...names: string[]) => {
      this.className = [...new Set([...this.classList.names(), ...names])].join(
        " ",
      );
    },
    remove: (...names: string[]) => {
      this.className = this.classList
        .names()
        .filter((name) => !names.includes(name))
        .join(" ");
    },
    toggle: (name: string, force?: boolean) => {
      const on = force ?? !this.classList.contains(name);
      if (on) this.classList.add(name);
      else this.classList.remove(name);
      return on;
    },
    contains: (name: string) => this.classList.names().includes(name),
  };
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
  /** A descendant by one class (`.buddy-line`); any other selector finds
   * nothing here. */
  querySelector(selector = "") {
    if (!/^\.[a-z0-9-]+$/.test(selector)) return null;
    const name = selector.slice(1);
    for (const child of this.walk())
      if (child !== this && child.className.split(" ").includes(name))
        return child;
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
