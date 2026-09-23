# Hosted entry: admission versus identity

Status: **accepted direction of the Principal (2026-09-19); not implemented.** The
Platform Launchpad today serves a loopback origin with a fragment-token session and has
no hosted request adapter. See
[decision F11](decisions.md#f11--hosted-admission-is-not-identity).

Three questions are kept apart. Each has exactly one owner.

| Question | Owner | Platform's part |
| --- | --- | --- |
| May this browser reach the workspace? (**admission**) | The hosted gateway delivered with the Machine | Revalidate the browser session against the gateway's configured auth endpoint |
| Which named person uses the managed service? (**service identity**) | Lazurio Account (OIDC), optional | Log in only when a named person or managed-service enrollment is needed |
| May this operation touch this repository? (**access**) | GitHub, the only access authority | Live check at the operation boundary through the workspace's provider identity |

## Admission

The hosted gateway authenticates. The Launchpad does **not** trust forwarded identity
headers: user, e-mail, group, authorization or product-specific headers arriving with
a request are not evidence, whether or not a proxy is expected to strip them. For each
request that needs admission, the Launchpad revalidates the exact browser session
cookie against the gateway's **configured** HTTPS auth endpoint and accepts only a
positive answer from that endpoint. This is the mechanism today's production Launchpad
uses; Platform preserves it rather than inventing a header contract.

Admission failure, an unreachable auth endpoint, a redirect to an unexpected origin or
a malformed answer all deny. Admission answers "this session may enter this
workspace"; it names no Principal for provider operations and grants no repository
right.

## Lazurio Account

Account login (OIDC) is added when the Launchpad needs a **named person** or
**managed-service enrollment**, for example to show who is connected on a team
workspace or to bind the Environment to a managed Dashboard. It identifies the service
user. It does not admit a browser to a workspace, does not supply repository rights
and does not replace the gateway or GitHub. The `account` field of the Machine
identity stays `null` until the upstream contract defines it.

## Self-hosted

A self-hosted Environment needs neither Lazurio Account nor Dashboard. Local mode stays
independently usable with its loopback protocol. A self-hoster who wants hosted entry
supplies their own **qualified gateway configuration**: an auth endpoint with the same
revalidation semantics, the external origins and the allowed hosts. Platform ships no
gateway and no identity provider.

## Required work: the hosted request adapter

The loopback-origin and fragment-token protocol is correct for a local Launchpad and
wrong as-is behind a gateway. Hosted entry needs an explicit request adapter next to
it, selected by configuration, not by sniffing headers:

- **External origins per application.** Under upstream decision 0146 every hosted
  application is served at the root of its own hostname. Origin and CSRF checks use the
  configured external origin of the Launchpad and of each application, consumed from
  the hosting engine's external-origin and catalog contract; they are never derived
  from a request's `Host` or forwarded headers.
- **Allowed hosts.** An unknown hostname is refused from the declared catalog; it never
  falls through to a default application or the Launchpad.
- **Session revalidation** as described under Admission, with bounded timeouts and no
  caching beyond a short, documented interval.
- **Reconnect behaviour.** WebSocket and long-poll clients re-enter through admission;
  a background reconnect is not an Open and starts no application; an expired session
  ends in a clean re-login navigation, not a silent failure or a token in a URL.
- **Application links.** Links to running applications use their external origins on a
  hosted workspace and the observed loopback listener locally; module-internal ports
  are never exposed.

Required negative evidence: unauthenticated denial, forged identity headers ignored,
unknown host refused, cross-origin state change refused, expired session during a
WebSocket, and the auth endpoint being unavailable.

## What this does not mean

- Gateway headers do not become an ACL, and a gateway group is not a role.
- Account login is not workspace admission and not GitHub access.
- Admission does not attribute Git changes; on a team workspace attribution comes from
  the brokered identity ([decision F2](decisions.md#f2--private-and-team-hosted-workspaces)).
- The adapter is described as required work. None of it exists in this repository yet,
  and no hostname, realm or endpoint of any real deployment belongs in this document.

## Shaping of the hosted request adapter (2026-09-23, proposal for the Principal)

Decision F15 makes this the next Platform work: the Platform Launchpad replaces the
resident Launchpad on hosted Machines, so `launchpad.<vm>.<org>.lazurio.io` and
`launchpad.<login>.lazurio.io` are served by the Platform executable behind the
gateway Machines delivers. What follows shapes that adapter against the real consumer
(Spectoda `matej`, Machines v0.12.63 gateway) and the mechanism today's production
Launchpad uses, so nothing new is invented on the wire.

### What the gateway already gives the Launchpad

The Machines resident role runs today's Launchpad as a systemd user unit with an
environment contract, observed on the first canary:

| Input | Meaning | Adapter use |
|---|---|---|
| `LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN` | The Launchpad's own HTTPS origin, e.g. `https://launchpad.<vm>.<org>.lazurio.io` | The only origin accepted for state-changing requests |
| `LAZURIO_LAUNCHPAD_AUTH_CHECK_URL` | The gateway's auth endpoint, e.g. `https://<vm>.<org>.lazurio.io/oauth2/auth` | Session revalidation target |
| `LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME` | The one session cookie name, e.g. `__Secure-lazurio-workspace` | The only cookie forwarded to the auth endpoint |
| `LAZURIO_HOSTED_DOMAIN`, `LAZURIO_ORGANIZATION_SLUG`, `LAZURIO_TEAM_ID` | Naming inputs of the hosted projection | Not needed: the Folder's Machine binding already names the Machine, Owner and hostnames |
| `LAZURIO_T3CODE_URL` and the gateway catalog (`/etc/lazurio/workspace/catalog*`) | External origins of the applications the gateway routes | Application links and the allowed-host list |
| `--host 127.0.0.1 --port 20000` | The loopback listener the gateway proxies to | Unchanged: the adapter never listens on a public address |

The mechanism of admission is the one in production (`request-trust-lib` of the
legacy Launchpad): a state-changing request is trusted only when `Sec-Fetch-Site` is
`same-origin`, `Origin` equals the configured external origin, exactly the named
cookie is present, and a request carrying only that cookie to the configured auth
endpoint answers 2xx within a bounded timeout. Nothing else is evidence: no forwarded
identity header, no other cookie, no `Host`.

### Variants considered

1. **Hosted mode by environment variables, as today.** The unit passes the three
   values above; the Platform selects the adapter when they are present.
   Cheapest transition (the Machines unit only changes `ExecStart`), but it keeps
   configuration in a unit file the Platform does not own, and the update contract's
   activation restarts a unit whose environment it cannot verify.
2. **Hosted mode declared in the Folder** (`.lazurio/preferences.json` under the
   existing environment-configuration owner, written once by `folder-init` from the
   handover and the gateway contract). The Platform owns its configuration, the
   Launchpad starts with `lazurio launchpad --folder <Folder>` exactly as locally,
   and the installer-written unit (`lazurio install --service systemd-user`) is the
   supervised unit of the update contract, so the foreign-unit case disappears on
   hosted Machines too. Requires the gateway contract (auth endpoint, cookie name,
   external origins, catalog) to reach the Folder: the handover already carries the
   Machine and Owner names; the three admission values are Machine-scoped facts of
   the gateway that Machines can write next to the handover.
3. **Adapter selected by request sniffing** (a `Host` or forwarded header). Rejected
   by the contract above: headers are not evidence.

**Recommendation: variant 2, reached through variant 1 in one release.** The
Platform reads the admission values from the Folder preferences; during the
transition `folder-init` may take them from the resident unit's environment when
present (`LAZURIO_LAUNCHPAD_*`), so the first switch needs no new Machines field. The
gateway values are recorded like the Machine binding: shown, never edited in the
Launchpad. When Machines writes them next to the handover (F15 step 2), the
environment path is removed.

### The adapter

- **Origin.** State-changing requests: `Sec-Fetch-Site: same-origin` and `Origin`
  equal to the configured external origin, else refused. Navigations without those
  headers are read-only page loads that still need admission.
- **Admission.** The named cookie is forwarded alone to the configured auth endpoint;
  a 2xx answer within 3 s admits, anything else denies with a redirect to the
  gateway's sign-in only for top-level navigations and a 401 for fetches and
  sockets. A short positive cache (2 minutes, keyed by the cookie's digest) bounds
  auth-endpoint load, matching upstream decision 0157's refresh interval.
- **Allowed hosts.** The catalog lists the application hostnames; a request whose
  configured external origin is not the Launchpad's is refused, never routed.
- **Application links.** Rendered from the catalog's external origins; module ports
  stay loopback.
- **Reconnects.** The Launchpad's own WebSocket re-enters through admission on every
  connect; an expired session closes the socket and the client navigates to sign-in.
- **The update pill and `POST /api/update/apply`** are state-changing requests like
  any other and pass the same checks; the updater's health socket stays on the
  filesystem.

### Failure modes

| Failure | Behaviour |
|---|---|
| Auth endpoint unreachable or slow | Deny after the timeout; no cached negative; page shows "workspace gateway unavailable" |
| Redirect from the auth endpoint to another origin | Deny; treated as a malformed answer |
| Forged `X-Forwarded-User`, `X-Auth-Request-*`, `Authorization` | Ignored; admission decides |
| Cookie header over 16 KiB or the named cookie repeated | Deny |
| Unknown hostname at the loopback listener | Refused, no default application |
| Session expires during a WebSocket | Socket closed with a clean re-login navigation, no token in a URL |
| Hosted values present in local mode or absent in hosted mode | Refuse to start with the exact variable or preference named |

### Evidence required before the switch

Unit tests for every row above against a fake auth endpoint. Native run on a clean
Machine with a Caddy + oauth2-proxy pair configured like the Machines gateway
(admission, forged headers, unknown host, expired session, endpoint down). Then the
canary: Spectoda `matej`, where the resident unit's `ExecStart` is switched to the
Platform executable through the selector, `launchpad.matej.spectoda.lazurio.io` is
opened through the real gateway, the pill updates the Platform once, and
`update status` reports `supervised: true` on the installer-written unit.

### Not in scope

Lazurio Account login, the team workspace's brokered identity, any gateway or identity
provider shipped by the Platform, and T3 Code's own admission (it keeps the gateway's).
