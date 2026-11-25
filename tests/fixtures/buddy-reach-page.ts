// A page for tests/shell-buddy-reach-browser.test.ts: Buddy's bubble and its
// element wired as the shell wires them, with the reachability probe of
// review #1253, on a page of its own. The test decides in the browser
// whether Buddy's origin answers, and reads what the element draws through
// `window.buddyTest`.
import { createBuddyBubble } from "../../src/shell/buddy-bubble";
import { createBuddyBubbleView } from "../../src/shell/buddy-element";

const origin = "https://buddy.example.lazurio.io";
const host = document.createElement("lazurio-buddy");
document.body.append(host);

const view = createBuddyBubbleView(host, {
  logo: "<svg xmlns='http://www.w3.org/2000/svg'/>",
  toggle: () => bubble.toggle(),
  escape: () => bubble.escape(),
  follow: () => {},
  store: null,
  reachability: (ok) => bubble.reachability(ok),
});
const bubble = createBuddyBubble({
  origin: () => origin,
  facts: () => ({
    shell: {
      locale: "cs",
    } as never,
    space: null,
    active: null,
    lang: "cs",
    path: "/",
    theme: "light",
  }),
  meeting: () => null,
  frameWindow: () => view.frameWindow(),
  session: null,
  draw: (model) => view.draw(model),
  focus: (target) => view.focus(target),
  probe: () => view.probe(),
  guide: {
    known: () => [],
    playing: () => null,
    tour: () => false,
    kind: () => "work",
    play: () => false,
  },
});

const root = () => host.shadowRoot;
Object.assign(window, {
  buddyTest: {
    click: () => root()?.querySelector<HTMLButtonElement>(".launcher")?.click(),
    state: () => {
      const meet = root()?.querySelector<HTMLElement>(".meet") ?? null;
      const action = root()?.querySelector<HTMLElement>(".meet-action") ?? null;
      return {
        layout: bubble.model()?.layout ?? null,
        card: meet !== null && !meet.hidden,
        line: root()?.querySelectorAll(".meet-line")[1]?.textContent ?? null,
        actionShown:
          action !== null && getComputedStyle(action).display !== "none",
        actionDisplay:
          action === null ? null : getComputedStyle(action).display,
        actionHidden: action?.hidden ?? null,
        frames: root()?.querySelectorAll("iframe").length ?? 0,
      };
    },
  },
});
bubble.update();
