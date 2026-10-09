import {
  createRelayClient,
  unixSocketTransport,
} from "../../src/organization-settings/relay";

// One settings read through the relay socket named by the first argument, in
// a process of its own, so that the proxy variables a test gives it reach
// nothing else. Prints the read as JSON.
const socket = process.argv[2];
if (socket === undefined) throw new Error("usage: relay-call.ts <socket>");
const client = createRelayClient({
  transport: unixSocketTransport(socket),
  retryDelaysMs: [],
});
console.log(JSON.stringify(await client.readSettings(null)));
