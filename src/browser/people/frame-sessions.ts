/** The cross-origin frames of each remote tab (#973). Chrome runs a frame of
 * another site (an out-of-process iframe) as a target of its own, which its
 * page's DevTools session does not reach: a file chooser of such a frame
 * goes to the frame's own session, and without one Chrome opens its native
 * window on the Environment's screen, where nobody in the view sees it. So
 * the hub auto-attaches every page's session to its frames (`frameAutoAttach`,
 * flattened), and every frame's session to the frames under it, and asks
 * each for its file choosers. This is the hub's record of those sessions:
 * which tab each belongs to, under which session it came, and which frame it
 * is (a frame target's id is its frame's id). Pure state; the hub does the
 * DevTools calls.
 *
 * A frame's session is used for its file choosers and to reach its document
 * for a paste. Nothing else of the page's watch changes: the page's address,
 * its loading, its navigations and its input (decision F57) stay the main
 * frame's, read on the page's own session. Chrome reports a frame's
 * JavaScript dialogs, `beforeunload` too, on the page's session (measured on
 * Chrome 156), which answers them as before. */

/** `Target.setAutoAttach` for a page's or a frame's session: only frames,
 * never paused, on the same socket. */
export const frameAutoAttach = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: Object.freeze([Object.freeze({ type: "iframe" })]),
});

export type FrameSession = Readonly<{
  session: string;
  /** The frame's id, which is its target's id. */
  frameId: string;
  /** The tab's page target. */
  tab: string;
  /** The session it was attached under: the page's or another frame's. */
  parent: string;
}>;

export class FrameSessions {
  private readonly sessions = new Map<string, FrameSession>();

  /** A frame attached under `parent`. */
  add(tab: string, parent: string, session: string, frameId: string): void {
    this.sessions.set(session, { session, frameId, tab, parent });
  }

  get(session: string): FrameSession | undefined {
    return this.sessions.get(session);
  }

  /** The session of a tab's frame by the frame's id. */
  ofFrame(tab: string, frameId: string): FrameSession | undefined {
    for (const frame of this.sessions.values())
      if (frame.tab === tab && frame.frameId === frameId) return frame;
    return undefined;
  }

  /** A session that detached, and every frame attached under it, which went
   * with it: their sessions. */
  remove(session: string): string[] {
    if (!this.sessions.delete(session)) return [];
    const removed = [session];
    for (const frame of [...this.sessions.values()])
      if (frame.parent === session) removed.push(...this.remove(frame.session));
    return removed;
  }

  /** Every frame of a tab: the tab ended, or its page's session went. */
  removeTab(tab: string): void {
    for (const [session, frame] of this.sessions)
      if (frame.tab === tab) this.sessions.delete(session);
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
