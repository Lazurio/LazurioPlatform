import { randomBytes } from "node:crypto";
import {
  modifierBits,
  type PickerItem,
  type PickerKind,
  type PickerRect,
  pickerKinds,
  type ServerMessage,
} from "./protocol";

/** The view's own pickers for the pop-ups Chrome draws outside the page
 * (F39's addendum of 2026-11-14, #970). A `<select>`'s list, the calendar of
 * `date`, `time`, `datetime-local`, `month` and `week`, the colour chooser
 * and a datalist's suggestions are separate widgets (`PagePopup`) that no
 * screencast shows: the person would open them and see nothing.
 *
 * So when a person's press, tap or key would open one, the hub finds the
 * control first (in the page, in a frame of the page, or in a frame of
 * another process), and a script in the view's isolated world keeps that
 * one event from opening Chrome's pop-up: it cancels the default of the
 * person's `mousedown` and `click`, or of their key, on that control only,
 * and lets every handler of the page run. The person's input still reaches
 * the page as before. The view shows its own list or field at the control,
 * and what the person chooses is written the way a person's choice is:
 * `selectedIndex` or `value`, then `input` and `change`.
 *
 * Only the input that comes through the view is looked at. An agent works
 * in the browser through its own DevTools session (agent-browser,
 * `Input.dispatch*`, a `select` command): that never reaches the hub, so its
 * clicks and keys open what they always opened. The script adds nothing to
 * the page's document and never reads a password field. */

/** The world the pickers' scripts run in, one per frame. */
const pickerWorld = "lazurio-view-pickers";
/** Objects the hub asks for while it looks; released after each look. */
const objectGroup = "lazurio-view-pickers";
/** How deep the hub follows frames inside frames. */
const maxFrameDepth = 4;
/** Choices sent to the view at most, and their text's length. */
export const pickerLimits = Object.freeze({
  items: 3_000,
  text: 300,
  value: 10_000,
  name: 120,
});

/** The kinds of control a key opens, by the key and its modifiers: as Chrome
 * on Linux opens them (measured on Chrome 156). Space and Enter open a
 * select's list and the colour chooser; F4 and Alt with an arrow open a
 * select and a calendar; an arrow alone opens a datalist's suggestions (on
 * a select it changes the choice in place, which the screencast shows). */
export function pickerKeyKinds(
  key: string,
  modifiers: number,
): readonly PickerKind[] {
  const alt = (modifiers & modifierBits.alt) !== 0;
  const ctrlOrMeta =
    (modifiers & (modifierBits.ctrl | modifierBits.meta)) !== 0;
  if (ctrlOrMeta) return [];
  const calendars: readonly PickerKind[] = [
    "date",
    "time",
    "datetime-local",
    "month",
    "week",
  ];
  if (key === "ArrowDown" || key === "ArrowUp")
    return alt ? ["select", ...calendars, "datalist"] : ["datalist"];
  if (alt) return [];
  if (key === "F4") return ["select", ...calendars];
  if (key === " " || key === "Enter") return ["select", "color"];
  return [];
}

