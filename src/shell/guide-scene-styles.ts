// The principles' scenes in the guide's card (decision F56's addendum (3) of
// 2026-10-19; guide-scenes.ts, guide-stage.ts), after the Lazurio
// prototype's guide.css and the brand's video standard: a paper stage, white
// objects, blue for the answer, the expressive vermilion only for "no".
//
// Two halves. The plain rules are each beat's finished frame: what stands
// where once it has moved, the state of every part, and nothing that moves.
// The motion is only in `motionCss`, inside `@media (prefers-reduced-motion:
// no-preference)` and only where the layer is not still (`data-still`), so
// with less motion a beat is its still frame (tests/shell-guide-scenes.test.ts
// holds it). Every animation either loops (an agent at work, a cursor that
// taps) or ends where the plain rules stand, so the end of a beat in motion
// is its still frame. Every class is `s-` and a part's name, so none meets
// the card's own.

const stillCss = `
.stage { position: relative; flex: none; align-self: center; overflow: hidden; border-radius: var(--lz-radius-sm); background: var(--lz-paper); }
.s-scene { --e: cubic-bezier(0.22, 0.8, 0.24, 1); position: absolute; top: 0; left: 0; width: 320px; height: 180px; scale: var(--k, 1); transform-origin: 0 0; color: var(--lz-ink); font-size: 11px; font-weight: 400; line-height: 1.2; letter-spacing: 0; }
:where(.s-scene) span { display: block; }
:where(.s-scene) svg { display: block; flex: none; width: 12px; height: 12px; }
.s-o { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
.s-o:not([data-in]) { opacity: 0; }
.s-strip { width: 640px; height: 180px; }
.s-tag { display: inline-flex; align-items: center; gap: 3px; margin-top: 2px; padding: 0 5px; border-radius: var(--lz-radius-pill); background: var(--lz-blue-50); color: var(--lz-blue-800); font-size: 9.5px; line-height: 15px; white-space: nowrap; }
.s-tag svg { width: 11px; height: 11px; }
.s-ink { background: var(--lz-ink); color: var(--lz-white); }
.s-box { border: 1px solid var(--lz-line); border-radius: var(--lz-radius-md); background: var(--lz-white); }
.s-mine { border-color: var(--lz-blue-200); }
.s-org { background: var(--lz-gray-25); }
.s-box[data-state~="guard"], .s-box[data-state~="hot"] { border-color: var(--lz-blue-500); box-shadow: 0 0 0 4px var(--lz-blue-50); }
.s-title { position: absolute; top: 7px; left: 9px; display: flex; align-items: center; gap: 4px; color: var(--lz-ink-muted); font-size: 10.5px; font-weight: var(--lz-weight-akce); white-space: nowrap; }
.s-corner { position: absolute; top: 6px; right: 7px; color: var(--lz-blue-600); }
.s-corner svg { width: 14px; height: 14px; }
.s-center { position: absolute; inset: 0; display: grid; place-items: center; }
.s-head { display: grid; width: 22px; height: 22px; place-items: center; border: 1px solid var(--lz-line); border-radius: 50%; background: var(--lz-white); color: var(--lz-ink-muted); }
.s-head svg { width: 14px; height: 14px; }
.s-lg { width: 36px; height: 36px; border-color: var(--lz-blue-200); background: var(--lz-blue-50); color: var(--lz-blue-700); }
.s-lg svg { width: 20px; height: 20px; }
.s-person, .s-agent { display: flex; flex-direction: column; align-items: center; }
.s-person .s-tag { background: var(--lz-gray-100); color: var(--lz-ink-muted); }
.s-dot { display: grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; background: var(--lz-blue-500); color: var(--lz-white); box-shadow: 0 0 0 3px var(--lz-blue-100); }
.s-dot svg { width: 13px; height: 13px; }
.s-sm { width: 16px; height: 16px; box-shadow: none; }
.s-sm svg { width: 10px; height: 10px; }
.s-mark { display: grid; width: 18px; height: 18px; place-items: center; border-radius: 50%; background: var(--lz-blue-500); color: var(--lz-white); }
.s-no { background: var(--lz-expressive-vermilion); }
.s-you { display: flex; flex-direction: column; align-items: flex-start; color: var(--lz-ink); }
.s-you svg, .s-acursor svg { width: 15px; height: 15px; fill: var(--lz-white); }
.s-you .s-tag { margin: -1px 0 0 9px; }
.s-chip { display: flex; min-width: 82px; align-items: center; gap: 5px; padding: 6px 8px; border: 1px solid var(--lz-line); border-radius: var(--lz-radius-sm); background: var(--lz-white); white-space: nowrap; }
.s-chip[data-state~="hot"] { border-color: var(--lz-blue-500); box-shadow: 0 0 0 3px var(--lz-blue-50); }
.s-hand { position: absolute; top: 18px; left: 62px; }
.s-chip:not([data-state~="drag"]) .s-hand { display: none; }
.s-bubble { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 11px; font-size: 10.5px; white-space: nowrap; }
.s-bubble svg { width: 11px; height: 11px; }
.s-ask { background: var(--lz-gray-100); }
.s-answer { padding-left: 4px; background: var(--lz-blue-50); }
.s-typing { display: flex; gap: 3px; }
.s-typing .s-i { width: 5px; height: 5px; border-radius: 50%; background: var(--lz-blue-500); }
.s-link { display: flex; align-items: center; gap: 3px; padding: 1px 4px; border-radius: 4px; color: var(--lz-blue-700); font-weight: var(--lz-weight-akce); text-decoration: underline; }
.s-answer[data-state~="hot"] .s-link { background: var(--lz-blue-100); }
.s-composer { position: absolute; right: 9px; bottom: 9px; left: 9px; height: 16px; border: 1px solid var(--lz-line); border-radius: var(--lz-radius-pill); }
.s-tray { position: absolute; bottom: 9px; left: 9px; display: flex; align-items: center; gap: 4px; font-size: 10.5px; }
.s-eye { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 50%; background: var(--lz-blue-50); color: var(--lz-blue-700); }
.s-eye svg { width: 20px; height: 20px; }
.s-line { height: 2px; border-radius: 1px; background: var(--lz-blue-500); transform-origin: 0 50%; clip-path: inset(-6px 100% -6px 0); }
.s-line[data-in] { clip-path: inset(-6px -12px -6px 0); }
.s-line[data-state~="strong"] { height: 3.5px; }
.s-arrow::after { position: absolute; top: 50%; right: -1px; border-top: 4.5px solid transparent; border-bottom: 4.5px solid transparent; border-left: 8px solid var(--lz-blue-500); content: ""; translate: 0 -50%; }
.s-pc { width: 226px; }
.s-screen { overflow: hidden; height: 128px; border: 1.5px solid var(--lz-gray-300); border-radius: var(--lz-radius-md); background: var(--lz-white); }
.s-bar { display: flex; height: 16px; align-items: center; gap: 4px; padding: 0 7px; border-bottom: 1px solid var(--lz-line-faint); color: var(--lz-ink-muted); }
.s-bar svg, .s-bar img { display: block; width: 11px; height: 11px; }
.s-name { font-size: 9.5px; font-weight: var(--lz-weight-akce); white-space: nowrap; }
.s-desk { position: relative; height: 109px; background: var(--lz-gray-25); }
.s-stand { width: 52px; height: 10px; margin: 0 auto; background: var(--lz-gray-200); clip-path: polygon(18% 0, 82% 0, 100% 100%, 0 100%); }
.s-laptop .s-stand { width: 250px; height: 7px; margin-left: -12px; border-radius: 0 0 6px 6px; clip-path: none; }
.s-win { position: absolute; top: 8px; left: 12px; width: 136px; height: 70px; overflow: hidden; border: 1px solid var(--lz-line); border-radius: 6px; background: var(--lz-white); box-shadow: 0 4px 12px rgb(0 0 0 / 6%); opacity: 0; transform: scale(0.55); transform-origin: 0 0; }
.s-wbar { display: flex; height: 14px; align-items: center; gap: 4px; padding: 0 5px; border-bottom: 1px solid var(--lz-line-faint); color: var(--lz-blue-600); }
.s-wbar svg { width: 9px; height: 9px; }
.s-wbar .s-i { height: 6px; flex: 1; border-radius: 3px; background: var(--lz-gray-100); }
.s-wbody { display: flex; flex-direction: column; gap: 7px; padding: 9px 9px 0; }
.s-wbody .s-i { width: 84%; height: 5px; border-radius: 3px; background: var(--lz-gray-200); transform-origin: 0 0; }
.s-wbody .s-i:nth-child(2) { width: 62%; }
.s-wbody .s-i:nth-child(3) { width: 74%; }
.s-dock { position: absolute; bottom: 6px; left: 50%; display: flex; gap: 5px; padding: 3px 5px; border: 1px solid var(--lz-line); border-radius: 8px; background: var(--lz-white); opacity: 0; translate: -50% 0; }
.s-app { display: grid; width: 18px; height: 18px; place-items: center; border-radius: 5px; background: var(--lz-blue-50); color: var(--lz-blue-700); opacity: 0; transform: scale(0.3); }
.s-app svg { width: 11px; height: 11px; }
.s-acursor { position: absolute; top: 0; left: 0; display: flex; align-items: flex-start; gap: 1px; color: var(--lz-blue-600); opacity: 0; translate: 96px 40px; }
[data-state~="apps"] .s-win, [data-state~="apps"] .s-app { opacity: 1; transform: none; }
[data-state~="apps"] .s-dock, [data-state~="work"] .s-acursor { opacity: 1; }
[data-state~="work"] .s-wbody .s-i { background: var(--lz-blue-200); }
.s-peek { position: absolute; top: 9px; left: 26px; width: 150px; height: 84px; padding: 5px; border: 1.5px dashed var(--lz-blue-500); border-radius: 8px; background: var(--lz-blue-50); }
.s-pscreen { position: relative; height: 100%; overflow: hidden; border: 1px solid var(--lz-line); border-radius: 5px; background: var(--lz-gray-25); }
.s-pwin { position: absolute; top: 6px; left: 7px; display: flex; width: 82px; flex-direction: column; gap: 5px; padding: 6px; border: 1px solid var(--lz-line); border-radius: 4px; background: var(--lz-white); }
.s-pwin .s-i { height: 4px; border-radius: 2px; background: var(--lz-blue-200); }
.s-pwin .s-i:nth-child(2) { width: 70%; }
.s-pdock { position: absolute; bottom: 5px; left: 50%; display: flex; gap: 3px; padding: 2px 3px; border: 1px solid var(--lz-line); border-radius: 4px; background: var(--lz-white); translate: -50% 0; }
.s-pdock .s-i { width: 9px; height: 9px; border-radius: 2px; background: var(--lz-blue-50); }
.s-peye { position: absolute; top: -11px; right: -11px; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--lz-blue-500); color: var(--lz-white); }
.s-peye svg { width: 13px; height: 13px; }
.s-ycursor { position: absolute; top: 0; left: 0; translate: 176px 66px; }
.s-lzwin { position: absolute; top: 8px; left: 156px; width: 62px; height: 62px; overflow: hidden; border: 1px solid var(--lz-blue-200); border-radius: 6px; background: var(--lz-white); box-shadow: 0 4px 12px rgb(0 0 0 / 6%); opacity: 0; transform: translateX(8px); }
.s-lzbar { display: flex; height: 13px; align-items: center; gap: 3px; padding: 0 4px; border-bottom: 1px solid var(--lz-line-faint); }
.s-lzbar img { display: block; width: 8px; height: 8px; }
.s-lzbar .s-name { font-size: 7.5px; }
.s-lzbody { display: flex; flex-direction: column; gap: 5px; padding: 7px 6px 0; }
.s-lzbody .s-i { width: 80%; height: 4px; border-radius: 2px; background: var(--lz-blue-200); }
.s-lzbody .s-i:nth-child(2) { width: 56%; }
.s-lzwin .s-peye { top: auto; right: 4px; bottom: 4px; width: 18px; height: 18px; }
.s-lzwin .s-peye svg { width: 11px; height: 11px; }
[data-state~="watch"] .s-lzwin { opacity: 1; transform: none; }
.s-tile { display: flex; width: 96px; height: 54px; flex-direction: column; justify-content: center; gap: 4px; padding: 0 10px; border: 1px solid var(--lz-line); border-radius: var(--lz-radius-md); background: var(--lz-white); }
.s-tname { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: var(--lz-weight-akce); white-space: nowrap; }
.s-tname svg { width: 16px; height: 16px; }
.s-status { min-height: 13px; color: var(--lz-ink-faint); font-size: 10px; white-space: nowrap; opacity: 0; }
.s-tile[data-state~="on"] { border-color: var(--lz-blue-500); box-shadow: 0 0 0 3px var(--lz-blue-50); }
.s-tile[data-state~="on"] .s-status { color: var(--lz-blue-700); opacity: 1; }
.s-tile[data-state~="off"] { border-style: dashed; opacity: 0.7; }
.s-tile[data-state~="off"] .s-status { opacity: 1; }
.s-key { display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--lz-blue-500); color: var(--lz-white); box-shadow: 0 0 0 3px var(--lz-blue-100); transform: rotate(-90deg); transform-origin: 50% 50%; }
.s-key svg { width: 13px; height: 13px; }
`;

