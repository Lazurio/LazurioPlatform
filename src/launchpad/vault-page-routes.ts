import { stateFields } from "../folder/state-fields";
import type { VaultEnvironmentKind } from "../vault/context";
import {
  type VaultHost,
  type VaultPhase,
  type VaultStatus,
  vaultStatus,
} from "../vault/flow";
import {
  personAddress,
  type VaultAudience,
  type VaultMembership,
  vaultAudience,
  vaultMembership,
  vaultSignIn,
} from "../vault/members";
import {
  type AdmittedPerson,
  isAccountSubject,
  isLazurioUsername,
} from "./hosted-trust";
import { BodyTooLarge, readJsonBody } from "./json-body";

// Settings → Vault, Nastavení → Trezor (root decision 0198 points 2, 3 and
// 5; DEV-6631 tasks 648 and 638b): behind the admission of every `/api/*`
// route (the local token and same origin, or the gateway's session and same
// origin for a write), over the vault's one core:
//
//   GET  /api/vault             the page: the vault's status as
//                               `lazurio vault status` reads it (local, no
//                               value), the step of a setup that runs, and
//                               the kind of Environment
//   POST /api/vault/membership  {}: where the admitted person stands in the
//                               vault, after the Environment adds them and,
//                               on a work Environment, after the Správci of
//                               an earlier assignment left; with `signIn`
//                               while they have no account yet, and with
//                               `address`, their own address in a Lazurio
//                               Vaultwarden, for the Bitwarden steps of the
//                               page (F53's addendum of 2026-10-16)
//
// The person is whom the gateway's own answer to this request's admission
// named, by the subject and the Lazurio username (hosted-trust.ts), passed in
// by the server, never anything the request carries. The page never lists
// items or shows a value.

export const vaultPageRoutePaths = Object.freeze({
  page: "/api/vault",
  membership: "/api/vault/membership",
});

/** `GET /api/vault`. */
export type VaultPage = Readonly<{
  kind: "vault-page";
  status: VaultStatus;
  /** The step of the setup that runs now, or null. */
  setup: VaultPhase | null;
  /** The kind of Environment; null where it has no vault here. */
  environment: VaultEnvironmentKind | null;
}>;

/** `POST /api/vault/membership`: the person's membership, and while they
 * have no account (or no master password) yet whether the network's vault
 * takes a sign-in with the Lazurio account, which creates one. `address` is
 * the admitted person's own address in the Environment's Lazurio Vaultwarden
 * (`<Lazurio username>@account.lazurio.ai`), present only where the gateway's
 * answer named them with a Lazurio username. */
export type VaultPageMembership = (
  | (Extract<VaultMembership, { kind: "vault-member" }> &
      Readonly<{ signIn?: boolean }>)
  | Extract<VaultMembership, { kind: "vault-member-unknown" }>
) &
  Readonly<{ address?: string }>;

/** How long the vault's answer whether it takes Lazurio sign-in is kept. */
const signInMs = 60_000;

export function createVaultPageRoutes(
  input: Readonly<{
    host: () => VaultHost;
    /** The step of the vault's setup that runs now (vault-routes.ts). */
    setup: () => VaultPhase | null;
    headers: Readonly<Record<string, string>>;
    now?: () => number;
  }>,
) {
  const now = input.now ?? Date.now;
  const response = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: input.headers });
  // One Launchpad serves one Environment, so one vault: one answer, kept a
  // minute.
  let signIn: Readonly<{ until: number; value: boolean }> | null = null;
  const takesSignIn = async (host: VaultHost): Promise<boolean> => {
    if (signIn !== null && signIn.until > now()) return signIn.value;
    const value = await vaultSignIn(host);
    signIn = { until: now() + signInMs, value };
    return value;
  };

  async function page(): Promise<VaultPage> {
    const host = input.host();
    // The context once: the status and the kind say the same Environment.
    const context = await host.context();
    const status = await vaultStatus({ ...host, context: async () => context });
    return {
      kind: "vault-page",
      status,
      setup: input.setup(),
      environment:
        context.kind === "unsupported"
          ? null
          : context.kind === "needs-connection"
            ? "personal"
            : context.environment,
    };
  }

  async function membership(
    person: AdmittedPerson,
  ): Promise<VaultPageMembership> {
    const host = input.host();
    const answer = await vaultMembership(host, person);
    const address = await addressOf(host, person);
    const own = address === null ? {} : { address };
    if (
      answer.kind === "vault-member" &&
      (answer.state === "no-account" || answer.state === "awaiting-password")
    )
      return { ...answer, signIn: await takesSignIn(host), ...own };
    return { ...answer, ...own };
  }

  /** The admitted person's own address, which the page's Bitwarden steps
   * offer to copy: in a Lazurio Vaultwarden (an Environment's own one, or a
   * 0197 pilot's network vault) the person's account is
   * `<Lazurio username>@account.lazurio.ai`, built from the username of the
   * gateway's own answer alone (root decision 0203 points 4 and 5), never
   * from GitHub or a header of the request. None for a personal
   * Environment's own Bitwarden, where the person signs in with their own
   * account, none without a vault, and none where the answer named nobody
   * or no username. It goes only to that person, in their own answer. */
  async function addressOf(
    host: VaultHost,
    person: AdmittedPerson,
  ): Promise<string | null> {
    if (
      !isAccountSubject(person.subject) ||
      !isLazurioUsername(person.username)
    )
      return null;
    const context = await host.context();
    const lazurio =
      context.kind === "pilot" ||
      (context.kind === "own" && context.bitwarden === undefined);
    return lazurio ? personAddress(person.username) : null;
  }

  return Object.freeze({
    handles: (path: string) =>
      path === vaultPageRoutePaths.page ||
      path === vaultPageRoutePaths.membership,
    /** `person`: whom the gateway's answer named for this request, or
     * nobody (a workstation, or a gateway that named nobody). */
    async handle(
      request: Request,
      url: URL,
      person: AdmittedPerson,
    ): Promise<Response> {
      if (url.pathname === vaultPageRoutePaths.page) {
        if (request.method !== "GET")
          return response({ error: "method-not-allowed" }, 405);
        if ([...url.searchParams.keys()].length > 0)
          return response({ error: "invalid-query" }, 400);
        return response(await page());
      }
      if (request.method !== "POST")
        return response({ error: "method-not-allowed" }, 405);
      if (request.headers.get("content-type") !== "application/json")
        return response({ error: "invalid-content-type" }, 415);
      try {
        stateFields(await readJsonBody(request), []);
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return response({ error: "body-too-large" }, 413);
        return response({ error: "invalid-request" }, 400);
      }
      return response(await membership(person));
    },
    /** The audience alone (members.ts `vaultAudience`): the Launchpad's
     * start and its periodic look ask it. */
    audience(): Promise<VaultAudience> {
      return vaultAudience(input.host());
    },
  });
}