// The page side, run on one element in the view's isolated world. Returns
// `{ frame: true }` for a frame (the hub looks inside it), null for no
// control of a kind the trigger opens, else the control's description, and
// then it has armed the guard: the next `mousedown` and `click` (a pointer)
// or the next `keydown` of that key (a key) on that control has its default
// cancelled, once, and only within a short time. A pressed select is
// focused as the press would have focused it; a datalist's field is not,
// because Chrome then shows its suggestions anyway. A password field is
// never a kind and its value never read.
const findScript = `function (trigger) {
  let el = this;
  if (el && el.nodeType !== 1) el = el.parentElement;
  if (!el) return null;
  if (trigger.key) while (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (el.tagName === "OPTION" || el.tagName === "OPTGROUP") el = el.closest("select") || el;
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") return { frame: true };
  const cut = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
  let kind = null;
  if (el.tagName === "SELECT") {
    if (el.multiple || el.size > 1 || el.disabled) return null;
    try { if (getComputedStyle(el).appearance === "base-select") return null; } catch (e) {}
    kind = "select";
  } else if (el.tagName === "INPUT") {
    const type = el.type;
    if (el.disabled || el.readOnly || type === "password") return null;
    if (["date", "time", "datetime-local", "month", "week", "color"].includes(type)) kind = type;
    else if (["text", "search", "url", "tel", "email", "number"].includes(type) && el.list && el.list.options.length > 0) kind = "datalist";
    else return null;
  } else return null;
  if (trigger.kinds && !trigger.kinds.includes(kind)) return null;
  const guards = (globalThis.__lazurioPickerGuards = globalThis.__lazurioPickerGuards || new Set());
  const types = trigger.key ? ["keydown"] : ["mousedown", "click"];
  const until = Date.now() + trigger.ms;
  const handlers = [];
  const guard = { off() { for (const [type, handler] of handlers) removeEventListener(type, handler, true); guards.delete(guard); } };
  for (const type of types) {
    const handler = (event) => {
      if (Date.now() > until) return guard.off();
      if (!event.composedPath().includes(el)) return;
      if (trigger.key && event.key !== trigger.key) return;
      event.preventDefault();
      if (type === "mousedown" && kind !== "datalist") el.focus({ preventScroll: true });
      if (type === "click" || type === "keydown") guard.off();
    };
    handlers.push([type, handler]);
    addEventListener(type, handler, true);
  }
  guards.add(guard);
  setTimeout(() => guard.off(), trigger.ms + 50);
  const name = cut(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || "", ${pickerLimits.name});
  const out = { kind, name };
  if (kind === "select") {
    const groups = [];
    const items = [];
    for (let i = 0; i < el.options.length && items.length < ${pickerLimits.items}; i++) {
      const o = el.options[i];
      if (o.hidden) continue;
      const parent = o.parentElement;
      let group = -1;
      if (parent && parent.tagName === "OPTGROUP") {
        group = groups.indexOf(parent);
        if (group < 0) { groups.push(parent); group = groups.length - 1; }
      }
      items.push({ i, text: cut(o.label || o.text, ${pickerLimits.text}), value: String(o.value).slice(0, ${pickerLimits.value}), disabled: o.disabled || (group >= 0 && parent.disabled), group });
    }
    out.items = items;
    out.groups = groups.map((g) => ({ label: cut(g.label, ${pickerLimits.text}), disabled: g.disabled }));
    out.selected = el.selectedIndex;
  } else if (kind === "datalist") {
    const items = [];
    const options = el.list.options;
    for (let i = 0; i < options.length && items.length < ${pickerLimits.items}; i++) {
      const o = options[i];
      if (o.disabled || o.value === "") continue;
      const label = cut(o.label, ${pickerLimits.text});
      items.push({ i, text: cut(o.value, ${pickerLimits.text}), value: String(o.value).slice(0, ${pickerLimits.value}), label: label === cut(o.value, ${pickerLimits.text}) ? "" : label });
    }
    out.items = items;
    out.value = String(el.value).slice(0, ${pickerLimits.value});
  } else {
    out.value = String(el.value).slice(0, 100);
    out.min = String(el.min).slice(0, 100);
    out.max = String(el.max).slice(0, 100);
    out.step = String(el.step).slice(0, 100);
  }
  return out;
}`;

// Writes the person's choice as a person's choice is written: the option or
// the value, then `input` and `change`, both bubbling; nothing when nothing
// changes, as Chrome. A select's option is found again by its value and text
// when the page changed its options meanwhile. "ok", or why not.
const applyScript = `function (pick) {
  const el = this;
  const cut = (s, n) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().slice(0, n);
  const fire = () => {
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  if (!el.isConnected) return "gone";
  if (pick.kind === "select") {
    if (el.tagName !== "SELECT" || el.disabled) return "gone";
    const same = (o) => o && String(o.value).slice(0, ${pickerLimits.value}) === pick.value && cut(o.label || o.text, ${pickerLimits.text}) === pick.text;
    let index = same(el.options[pick.index]) ? pick.index : -1;
    if (index < 0) for (let i = 0; i < el.options.length; i++) if (same(el.options[i])) { index = i; break; }
    if (index < 0) return "gone";
    const o = el.options[index];
    if (o.disabled || (o.parentElement && o.parentElement.tagName === "OPTGROUP" && o.parentElement.disabled)) return "disabled";
    el.focus({ preventScroll: true });
    if (el.selectedIndex === index) return "ok";
    el.selectedIndex = index;
    fire();
    return "ok";
  }
  if (el.tagName !== "INPUT" || el.disabled || el.readOnly || el.type === "password") return "gone";
  if (pick.kind === "datalist" ? !el.list : el.type !== pick.kind) return "gone";
  el.focus({ preventScroll: true });
  if (el.value === pick.value) return "ok";
  el.value = pick.value;
  if (el.value !== pick.value && pick.kind !== "color") return "invalid";
  fire();
  return "ok";
}`;

