import type { Store } from "./account";
import {
  acceptBuddyFrameMessage,
  type BuddyContext,
  type BuddyContextFacts,
  type BuddyFrameWindow,
  type BuddyGuideStep,
  type BuddyLayout,
  buddyAvatarSource,
  buddyContext,
  buddyContextLimits,
  buddyFrameAttributes,
  buddyFrameSource,
  buddyMessage,
  createBuddyContextSender,
} from "./buddy-protocol";
import {
  currentEnvironment,
  environmentIdOf,
  type Shell,
  type ShellEnvironmentKind,
} from "./contract";
import type { GuideEvent } from "./guide";
import { createGuideReceiver } from "./guide-protocol";
import { keepTogether, shellMessages } from "./messages";
import { buddyMeetHref } from "./view";

// Buddy's bubble on a page of Lazurio, as the host's shell runs it (decision
// F60; root decision 0210 point 8, plan DEV-6676 P3): what `<lazurio-buddy>`
// draws and when, over seams, so its rules are tested without a DOM
// (buddy-element.ts draws it, elements.ts wires it to the page).
//
// - Only while the page's merged shell document names Buddy's origin
//   (`buddy.origin`, merge.ts): a launcher at the bottom right with his
//   picture. Without it nothing at all, and the guide stays as it was.
// - The first click on the launcher makes the frame (buddy-protocol.ts,
//   `buddyFrameAttributes`), never earlier: nothing of Buddy's conversation
//   loads on a page where the person never opens him. The frame stays while
//   the origin stays, so closing and opening again keeps the conversation as
//   it was; another origin is another frame.
// - The window shows as the panel above the launcher (about 400 × 600) or
//   full screen (a modal that covers the whole window), in the size
//   the person last chose in this tab (`buddyLayoutKey`, `sessionStorage`).
//   The launcher opens and closes it; Escape on the host's page returns from
//   full screen to the panel and closes the panel.
// - The frame draws its window's controls and asks the host for a size
//   (`lazurio.buddy.layout`): it resizes or closes a window the person
//   opened, and never opens one itself.
// - It hears the page's context after `ready` and after every change, never
//   the same twice: the guide's last step on this page, counted from 1, is
//   part of it until the page's path changes.
// - It may ask for an explanation of the guide (`lazurio.guide.play`, F56):
//   only while its window shows (a hidden frame plays nothing), with the
//   principles known on every page, and the answers `started`, `done`,
//   `closed` and `busy` go back to it. While the explanation plays the window
//   steps aside, and it returns when the explanation ends.
// - Buddy presents every explanation himself (F56's addendum (7) of
//   2026-10-25): while the guide's figure is out of the launcher, from its
//   leap until it is back, the launcher waits empty, as in the prototype.
// - Before the person met him (F60's addendum of 2026-10-26; the prototype
//   of prototypes-lazurio #92): on a page of his own Osobní Prostředí whose
//   Launchpad says his step needs his sign-in or the meeting
//   (`setup.buddyNext`), the launcher shows "1" and his window holds his
//   hello and the one thing he needs, with one action that opens his dialog
//   in Začínáme there. No frame is made then, so nothing of his chat loads
//   before the meeting, and no window of his answers before he can.
// - The Launchpad, which hosts the meeting's dialog, opens his window at its
//   end (`open`) and lifts the launcher over its dialog while the dialog
//   shows where he is (`spotlight`). The frame still never opens it.

/** The size of the window this tab remembers, in `sessionStorage`. */
export const buddyLayoutKey = "lazurio.buddy.layout";

/** The window's open sizes. */
export type BuddyWindowSize = Exclude<BuddyLayout, "closed">;

/** The frame as the view makes it, once per origin. */
export type BuddyFrameModel = Readonly<{
  src: string;
  title: string;
  sandbox: string;
  referrerpolicy: string;
  allow: string;
}>;

/** Buddy's step before the person met him, as the page knows it (F60's
 * addendum of 2026-10-26): what it needs next, Začínáme of his Launchpad
 * with his dialog to open, and the page's language. */