/** The motion, where it is not reduced: objects travel, rise in and fade
 * between beats, and within a beat what the step tells happens once
 * (a file dragged in, a key turned) or goes on (an agent at work). */
const moving = ".layer:not([data-still])";
const motionCss = `
@media (prefers-reduced-motion: no-preference) {
  ${moving} .s-o { transition: translate 0.75s var(--e), scale 0.85s var(--e), opacity 0.45s ease, clip-path 0.9s var(--e), border-color 0.4s ease, box-shadow 0.4s ease, height 0.4s ease; transition-delay: var(--d, 0ms); }
  ${moving} .s-strip { transition-duration: 0.9s; }
  ${moving} .s-win { transition: transform 0.6s var(--e) 0.15s, opacity 0.4s ease 0.15s; }
  ${moving} .s-dock, ${moving} .s-acursor { transition: opacity 0.3s ease; }
  ${moving} .s-app { transition: transform 0.45s var(--e) 0.3s, opacity 0.3s ease 0.3s; }
  ${moving} .s-app:nth-child(2) { transition-delay: 0.41s; }
  ${moving} .s-app:nth-child(3) { transition-delay: 0.52s; }
  ${moving} .s-app:nth-child(4) { transition-delay: 0.63s; }
  ${moving} .s-link { transition: background 0.3s ease; }
  ${moving} .s-lzwin { transition: transform 0.6s var(--e) 0.2s, opacity 0.4s ease 0.2s; }
  ${moving} [data-state~="work"] .s-acursor { animation: s-work 3.6s var(--e) infinite; }
  ${moving} [data-state~="work"] .s-wbody .s-i { animation: s-type 3.6s var(--e) infinite; }
  ${moving} [data-state~="work"] .s-wbody .s-i:nth-child(2) { animation-delay: 0.5s; }
  ${moving} [data-state~="work"] .s-wbody .s-i:nth-child(3) { animation-delay: 1s; }
  ${moving} [data-state~="moving"] .s-dot, ${moving} .s-typing .s-i { animation: s-hover 1.6s ease-in-out infinite; }
  ${moving} .s-typing .s-i:nth-child(2) { animation-delay: 0.15s; }
  ${moving} .s-typing .s-i:nth-child(3) { animation-delay: 0.3s; }
  ${moving} [data-state~="travel"] > .s-agent { animation: s-travel 2.2s var(--e) infinite; }
  ${moving} [data-state~="bump"] > .s-agent { animation: s-bump 1.1s var(--e) 0.1s backwards, s-knock 1.1s ease-in-out 1.4s infinite; }
  ${moving} [data-state~="knock"] > .s-person { animation: s-knock 1.1s ease-in-out 0.25s infinite; }
  ${moving} [data-state~="tap"] > .s-you { animation: s-tap 1.3s ease-in-out 0.3s infinite; }
  ${moving} .s-chip[data-state~="drag"] { animation: s-drag 1.3s var(--e) 0.4s backwards; }
  ${moving} .s-key[data-state~="turn"] { animation: s-turn 1.7s var(--e) 0.2s backwards; }
  ${moving} .s-tile[data-state~="sign"] { animation: s-sign 0.5s ease 1.3s backwards; }
  ${moving} .s-tile[data-state~="sign"] .s-status { animation: s-late 0.5s ease 1.4s backwards; }
  ${moving} .s-tile[data-state~="off"] .s-status { animation: s-late 0.5s ease 0.4s backwards; }
  ${moving} .s-o[data-in] > .s-tray { animation: s-late 0.5s ease 1.2s backwards; }
}
@keyframes s-work { 0%, 100% { translate: 150px 84px; } 22% { translate: 40px 26px; scale: 1; } 28% { translate: 40px 26px; scale: 0.8; } 34% { translate: 40px 26px; scale: 1; } 58% { translate: 96px 40px; scale: 1; } 64% { translate: 96px 40px; scale: 0.8; } 70% { translate: 96px 40px; scale: 1; } }
@keyframes s-type { 0% { transform: scaleX(0); } 45%, 100% { transform: scaleX(1); } }
@keyframes s-hover { 50% { transform: translateY(-3px); } }
@keyframes s-travel { 0% { opacity: 0; transform: translateX(-12px); } 15% { opacity: 1; } 80% { opacity: 1; transform: translateX(20px); } 100% { opacity: 0; transform: translateX(26px); } }
@keyframes s-bump { 0% { transform: translateX(92px); } 70% { transform: translateX(-4px); } 85% { transform: translateX(2px); } }
@keyframes s-knock { 0%, 100% { transform: none; } 35% { transform: translateX(-5px); } 50% { transform: translateX(1px); } }
@keyframes s-tap { 0%, 60%, 100% { transform: none; } 70% { transform: scale(0.85); } }
@keyframes s-drag { from { transform: translate(150px, 80px); } }
@keyframes s-turn { 0% { opacity: 0; transform: translate(-30px, 40px); } 35% { opacity: 1; transform: none; } 60% { transform: rotate(-90deg); } }
@keyframes s-sign { from { border-color: var(--lz-line); box-shadow: none; } }
@keyframes s-late { from { opacity: 0; transform: translateY(4px); } }
`;

/** The scenes' stylesheet, after the card's in the guide's shadow root. */
export const guideSceneCss = `${stillCss}${motionCss}`;