// Ends every guard of this world: the input it waited for has passed.
const disarmScript = `(() => { const g = globalThis.__lazurioPickerGuards; if (g) for (const x of [...g]) x.off(); return true; })()`;
// A datalist's field the person left the suggestions of: it gets the focus
// the press would have given it, so they can type.
const focusScript = `function () { if (this.isConnected) this.focus({ preventScroll: true }); return true; }`;

/** What the hub knows of a tab for the pickers. */
export type PickerTab = Readonly<{
  targetId: string;
  sessionId: string | null;
  mainFrameId: string | null;
}>;

type Send = (
  method: string,
  params: Record<string, unknown>,
  session?: string,
) => Promise<Record<string, unknown>>;

/** A control the person's input would open, found and guarded. */
export type FoundPicker = Readonly<{
  targetId: string;
  session: string;
  frameId: string;
  backendNodeId: number;
  message: Omit<Extract<ServerMessage, { t: "picker" }>, "token">;
}>;

type OpenPicker = {
  targetId: string;
  viewer: unknown;
  found: FoundPicker;
  items: ReadonlyMap<number, PickerItem>;
};

/** The page's description of a control, checked: only the shapes the view
 * draws, with the limits above. Null for anything else. */
export function readPicker(
  value: unknown,
): Omit<Extract<ServerMessage, { t: "picker" }>, "token" | "rect"> | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind as PickerKind;
  if (!pickerKinds.includes(kind)) return null;
  const str = (x: unknown, max: number) =>
    typeof x === "string" ? x.slice(0, max) : "";
  const out: {
    -readonly [K in keyof Omit<
      Extract<ServerMessage, { t: "picker" }>,
      "token" | "rect"
    >]: Extract<ServerMessage, { t: "picker" }>[K];
  } = { t: "picker", kind, name: str(v.name, pickerLimits.name) };
  if (kind === "select" || kind === "datalist") {
    if (!Array.isArray(v.items)) return null;
    const groups = Array.isArray(v.groups)
      ? v.groups.slice(0, pickerLimits.items).map((g: unknown) => ({
          label: str((g as { label?: unknown })?.label, pickerLimits.text),
          disabled: (g as { disabled?: unknown })?.disabled === true,
        }))
      : [];
    const items: PickerItem[] = [];
    for (const raw of v.items.slice(0, pickerLimits.items)) {
      const item = raw as Record<string, unknown>;
      if (
        typeof item !== "object" ||
        item === null ||
        !Number.isSafeInteger(item.i) ||
        (item.i as number) < 0
      )
        return null;
      const group =
        kind === "select" &&
        Number.isSafeInteger(item.group) &&
        (item.group as number) >= 0 &&
        (item.group as number) < groups.length
          ? (item.group as number)
          : -1;
      items.push({
        i: item.i as number,
        text: str(item.text, pickerLimits.text),
        value: str(item.value, pickerLimits.value),
        ...(kind === "datalist"
          ? { label: str(item.label, pickerLimits.text) }
          : { disabled: item.disabled === true, group }),
      });
    }
    out.items = items;
    if (kind === "select") {
      out.groups = groups;
      out.selected = Number.isSafeInteger(v.selected)
        ? (v.selected as number)
        : -1;
    } else out.value = str(v.value, pickerLimits.value);
    return out;
  }
  out.value = str(v.value, 100);
  out.min = str(v.min, 100);
  out.max = str(v.max, 100);
  out.step = str(v.step, 100);
  return out;
}