export type BuddyMeeting = Readonly<{
  step: "sign-in" | "introduce";
  href: string;
  lang: "cs" | "en";
}>;

/** Buddy's step before the meeting on a page of his own Osobní Prostředí:
 * Buddy's origin is of the current Environment's base host (only a personal
 * Environment's id has one label, as his origin's does), and its Launchpad
 * says what his step needs next (`setup.buddyNext`, with `buddy` missing).
 * Začínáme is on the Apps address the document names for that Environment,
 * an https one, never one composed from another origin. Null anywhere else:
 * on another Environment's page its Launchpad does not know him, so his
 * bubble is as before. */
export function buddyMeeting(
  shell: Shell | null,
  origin: string | null,
  lang: string | null,
): BuddyMeeting | null {
  if (shell === null || origin === null) return null;
  const step = shell.setup?.buddyNext;
  if (step === undefined || shell.setup?.buddy !== "missing") return null;
  const current = currentEnvironment(shell);
  if (
    current === null ||
    environmentIdOf(origin) !== current.id ||
    !current.apps.apps.startsWith("https:")
  )
    return null;
  return Object.freeze({
    step,
    href: buddyMeetHref(current.apps.apps),
    lang: lang === "cs" || lang === "en" ? lang : shell.locale,
  });
}

/** His window before the meeting: his hello, the one thing he needs, its
 * action leading to `href`, and the window's close button, in the page's
 * language. */
export type BuddyMeetingModel = Readonly<{
  step: BuddyMeeting["step"];
  hello: string;
  line: string;
  action: string;
  href: string;
  close: string;
}>;

/** What the view draws. */
export type BuddyBubbleModel = Readonly<{
  origin: string;
  /** Buddy's picture, its name for assistive technology, whether the
   * window shows, whether Buddy is out presenting the guide, the launcher
   * waiting empty, the "1" before the meeting (none while the window shows
   * or he is out), and whether the Launchpad lifts it over its dialog. */
  launcher: Readonly<{
    avatar: string;
    label: string;
    expanded: boolean;
    away: boolean;
    badge: string | null;
    spot: boolean;
  }>;
  /** The frame, from the first open on; null before. */
  frame: BuddyFrameModel | null;
  /** Before the meeting the window shows this instead of the frame. */
  meeting: BuddyMeetingModel | null;
  layout: BuddyLayout;
}>;

export type BuddyBubbleSeams = Readonly<{
  /** Buddy's origin in the page's merged document; null where there is
   * none. */
  origin: () => string | null;
  /** What the context is built from, but the guide's step; null on a page
   * without a person's document. */
  facts: () => Omit<BuddyContextFacts, "guide"> | null;
  /** Buddy's step before the meeting (`buddyMeeting`); null otherwise. */
  meeting: () => BuddyMeeting | null;
  /** The window of the frame the view made; null before. */
  frameWindow: () => BuddyFrameWindow | null;
  /** This tab's memory (`sessionStorage`), or null. */
  session: Store | null;
  /** Draws the bubble; null draws nothing. */
  draw: (model: BuddyBubbleModel | null) => void;
  /** Moves the focus to the launcher or into the frame. */
  focus: (target: "launcher" | "frame") => void;
  /** The page's guide (guide.ts). */
  guide: Readonly<{
    known: () => readonly string[];
    playing: () => string | null;
    tour: () => boolean;
    kind: () => ShellEnvironmentKind | null;
    /** Plays an explanation without a "?"; whether it played. */
    play: (explainer: string) => boolean;
  }>;
}>;

/** Buddy's name on the launcher and the frame, and on the guide's card
 * where he presents it: a name, the same in every language. */
export const buddyName = "Buddy";

