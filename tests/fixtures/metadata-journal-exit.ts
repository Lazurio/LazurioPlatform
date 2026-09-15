import type { Fetcher } from "tuf-js";
import { MetadataJournalFetcher } from "../../src/distribution/metadata-journal";

const directory = process.argv[2];
if (!directory) throw new Error("Explicit test directory required");
const transport: Fetcher = {
  async downloadBytes() {
    return Buffer.from("received before exit");
  },
  async downloadFile() {
    throw new Error("Unexpected target request");
  },
};
await new MetadataJournalFetcher(
  transport,
  directory,
  "https://example.invalid/",
).downloadBytes("https://example.invalid/2.root.json", 100);
process.exit(23);
