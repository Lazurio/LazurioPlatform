import type { FrameHeader } from "./protocol";

/** The frames of one remote tab as the people's view draws them, and its
 * acknowledgements (F39's addendum of 2026-10-13): the service sends a
 * viewer only a few frames it has not acknowledged, so what waits on the way
 * stays short on a slow link. While one frame decodes only the newest waits:
 * it is the current one. The view is done with a frame once it has drawn it
 * or cannot (it does not decode), and then acknowledges it. One
 * acknowledgement covers every frame before it, so a frame the newest took
 * the place of is done with the newest, and the service never waits for a
 * frame the view will not draw. A frame without a number (a service from
 * before acknowledgements) is drawn and not acknowledged. Pure, so the tests
 * run it without a DOM: `client.ts` gives it the decoding, the drawing and
 * the socket. */
export class FramePump<Jpeg, Picture> {
  private waiting: Readonly<{ header: FrameHeader; jpeg: Jpeg }> | null = null;
  private running = false;

  constructor(
    private readonly seams: Readonly<{
      /** The frame's picture, null when it cannot be decoded. */
      decode: (jpeg: Jpeg) => Promise<Picture | null>;
      show: (picture: Picture, header: FrameHeader) => void;
      ack: (frame: number) => void;
    }>,
  ) {}

  /** A frame from the service: drawn next, or in the place of the one that
   * waits. */
  push(frame: Readonly<{ header: FrameHeader; jpeg: Jpeg }>): void {
    this.waiting = frame;
    if (!this.running) void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      for (let frame = this.waiting; frame !== null; frame = this.waiting) {
        this.waiting = null;
        const picture = await this.seams.decode(frame.jpeg).catch(() => null);
        // A frame that cannot be drawn still ends: the service must not wait
        // for it.
        try {
          if (picture !== null) this.seams.show(picture, frame.header);
        } catch {}
        if (frame.header.seq !== undefined) this.seams.ack(frame.header.seq);
      }
    } finally {
      this.running = false;
    }
  }
}
