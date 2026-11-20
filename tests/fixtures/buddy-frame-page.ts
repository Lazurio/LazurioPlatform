// A page for tests/shell-buddy-frame-browser.test.ts: Buddy GEN4's bubble
// and its element, wired as the shell wires them, on a page of its own. The
// test drives it through `window.buddyTest`; what Buddy's frame says it
// received comes back as `{type: "test.received", received}` and is kept in
// `received`.
import { createBuddyBubble } from "../../src/shell/buddy-bubble";
import { createBuddyBubbleView } from "../../src/shell/buddy-element";

const origin = "https://buddy.example.lazurio.io";
const host = document.createElement("lazurio-buddy");
document.body.append(host);
const received: string[] = [];
let playing: string | null = null;

const view = createBuddyBubbleView(host, {
  logo: "<svg xmlns='http://www.w3.org/2000/svg'/>",
  toggle: () => bubble.toggle(),
  escape: () => bubble.escape(),
  follow: () => {},
  store: null,
});
const bubble = createBuddyBubble({
  origin: () => origin,
  facts: () => null,
  meeting: () => null,
  // Buddy GEN4: the page follows his sign.
  signal: () => ({
    state: "quiet",
    since: null,
    request: null,
    startedBy: null,
  }),
  frameWindow: () => view.frameWindow(),
  session: null,
  draw: (model) => view.draw(model),
  focus: (target) => view.focus(target),
  guide: {
    known: () => ["files"],
    playing: () => playing,
    tour: () => false,
    kind: () => "personal",
    play: (explainer) => {
      playing = explainer;
      return true;
    },
  },
});
window.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown; received?: unknown } | null;
  if (data?.type === "test.received" && typeof data.received === "string") {
    received.push(data.received);
    return;
  }
  bubble.receive(event);
});

Object.assign(window, {
  buddyTest: {
    bubble,
    received,
    playing: () => playing,
    stop: () => {
      playing = null;
    },
    frames: () => host.shadowRoot?.querySelectorAll("iframe").length ?? 0,
  },
});
bubble.update();
