import { tmpdir } from "node:os";

/** The directory for a temporary home that holds a computer's Unix socket.
 * The socket's path must fit `sun_path`, 104 bytes on macOS, where
 * `tmpdir()` is `/var/folders/…/T/`, about 49 bytes; with
 * `lzc-XXXXXX/.local/state/lazurio/computers/<id>.sock` under it the broker
 * refuses the home as too long (#1065). `/tmp` is short on every POSIX
 * runner. */
export const socketHomeParent = () =>
  process.platform === "win32" ? tmpdir() : "/tmp";
