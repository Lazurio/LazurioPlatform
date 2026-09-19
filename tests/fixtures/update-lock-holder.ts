import { acquireUpdateLock } from "../../src/update/lock";

// Holds the update lock until killed; the test proves the kernel releases it.
const path = process.argv[2];
if (!path) throw new Error("Lock path required");
const lock = await acquireUpdateLock(path, { timeoutMs: 5_000 });
console.log("held");
setInterval(() => lock, 1_000);