/** A quad of `DOM.getBoxModel` as a rectangle. */
function quadRect(quad: unknown, dx: number, dy: number): PickerRect | null {
  if (!Array.isArray(quad) || quad.length !== 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
  const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: x + dx,
    y: y + dy,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

type Trigger = Readonly<{
  kinds: readonly PickerKind[] | null;
  key?: string;
  ms: number;
}>;

/** The pickers of one hub: the worlds it made, the frames of other
 * processes it attached to, the guards it armed and the pickers the people
 * have open. */
export class Pickers {
  private readonly worlds = new Map<string, number>();
  /** Out-of-process frames by the page's target: frame id → session. */
  private readonly frames = new Map<string, Map<string, string>>();
  /** Worlds with a guard armed, by the page's target. */
  private readonly armed = new Map<string, Set<string>>();
  private readonly open = new Map<string, OpenPicker>();

  constructor(
    private readonly seams: Readonly<{
      send: () => Send | null;
      log: (line: string) => void;
    }>,
  ) {}

  /** The browser connection is new: nothing of the old one holds. */
  reset(): void {
    this.worlds.clear();
    this.frames.clear();
    this.armed.clear();
    this.open.clear();
  }

  /** The control under a person's press or tap, guarded; null for none. A
   * tap's mouse events come after the finger lifts, so its guard waits
   * longer. */
  async atPoint(
    tab: PickerTab,
    x: number,
    y: number,
    touch: boolean,
  ): Promise<FoundPicker | null> {
    const send = this.seams.send();
    if (send === null || tab.sessionId === null || tab.mainFrameId === null)
      return null;
    const trigger: Trigger = { kinds: null, ms: touch ? 3_000 : 1_500 };
    let session = tab.sessionId;
    let root = tab.mainFrameId;
    let px = x;
    let py = y;
    let dx = 0;
    let dy = 0;
    try {
      for (let depth = 0; depth < maxFrameDepth; depth++) {
        const hit = await send(
          "DOM.getNodeForLocation",
          { x: Math.round(px), y: Math.round(py) },
          session,
        ).catch(() => null);
        if (
          hit !== null &&
          typeof hit.backendNodeId === "number" &&
          typeof hit.frameId === "string"
        ) {
          const found = await this.describe(
            send,
            tab,
            session,
            hit.frameId,
            { backendNodeId: hit.backendNodeId },
            trigger,
            dx,
            dy,
          );
          if (found === null || !("frame" in found)) return found;
          // The element of a frame whose page is in another process: looked
          // in there.
          const child = await this.childFrame(send, tab, session, found.frame);
          if (child === null || !child.oopif) return null;
          session = child.session;
          root = child.frameId;
          px -= child.left;
          py -= child.top;
          dx += child.left;
          dy += child.top;
          continue;
        }
        // Nothing in this process at the point: a frame of another process
        // covers it. Found from the frame's root down, then looked in.
        const next = await this.frameAt(send, tab, session, root, px, py);
        if (next === null) return null;
        session = next.session;
        root = next.frameId;
        px -= next.left;
        py -= next.top;
        dx += next.left;
        dy += next.top;
      }
      return null;
    } finally {
      this.release(send, tab);
    }
  }

  /** The focused control when a person presses a key that opens one of
   * `kinds`, guarded against that key; null for none. */
  async focused(
    tab: PickerTab,
    key: string,
    kinds: readonly PickerKind[],
  ): Promise<FoundPicker | null> {
    const send = this.seams.send();
    if (
      send === null ||
      tab.sessionId === null ||
      tab.mainFrameId === null ||
      kinds.length === 0
    )
      return null;
    const trigger: Trigger = { kinds, key, ms: 1_500 };
    let session = tab.sessionId;
    let frame = tab.mainFrameId;
    let dx = 0;
    let dy = 0;
    try {
      for (let depth = 0; depth < maxFrameDepth * 2; depth++) {
        const world = await this.world(send, session, frame, tab.targetId);
        if (world === null) return null;
        const active = await send(
          "Runtime.evaluate",
          {
            expression: "document.activeElement",
            contextId: world,
            objectGroup,
          },
          session,
        );
        const objectId = (active.result as { objectId?: unknown } | undefined)
          ?.objectId;
        if (typeof objectId !== "string") return null;
        const found = await this.describe(
          send,
          tab,
          session,
          frame,
          { objectId },
          trigger,
          dx,
          dy,
        );
        if (found === null || !("frame" in found)) return found;
        const child = await this.childFrame(send, tab, session, found.frame);
        if (child === null) return null;
        session = child.session;
        frame = child.frameId;
        if (child.oopif) {
          dx += child.left;
          dy += child.top;
        }
      }
      return null;
    } finally {
      this.release(send, tab);
    }
  }

  /** Ends the guards armed in a tab: the input they waited for has passed
   * (or never came, a touch that became a scroll). */
  disarm(tab: PickerTab): void {
    const send = this.seams.send();
    const armed = this.armed.get(tab.targetId);
    if (send === null || armed === undefined) return;
    this.armed.delete(tab.targetId);
    for (const key of armed) {
      const world = this.worlds.get(key);
      const session = key.slice(0, key.indexOf(" "));
      if (world === undefined) continue;
      void send(
        "Runtime.evaluate",
        { expression: disarmScript, contextId: world, returnByValue: true },
        session,
      ).catch(() => undefined);
    }
  }

  /** A found control becomes a person's open picker: its message, with the
   * token their answer names. One open picker per person. */
  show(
    targetId: string,
    viewer: unknown,
    found: FoundPicker,
  ): Extract<ServerMessage, { t: "picker" }> {
    for (const [token, open] of this.open)
      if (open.viewer === viewer) this.open.delete(token);
    const token = randomBytes(12).toString("hex");
    this.open.set(token, {
      targetId,
      viewer,
      found,
      items: new Map((found.message.items ?? []).map((item) => [item.i, item])),
    });
    return { ...found.message, token };
  }

  /** Writes the person's choice into the control. False when the picker is
   * not theirs or no longer there. */
  async pick(
    targetId: string,
    viewer: unknown,
    message: Readonly<{
      token: string;
      index?: number;
      value?: string;
      text?: string;
    }>,
  ): Promise<boolean> {
    const open = this.take(targetId, viewer, message.token);
    const send = this.seams.send();
    if (open === null || send === null) return false;
    const { kind } = open.found.message;
    let pick: Record<string, unknown>;
    if (kind === "select") {
      const item =
        message.index === undefined ? undefined : open.items.get(message.index);
      if (item === undefined || item.disabled === true) return false;
      pick = { kind, index: item.i, value: item.value, text: item.text };
    } else {
      if (message.value === undefined) return false;
      pick = { kind, value: message.value };
    }
    const result = await this.onControl(send, open.found, applyScript, pick);
    if (result !== "ok")
      this.seams.log(
        `picker on ${targetId}: ${typeof result === "string" ? result : "unreachable"}`,
      );
    return result === "ok";
  }

  /** The person closed the picker without choosing. A datalist's field
   * gets the focus the press would have given it. */
  async cancel(
    targetId: string,
    viewer: unknown,
    token: string,
  ): Promise<void> {
    const open = this.take(targetId, viewer, token);
    const send = this.seams.send();
    if (open === null || send === null) return;
    if (open.found.message.kind === "datalist")
      await this.onControl(send, open.found, focusScript, null);
  }

  /** A tab's document changed or the tab ended: its pickers close. Returns
   * the people and tokens to tell. */
  closeTab(
    targetId: string,
    ended: boolean,
  ): { viewer: unknown; token: string }[] {
    const closed: { viewer: unknown; token: string }[] = [];
    for (const [token, open] of this.open)
      if (open.targetId === targetId) {
        this.open.delete(token);
        closed.push({ viewer: open.viewer, token });
      }
    for (const key of [...this.worlds.keys()])
      if (this.belongs(targetId, key)) this.worlds.delete(key);
    this.armed.delete(targetId);
    if (ended) this.frames.delete(targetId);
    return closed;
  }

  /** A person left: their pickers go. */
  forgetViewer(viewer: unknown): void {
    for (const [token, open] of this.open)
      if (open.viewer === viewer) this.open.delete(token);
  }

  // ---- Looking ------------------------------------------------------------

  private belongs(targetId: string, worldKey: string): boolean {
    return worldKey.split(" ")[2] === targetId;
  }

  private take(
    targetId: string,
    viewer: unknown,
    token: string,
  ): OpenPicker | null {
    const open = this.open.get(token);
    if (open === undefined || open.targetId !== targetId) return null;
    if (open.viewer !== viewer) return null;
    this.open.delete(token);
    return open;
  }

  /** The view's world in a frame, made once per document. */
  private async world(
    send: Send,
    session: string,
    frameId: string,
    targetId: string,
  ): Promise<number | null> {
    const key = `${session} ${frameId} ${targetId}`;
    const known = this.worlds.get(key);
    if (known !== undefined) return known;
    try {
      const world = await send(
        "Page.createIsolatedWorld",
        { frameId, worldName: pickerWorld },
        session,
      );
      const id = Number(world.executionContextId);
      if (!Number.isSafeInteger(id)) return null;
      this.worlds.set(key, id);
      return id;
    } catch {
      return null;
    }
  }

  /** Runs `findScript` on a node in its frame's world, and for a control
   * reads its place. For a frame element, its object to look into. */
  private async describe(
    send: Send,
    tab: PickerTab,
    session: string,
    frameId: string,
    node: Readonly<{ backendNodeId: number } | { objectId: string }>,
    trigger: Trigger,
    dx: number,
    dy: number,
  ): Promise<FoundPicker | { frame: string } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const world = await this.world(send, session, frameId, tab.targetId);
      if (world === null) return null;
      try {
        let objectId: string;
        if ("objectId" in node) objectId = node.objectId;
        else {
          const resolved = await send(
            "DOM.resolveNode",
            {
              backendNodeId: node.backendNodeId,
              executionContextId: world,
              objectGroup,
            },
            session,
          );
          objectId = String(
            (resolved.object as { objectId?: unknown } | undefined)?.objectId,
          );
        }
        const answer = await send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: findScript,
            arguments: [{ value: trigger }],
            returnByValue: true,
          },
          session,
        );
        const value = (answer.result as { value?: unknown } | undefined)?.value;
        if (
          typeof value === "object" &&
          value !== null &&
          (value as { frame?: unknown }).frame === true
        )
          return { frame: objectId };
        if (value === null || value === undefined) return null;
        const key = `${session} ${frameId} ${tab.targetId}`;
        const armed = this.armed.get(tab.targetId) ?? new Set<string>();
        armed.add(key);
        this.armed.set(tab.targetId, armed);
        const read = readPicker(value);
        const backendNodeId =
          "backendNodeId" in node
            ? node.backendNodeId
            : Number(
                (
                  (await send("DOM.describeNode", { objectId }, session))
                    .node as { backendNodeId?: unknown } | undefined
                )?.backendNodeId,
              );
        const box = await send("DOM.getBoxModel", { backendNodeId }, session);
        const rect = quadRect(
          (box.model as { border?: unknown } | undefined)?.border,
          dx,
          dy,
        );
        if (
          read === null ||
          rect === null ||
          !Number.isSafeInteger(backendNodeId)
        ) {
          this.disarm(tab);
          return null;
        }
        return {
          targetId: tab.targetId,
          session,
          frameId,
          backendNodeId,
          message: { ...read, rect },
        };
      } catch {
        // A world of a document that is gone: made again, once.
        this.worlds.delete(`${session} ${frameId} ${tab.targetId}`);
        if ("objectId" in node) return null;
      }
    }
    return null;
  }

  /** The frame under a point in a frame of this process whose content is in
   * another process: walked down from `root` through the frames of this
   * process. Its session (attached on first use), its id and the place of
   * its content in this process's viewport. */
  private async frameAt(
    send: Send,
    tab: PickerTab,
    session: string,
    root: string,
    x: number,
    y: number,
  ): Promise<{
    session: string;
    frameId: string;
    left: number;
    top: number;
  } | null> {
    let frame = root;
    for (let depth = 0; depth < maxFrameDepth; depth++) {
      const world = await this.world(send, session, frame, tab.targetId);
      if (world === null) return null;
      let left = 0;
      let top = 0;
      // Points in a frame of this process are in its own viewport; the
      // boxes `DOM.getBoxModel` gives are in the process's root viewport.
      if (frame !== root) {
        const owner = await send(
          "DOM.getFrameOwner",
          { frameId: frame },
          session,
        );
        const box = await send(
          "DOM.getBoxModel",
          { backendNodeId: owner.backendNodeId },
          session,
        );
        const rect = quadRect(
          (box.model as { content?: unknown } | undefined)?.content,
          0,
          0,
        );
        if (rect === null) return null;
        left = rect.x;
        top = rect.y;
      }
      const at = await send(
        "Runtime.evaluate",
        {
          expression: `document.elementFromPoint(${Number(x - left)}, ${Number(y - top)})`,
          contextId: world,
          objectGroup,
        },
        session,
      );
      const objectId = (at.result as { objectId?: unknown } | undefined)
        ?.objectId;
      if (typeof objectId !== "string") return null;
      const child = await this.childFrame(send, tab, session, objectId);
      if (child === null) return null;
      if (child.oopif)
        return {
          session: child.session,
          frameId: child.frameId,
          left: child.left,
          top: child.top,
        };
      frame = child.frameId;
    }
    return null;
  }

  /** The frame a frame element shows: in this process, or another's, then
   * attached to and with its content's place in this process's root
   * viewport. Null for an element that is no frame. */
  private async childFrame(
    send: Send,
    tab: PickerTab,
    session: string,
    objectId: string,
  ): Promise<{
    session: string;
    frameId: string;
    oopif: boolean;
    left: number;
    top: number;
  } | null> {
    const described = await send("DOM.describeNode", { objectId }, session);
    const frameId = (described.node as { frameId?: unknown } | undefined)
      ?.frameId;
    if (typeof frameId !== "string") return null;
    if ((await this.world(send, session, frameId, tab.targetId)) !== null)
      return { session, frameId, oopif: false, left: 0, top: 0 };
    const box = await send("DOM.getBoxModel", { objectId }, session);
    const rect = quadRect(
      (box.model as { content?: unknown } | undefined)?.content,
      0,
      0,
    );
    if (rect === null) return null;
    const frames = this.frames.get(tab.targetId) ?? new Map<string, string>();
    this.frames.set(tab.targetId, frames);
    let child = frames.get(frameId);
    if (child === undefined) {
      const attached = await send("Target.attachToTarget", {
        targetId: frameId,
        flatten: true,
      });
      child = String(attached.sessionId);
      frames.set(frameId, child);
    }
    return { session: child, frameId, oopif: true, left: rect.x, top: rect.y };
  }

  /** Runs a script on the control of an open picker; its answer, or null. */
  private async onControl(
    send: Send,
    found: FoundPicker,
    script: string,
    argument: unknown,
  ): Promise<unknown> {
    const key = `${found.session} ${found.frameId} ${found.targetId}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const world = await this.world(
        send,
        found.session,
        found.frameId,
        found.targetId,
      );
      if (world === null) return null;
      try {
        const resolved = await send(
          "DOM.resolveNode",
          { backendNodeId: found.backendNodeId, executionContextId: world },
          found.session,
        );
        const objectId = (resolved.object as { objectId?: unknown } | undefined)
          ?.objectId;
        if (typeof objectId !== "string") return null;
        const answer = await send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: script,
            arguments: argument === null ? [] : [{ value: argument }],
            returnByValue: true,
          },
          found.session,
        );
        void send("Runtime.releaseObject", { objectId }, found.session).catch(
          () => undefined,
        );
        return (answer.result as { value?: unknown } | undefined)?.value;
      } catch {
        this.worlds.delete(key);
      }
    }
    return null;
  }

  /** Lets the objects of one look go. */
  private release(send: Send, tab: PickerTab): void {
    const sessions = new Set<string>();
    if (tab.sessionId !== null) sessions.add(tab.sessionId);
    for (const session of this.frames.get(tab.targetId)?.values() ?? [])
      sessions.add(session);
    for (const session of sessions)
      void send("Runtime.releaseObjectGroup", { objectGroup }, session).catch(
        () => undefined,
      );
  }
}
