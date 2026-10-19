import { baseCss, hostTokens } from "./base-styles";
import { guideSceneCss } from "./guide-scene-styles";

// The guide's layer inside `<lazurio-buddy>`'s shadow root (decision F56):
// the ring of the Launchpad's first-run tour (an accent line, its glow and
// the page dimmed around it), the neutral guide's mark travelling from the
// bubble's corner to the card, and the card itself: the explanation's
// title, the step's words, its dots and two buttons. The layer lets every
// click through but the card's. Light, as the design system's floating
// layers are: the one floating shadow and a hairline. With less motion nothing travels,
// hops or fades: each step is a still frame (`prefers-reduced-motion`, and
// the layer's `data-still` where the page asked for it before the media
// query was read). Nothing here reaches the host page. Every step's words
// stand in one place (`.lines`), only the step's own shown, so the card keeps
// one size through an explanation; a principle's scene stands between them
// and the buttons (guide-scene-styles.ts, decision F56's addendum (3)).

const guideCss = `
:host { display: contents; }
.layer { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; }
.ring { position: fixed; border-radius: var(--lz-radius-md); box-shadow: 0 0 0 2px var(--lz-accent), 0 0 0 6px color-mix(in oklab, var(--lz-accent) 25%, transparent), 0 0 0 9999px rgb(0 0 0 / 0.18); transition: left 0.45s cubic-bezier(0.34, 0.9, 0.3, 1), top 0.45s cubic-bezier(0.34, 0.9, 0.3, 1), width 0.45s cubic-bezier(0.34, 0.9, 0.3, 1), height 0.45s cubic-bezier(0.34, 0.9, 0.3, 1); animation: guide-in 0.3s ease-out both; }
.mark { position: fixed; top: 0; left: 0; display: grid; width: 40px; height: 40px; place-items: center; border-radius: 50%; background: var(--lz-white); box-shadow: 0 0 0 1px var(--lz-line), var(--lz-shadow-float); transition: transform 0.7s cubic-bezier(0.34, 0.9, 0.3, 1); }
.mark img { display: block; width: 24px; height: 24px; }
.mark[data-travel] img { animation: guide-hop 0.7s ease-in-out both; }
.card { position: fixed; display: flex; flex-direction: column; gap: 8px; padding: 14px 16px 12px; border: 1px solid var(--lz-line); border-radius: var(--lz-radius-md); background: var(--lz-white); color: var(--lz-ink); box-shadow: var(--lz-shadow-float); pointer-events: auto; animation: guide-in 0.3s ease-out 0.35s both; }
.card[data-side]::before { position: absolute; width: 10px; height: 10px; border-bottom: 1px solid var(--lz-line); border-left: 1px solid var(--lz-line); background: var(--lz-white); content: ""; }
.card[data-side="right"]::before { top: calc(var(--guide-arrow, 23px) - 5px); left: -6px; transform: rotate(45deg); }
.card[data-side="left"]::before { top: calc(var(--guide-arrow, 23px) - 5px); right: -6px; transform: rotate(-135deg); }
.card[data-side="below"]::before { top: -6px; left: calc(var(--guide-arrow, 23px) - 5px); transform: rotate(135deg); }
.card[data-side="above"]::before { bottom: -6px; left: calc(var(--guide-arrow, 23px) - 5px); transform: rotate(-45deg); }
.title { padding-left: 24px; color: var(--lz-ink-muted); font-size: 12px; font-weight: var(--lz-weight-akce); }
.lines { display: grid; }
.lines > .line { grid-area: 1 / 1; }
.lines > .line:not([data-now]) { visibility: hidden; }
.line { display: flex; flex-direction: column; gap: 2px; margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; animation: guide-rise 0.4s ease-out both; }
.sub { color: var(--lz-ink-muted); font-size: 12.5px; font-weight: 400; letter-spacing: normal; }
.foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 2px; }
.dots { display: flex; gap: 2px; margin-right: auto; }
.dots button { display: grid; width: 15px; height: 15px; padding: 0; border: 0; place-items: center; background: transparent; cursor: pointer; }
.dots button::after { width: 7px; height: 7px; border-radius: 50%; background: var(--lz-gray-200); content: ""; }
.dots button[aria-current="step"]::after { background: var(--lz-accent); }
.quit { padding: 0; border: 0; background: transparent; color: var(--lz-ink-muted); font-size: 13px; cursor: pointer; }
.quit:hover { color: var(--lz-ink); }
.invite { color: var(--lz-ink); font-size: 13px; font-weight: var(--lz-weight-akce); }
.more { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px 12px; }
.docs { color: var(--lz-ink-muted); font-size: 13px; }
.docs:hover { color: var(--lz-ink); }
.primary { min-height: 32px; padding: 0 14px; border: 0; border-radius: var(--lz-radius-sm); background: var(--lz-accent-button); color: var(--lz-on-accent); font-size: 13px; font-weight: var(--lz-weight-akce); cursor: pointer; }
.primary:hover { background: var(--lz-accent-button-hover); }
@keyframes guide-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes guide-rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes guide-hop { 0% { transform: translateY(0); } 45% { transform: translateY(-22px); } 85% { transform: translateY(0) scale(1.06, 0.94); } 100% { transform: none; } }
.layer[data-still] .ring, .layer[data-still] .mark, .layer[data-still] .card, .layer[data-still] .line, .layer[data-still] .mark img { transition: none; animation: none; }
@media (prefers-reduced-motion: reduce) {
  .ring, .mark, .card, .line, .mark img { transition: none; animation: none; }
}
`;

/** The guide's stylesheet in its element's shadow root. */
export const guideLayerCss = `${hostTokens}\n${baseCss}\n${guideCss}\n${guideSceneCss}`;
