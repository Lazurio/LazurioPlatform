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

## Shaping of the hosted request adapter (2026-09-25, under decision F16)

Decision [F16](decisions.md#f16--one-network-per-organization-every-machine-is-reached-the-same-way-and-the-conglomerate-graph-is-the-truth-agents-move-along)
makes the adapter the one way any Machine of an Organization — hosted VM or physical
laptop — serves its Launchpad behind a gateway. Shaped against the real consumer
(Spectoda `matej`, Machines v0.12.63 gateway) and the mechanism today's production
Launchpad uses; nothing new on the wire.

### Where the gateway stands does not matter to the Launchpad

| Machine | Gateway | What the Launchpad gets |
|---|---|---|
| Hosted VM | On the VM (Caddy + oauth2-proxy delivered by Machines) | External origin, auth endpoint, cookie name, application catalog |
| Work laptop | On the Conglomerate Host, forwarding over the tailnet to the laptop's tailnet address | The same three values and catalog; the Launchpad, T3 and module applications listen on the tailnet address for the gateway |
| Personal laptop / personal VM | None for the laptop; the personal VM keeps its own gateway and its entry | Loopback only on the laptop: no Machine binding, `local` preset, an entry is refused |

The values are part of the **Machine Assignment** (F16): written by Machines as the
handover on a VM, served by the Dashboard after the Account sign-in on a laptop, recorded
in the Folder next to the Machine binding, shown and never edited in the Launchpad. An
entry requires that binding: a work laptop holds one because it is a Machine of the
Organization (kind `workstation`, Owner the Organization, under a preset decided in
the laptop phase, F16); a laptop without a binding is `local` and personal and can
never be given an entry. That is the only classification the adapter relies on. During
the transition on VMs `folder-init` takes them from the resident unit's environment
(`LAZURIO_LAUNCHPAD_EXTERNAL_ORIGIN`, `LAZURIO_LAUNCHPAD_AUTH_CHECK_URL`,
`LAZURIO_LAUNCHPAD_AUTH_COOKIE_NAME`, the catalog) so the first switch needs no new
Machines field; when Machines writes them into the handover, the environment path is
removed. Selecting the adapter by request sniffing (`Host`, forwarded headers) is
rejected: headers are not evidence.

### Admission, as in production today

A state-changing request is trusted only when `Sec-Fetch-Site` is `same-origin`,
`Origin` equals the configured external origin, exactly the named cookie is present, and a
request carrying only that cookie to the configured auth endpoint answers 2xx within 3 s.
A short positive cache (2 minutes, keyed by the cookie's digest) bounds auth-endpoint load
(upstream decision 0157). Denial is a redirect to the gateway's sign-in for top-level
navigations and a 401 for fetches and sockets. No forwarded identity header, no other
cookie, no `Host` is evidence. Admission says "this browser may enter this Machine"; who
the person is comes from the Lazurio Account; what they may touch in a repository comes
from GitHub (F11).

### The adapter

- **Listener.** Loopback always; additionally the Machine's tailnet address when the
  Assignment declares an entry, so a Conglomerate Host gateway can reach a laptop. Never
  a public address.
- **Allowed hosts.** The catalog lists the external origins of the Launchpad and the
  applications; anything else is refused, never routed to a default.
- **Application links** use the catalog's external origins; module ports stay behind
  the gateway.
- **Reconnects.** The Launchpad's own WebSocket re-enters through admission on every
  connect; an expired session closes the socket and the client navigates to sign-in.
- **The update pill and `POST /api/update/apply`** pass the same checks; the updater's
  health socket stays on the filesystem.

### Failure modes

| Failure | Behaviour |
|---|---|
| Auth endpoint unreachable or slow | Deny after the timeout; no cached negative; page says the gateway is unavailable |
| Redirect from the auth endpoint to another origin | Deny; malformed answer |
| Forged `X-Forwarded-User`, `X-Auth-Request-*`, `Authorization` | Ignored; admission decides |
| Cookie header over 16 KiB or the named cookie repeated | Deny |
| Unknown hostname at the listener | Refused, no default application |
| Session expires during a WebSocket | Socket closed with a clean re-login navigation, no token in a URL |
| Laptop offline or off the tailnet | The gateway answers an error; the Dashboard shows the Machine as unreachable |
| Entry recorded without a Machine binding (`local`, a personal laptop), or a hosted Machine started with an entry that is not the recorded one | Refuse to start, naming the value; the recorded entry is the only source |

### Evidence required before the switch

Unit tests for every row above against a fake auth endpoint. Native run on a clean
Machine with a Caddy + oauth2-proxy pair configured like the Machines gateway. Then the
canary: Spectoda `matej`, the resident unit's `ExecStart` switched to the Platform
executable through the selector, `launchpad.matej.spectoda.lazurio.io` opened through
the real gateway, one update through the pill, `update status` → `supervised: true`
on the installer-written unit. The laptop path is qualified afterwards on one work
laptop with a Conglomerate Host route (F16 order).

### Not in scope

Lazurio Account login itself, the team workspace's brokered identity, any gateway or
identity provider shipped by the Platform, T3 Code's own admission (the gateway's), and
the Dashboard API that serves the Assignment.
