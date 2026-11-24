// The look of `<lazurio-frame>` (frame-element.ts), the approved prototype's
// (LazurioDevelopment prototypes-lazurio#149): a 3 px frame inside the
// window's edge, blue or red, solid or dashed, and one label at the top
// centre, the version first and never shortened, then whose Environment it
// is, which gives way on a narrow screen. The frame never takes a click and
// never moves; printing leaves it out.
export const frameCss = `
:host {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  display: block;
}
.frame {
  position: absolute;
  inset: 0;
  box-sizing: border-box;
  border: 3px solid var(--frame-tone);
  pointer-events: none;
  --frame-tone: #3e63dd;
}
.frame[data-tone="red"] { --frame-tone: #e5484d; }
.frame[data-dashed] { border-style: dashed; }
.label {
  position: absolute;
  top: -3px;
  left: 50%;
  display: flex;
  max-width: calc(100% - 32px);
  overflow: hidden;
  border-radius: 0 0 8px 8px;
  background: var(--frame-tone);
  color: #fff;
  font: 600 12px / 1.4 "Inter Tight Variable", "Inter Tight", system-ui, sans-serif;
  white-space: nowrap;
  transform: translateX(-50%);
}
.version {
  flex: none;
  padding: 2px 8px 3px 10px;
  letter-spacing: 0.04em;
}
.version:only-child { padding-right: 10px; }
.environment {
  min-width: 0;
  padding: 2px 10px 3px 8px;
  overflow: hidden;
  border-left: 1px solid rgb(255 255 255 / 35%);
  font-weight: 500;
  text-overflow: ellipsis;
}
.environment:only-child {
  padding-left: 10px;
  border-left: 0;
  font-weight: 600;
}
@media print { :host { display: none; } }
`;
