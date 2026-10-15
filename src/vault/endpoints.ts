// Where a vault answers (decisions F53 and F53's amendment of 2026-10-16
// after root decision 0203 point 7). A Lazurio Vaultwarden serves its web
// vault, its identity and its API under its one origin (`<server>/identity`,
// `<server>/api`). The Bitwarden cloud serves them on three hosts per region,
// and a personal Environment's own Bitwarden is in one of two regions; the
// regions are an allow-list, never a server a person names. No import: the
// request layer (register.ts) and the account file (store.ts) both read it.

export type BitwardenRegion = "eu" | "us";

export type BitwardenEndpoints = Readonly<{
  /** The web vault: what `bw config server` takes and links open. */
  web: string;
  api: string;
  identity: string;
}>;

export const bitwardenRegions: Readonly<
  Record<BitwardenRegion, BitwardenEndpoints>
> = Object.freeze({
  eu: Object.freeze({
    web: "https://vault.bitwarden.eu",
    api: "https://api.bitwarden.eu",
    identity: "https://identity.bitwarden.eu",
  }),
  us: Object.freeze({
    web: "https://vault.bitwarden.com",
    api: "https://api.bitwarden.com",
    identity: "https://identity.bitwarden.com",
  }),
});

export const isBitwardenRegion = (value: unknown): value is BitwardenRegion =>
  value === "eu" || value === "us";

/** The Bitwarden cloud region whose web vault `server` is, exactly; null for
 * any other server (a Lazurio Vaultwarden). */
export function bitwardenRegionOf(server: string): BitwardenRegion | null {
  const web = server.replace(/\/+$/, "");
  for (const region of ["eu", "us"] as const)
    if (bitwardenRegions[region].web === web) return region;
  return null;
}

/** The address of one request of the vault's identity (`/identity/…`) or API
 * (`/api/…`): under a Vaultwarden's own origin as written, on a Bitwarden
 * cloud region's identity or API host without that prefix. Null for a path
 * of neither on the cloud, which serves nothing else to this core. */
export function vaultEndpoint(server: string, path: string): string | null {
  const region = bitwardenRegionOf(server);
  // String concatenation keeps a path prefix of the server (…/vault).
  if (region === null) return server.replace(/\/+$/, "") + path;
  const endpoints = bitwardenRegions[region];
  if (path.startsWith("/identity/"))
    return endpoints.identity + path.slice("/identity".length);
  if (path.startsWith("/api/"))
    return endpoints.api + path.slice("/api".length);
  return null;
}
