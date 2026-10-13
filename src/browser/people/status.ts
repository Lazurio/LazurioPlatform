/** What the people's view says in the middle of its page area (decision F39,
 * #392), as a pure function: the view page's script (`client.ts`) applies it
 * to its DOM; the tests run it without one.
 *
 * Nothing once the view has ended, or once its socket is open and a frame is
 * drawn: the page is there. "connecting" while the socket is not open, and
 * while the Environment's browser itself reconnects (the hub keeps the socket
 * open and says `{t: "browser", state: "reconnecting"}`, and the banner says
 * so). "loading" only when the socket is open, the browser is there and the
 * tab has painted nothing yet: its page still loads, as for a new tab on a
 * site that does not answer until Chrome paints its own error page. */
export type ViewStatus = "hidden" | "connecting" | "loading";

export function viewStatus(
  state: Readonly<{
    ended: boolean;
    open: boolean;
    drawn: boolean;
    browserReconnecting: boolean;
  }>,
): ViewStatus {
  if (state.ended) return "hidden";
  if (!state.open) return "connecting";
  if (state.drawn) return "hidden";
  return state.browserReconnecting ? "connecting" : "loading";
}