export function createBuddyBubble(seams: BuddyBubbleSeams) {
  let origin: string | null = null;
  let frame: BuddyFrameModel | null = null;
  let layout: BuddyLayout = "closed";
  // Whether the guide's figure is out of the launcher; it stays out across
  // another origin, as the figure does.
  let away = false;
  // Buddy's step before the meeting, as the page last said it, and whether
  // the Launchpad lifts the launcher over its dialog.
  let meeting: BuddyMeeting | null = null;
  let spot = false;
  // The explanation the frame asked for while it plays, and the size its
  // window returns to.
  let asked: Readonly<{ explainer: string; restore: BuddyLayout }> | null =
    null;
  // The guide's last step, on the page's path it showed on.
  let step: Readonly<{ path: string; guide: BuddyGuideStep }> | null = null;
  let sender: ReturnType<typeof createBuddyContextSender> | null = null;
  let receiver: ReturnType<typeof createGuideReceiver> | null = null;

  const remembered = (): BuddyWindowSize => {
    try {
      return seams.session?.getItem(buddyLayoutKey) === "fullscreen"
        ? "fullscreen"
        : "panel";
    } catch {
      return "panel";
    }
  };
  const remember = (size: BuddyWindowSize): void => {
    try {
      seams.session?.setItem(buddyLayoutKey, size);
    } catch {}
  };

  function model(): BuddyBubbleModel | null {
    if (origin === null) return null;
    const copy = meeting === null ? null : shellMessages(meeting.lang);
    const badge = copy !== null && layout === "closed" && !away ? "1" : null;
    return Object.freeze({
      origin,
      launcher: Object.freeze({
        avatar: buddyAvatarSource(origin) ?? "",
        label: badge !== null && copy !== null ? copy.buddyNew : buddyName,
        expanded: layout !== "closed",
        away,
        badge,
        spot,
      }),
      frame,
      meeting:
        meeting === null || copy === null
          ? null
          : Object.freeze({
              step: meeting.step,
              hello: keepTogether(copy.buddyHello),
              line: keepTogether(
                meeting.step === "sign-in"
                  ? copy.buddyNeedsSignIn
                  : copy.buddyNeedsMeeting,
              ),
              action:
                meeting.step === "sign-in" ? copy.buddySignIn : copy.buddyMeet,
              href: meeting.href,
              close: copy.buddyClose,
            }),
      layout,
    });
  }

  /** The page's step before the meeting. A window open when the meeting
   * comes or goes closes: the hello never turns into the frame by itself,
   * nor the frame into the hello. */
  function readMeeting(): void {
    const was = meeting;
    meeting = origin === null ? null : seams.meeting();
    if ((was === null) !== (meeting === null) && layout !== "closed")
      layout = "closed";
  }

  /** Opens the window: before the meeting his hello in the panel, without
   * a frame; after it the frame, made the first time, in the remembered
   * size. */
  function openWindow(): void {
    if (meeting !== null) {
      show("panel", "frame");
      return;
    }
    frame ??= Object.freeze({
      src: buddyFrameSource(origin) ?? "",
      title: buddyName,
      ...buddyFrameAttributes,
    });
    show(remembered(), "frame");
  }
  const draw = () => seams.draw(model());

  /** The context now: the guide's step only on the path it showed on. */
  function context(): BuddyContext | null {
    const facts = seams.facts();
    if (facts === null) return null;
    if (step !== null && step.path !== facts.path) step = null;
    return buddyContext({ ...facts, guide: step?.guide ?? null });
  }

  function show(next: BuddyLayout, focus: "launcher" | "frame" | null): void {
    layout = next;
    draw();
    if (focus !== null) seams.focus(focus);
  }

  /** An explanation the frame asked for: the window steps aside while it
   * plays (`guided` brings it back). */
  function playAsked(explainer: string): void {
    const restore = layout;
    asked = Object.freeze({ explainer, restore });
    if (layout !== "closed") show("closed", null);
    if (seams.guide.play(explainer)) return;
    asked = null;
    if (restore !== "closed") show(restore, "frame");
  }

  function reset(next: string | null): void {
    origin = next;
    frame = null;
    layout = "closed";
    asked = null;
    step = null;
    sender =
      next === null
        ? null
        : createBuddyContextSender({
            origin: next,
            frame: seams.frameWindow,
            context,
          });
    receiver =
      next === null
        ? null
        : createGuideReceiver({
            origin: next,
            frame: seams.frameWindow,
            // Only a frame the person sees asks.
            known: () => (layout === "closed" ? [] : seams.guide.known()),
            playing: seams.guide.playing,
            tour: seams.guide.tour,
            kind: seams.guide.kind,
            play: playAsked,
          });
  }

  return Object.freeze({
    /** The page's state changed: Buddy's origin may come, go or change, and
     * the context with it. */
    update(): void {
      const next = seams.origin();
      if (next !== origin) reset(next);
      readMeeting();
      draw();
      sender?.changed();
    },
    /** The launcher's click: opens the window in the remembered size, the
     * frame made the first time, or closes it. */
    toggle(): void {
      if (origin === null) return;
      // The person decides now: an explanation the frame asked for still
      // answers it, but the window no longer returns by itself.
      if (asked !== null)
        asked = Object.freeze({ ...asked, restore: "closed" });
      if (layout !== "closed") {
        show("closed", "launcher");
        return;
      }
      openWindow();
    },
    /** The Launchpad's end of the meeting (F60's addendum of 2026-10-26):
     * his window opens as the launcher's click opens it, unless it shows
     * already; the frame still never opens it itself. Whether it shows. */
    open(): boolean {
      if (origin === null) return false;
      if (layout === "closed") openWindow();
      return true;
    },
    /** The Launchpad lifts the launcher over its own dialog while the
     * dialog shows where Buddy is (true), and lets it back (false). */
    spotlight(on: boolean): void {
      if (on === spot) return;
      spot = on;
      draw();
    },
    /** Escape on the host's page: from full screen to the panel (the
     * person's choice for this tab), from the panel closed. Whether it was
     * the bubble's. */
    escape(): boolean {
      if (layout === "fullscreen") {
        remember("panel");
        show("panel", "frame");
        return true;
      }
      if (layout === "panel") {
        show("closed", "launcher");
        return true;
      }
      return false;
    },
    /** A message to the page's window: the frame's request for an
     * explanation, its `ready` or its request for a size; anything else is
     * dropped. */
    receive(
      event: Readonly<{ data: unknown; origin: string; source: unknown }>,
    ): void {
      // Before the meeting the window is his hello, not the frame.
      if (origin === null || frame === null || meeting !== null) return;
      if (receiver?.receive(event) != null) return;
      const window = seams.frameWindow();
      const message = acceptBuddyFrameMessage(
        {
          data: event.data,
          origin: event.origin,
          fromBuddyFrame: window !== null && event.source === window,
        },
        origin,
      );
      if (message === null) return;
      if (message.type === buddyMessage.ready) {
        sender?.ready();
        return;
      }
      // A window the person opened is resized or closed; none is opened.
      if (layout === "closed" || message.mode === layout) return;
      if (message.mode === "closed") {
        show("closed", "launcher");
        return;
      }
      remember(message.mode);
      show(message.mode, "frame");
    },
    /** Something the context says may have changed (the page's path, the
     * column head, the colour scheme). */
    changed(): void {
      readMeeting();
      draw();
      sender?.changed();
    },
    /** The guide shows a step (`stop` from 0) of an explanation. */
    guideShown(explainer: string, stop: number): void {
      const path = seams.facts()?.path;
      if (path === undefined) return;
      step = Object.freeze({
        path,
        guide: Object.freeze({
          explainer,
          step: Math.min(Math.max(1, stop + 1), buddyContextLimits.steps),
        }),
      });
      sender?.changed();
    },
    /** The guide started, was done or closed an explanation: the frame hears
     * it about the one it asked for, and its window returns as it ends. */
    guided(event: GuideEvent): void {
      const was = asked;
      if (was === null || event.explainer !== was.explainer) return;
      receiver?.reply(event.type, event.explainer);
      if (event.type === "started") return;
      asked = null;
      if (layout === "closed" && was.restore !== "closed")
        show(was.restore, "frame");
    },
    /** The guide's figure, Buddy presenting an explanation, left the
     * launcher (true) or is back in it (false): the launcher waits empty
     * meanwhile. The window and the frame are as they were. */
    guideOut(out: boolean): void {
      if (out === away) return;
      away = out;
      draw();
    },
    /** What is drawn now. */
    model,
  });
}

export type BuddyBubble = ReturnType<typeof createBuddyBubble>;
