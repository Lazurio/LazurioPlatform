# Hosted entry: admission versus identity

Status: **accepted direction of the Principal (2026-09-19); the adapter for the hosted
VM path is implemented (`src/launchpad/hosted-trust.ts`, the entry recorded on the
Machine binding from the handover), verified by unit tests against a fake auth endpoint
and by a [native run behind a stand-in gateway](evidence/hosted-entry-linux-arm64-2026-09-26.md);
the handover field exists in Machines 0.12.93 (not yet written by any Machines role)
and the vendored schema is re-pinned to it
([machine handover](machine-handover.md#the-hosted-entry-decision-f16)); the canary
switch of decision F16 is pending.** Without a recorded entry the Launchpad serves a
loopback origin with a fragment-token session exactly as before. See
[decision F11](decisions.md#f11--hosted-admission-is-not-identity) and
[F16](decisions.md#f16--one-network-per-organization-every-machine-is-reached-the-same-way-and-the-conglomerate-graph-is-the-truth-agents-move-along).

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
handover on a VM (`entry`, finished URLs from the same rendering as the gateway),
served by the Dashboard after the Account sign-in on a laptop, recorded on the
Machine binding in the Folder, shown and never edited in the Launchpad.

**Where every origin comes from.** Only from the recorded entry, one member to one
([projection](machine-handover.md#the-hosted-entry-decision-f16)):

| Value | Handover member | Binding |
|---|---|---|
| Launchpad origin, auth endpoint, cookie name, loopback port | `entry.launchpad.*` | `entry.externalOrigin`, `authCheckUrl`, `authCookieName`, `listenPort` |
| T3 Code origin | `entry.t3code.external_origin` | `entry.t3codeOrigin` |
| A module's origin | `entry.modules.origin_template` | `entry.moduleOriginTemplate`, filled by `moduleOrigin(template, moduleId)` |

The Platform composes nothing but this one substitution: `moduleOrigin` fills the one
`{module}` slot (the whole first label) with `moduleLabel(moduleId)`, and the rule of
that label is the gateway's, textually the same as Machines' `moduleLabel` (a valid
lazurio.module.v1 id only, dash runs collapsed and stripped, at most 63 characters,
reserved names refused), so a link names the hostname the gateway actually serves. No origin is derived from another (not T3 Code's or a
module's from the Launchpad's), from a request or from a hostname convention.

There is one writer and no transition path: no environment of the resident unit is read and no CLI
records an entry; the Machines apply that writes the field also switches the unit.  Selecting the adapter by request sniffing (`Host`, forwarded headers) is
rejected: headers are not evidence.

### Admission, as in production today

A state-changing request (every method but `GET` and `HEAD`, and every request under
`/api/internal/`, which may start an app) is trusted only when `Sec-Fetch-Site` is `same-origin`,
`Origin` equals the configured external origin, exactly the named cookie is present, and a
request carrying only that cookie to the configured auth endpoint answers 2xx within 3 s.
A short positive cache (2 minutes, keyed by the cookie's digest) bounds auth-endpoint load
(upstream decision 0157). Denial is a redirect to the gateway's sign-in for top-level
navigations and a 401 for fetches and sockets. No forwarded identity header, no other
cookie, no `Host` is evidence. Admission says "this browser may enter this Machine"; who
the person is comes from the Lazurio Account; what they may touch in a repository comes
from GitHub (F11).

**A chunked session is the same cookie.** oauth2-proxy splits a session larger than one
cookie into `<name>_0`, `<name>_1`, … (personal VMs carry such sessions) and reassembles
it as its `loadCookie` does (`pkg/sessions/cookie/session_store.go`): the cookie of the
exact name wins when present, otherwise the chunks in index order, concatenated. The
admission reads it the same way: the whole cookie, when present, exactly as above (any
chunks beside it are ignored and not forwarded); otherwise the session is present when
`_0` is, and its chunks must be exactly `_0…_n`, each once and non-empty — a gap or a
repeated index is refused (`cookie-invalid`) rather than cut short. The auth request then
carries those chunks unchanged, in index order and never re-joined, because the gateway's
oauth2-proxy reassembles them itself; the positive cache is keyed by the reassembled
value. The Machines gateway forwards the whole cookie and `_0…_3` (`ingress.ts:35-38,
73-92`). No other name, no fragment token, no relaxed `Host` or same-origin rule.

### The internal route: the gateway's `ensure`

`GET /api/internal/hosted/modules/<id>/ensure` is the one route the gateway itself
calls, never a browser: when a browser opens a module's hostname, the gateway asks the
Launchpad on its loopback port to make the module's default app run and proxies the
browser only on 204 (Machines `workloads/workspace-vm/ingress.ts:113-159`; contract,
statuses and tests in [launchpad-development.md](launchpad-development.md#gateway-ensure)).
Its admission is this one with nothing relaxed:

- **Host.** The entry's Launchpad hostname, as on every route. The gateway keeps the
  browser's `Host` on the Launchpad route and sends the Launchpad's own `Host` on this
  subrequest (launchpad-parity F22 point 3, C.2 step 7). A loopback `Host`, which the
  resident required and today's gateway still sends (`ingress.ts:130`), is refused
  (`host-mismatch`); there is no loopback exception for `/api/internal/*`, so there is
  one admission rule, not two.
- **Same-origin, although it is a `GET`.** The gateway sets `Origin` to the Launchpad's
  external origin and `Sec-Fetch-Site: same-origin`; the Launchpad requires both, as it
  does for every state-changing request, because this `GET` may start an app (the
  resident's rule, `R:launchpad/src/request-trust-lib.mjs:72-83`).
- **The session cookie**, forwarded alone by the gateway and revalidated here as for
  any request. No fragment token, no forwarded identity header.
- **Not reachable from a browser.** The gateway answers 404 for `/api/internal/*` on
  every public hostname before admission (`ingress.ts:54-57`); a process on the
  Machine that reaches the loopback port still needs a valid session cookie.

The browser's `Sec-Fetch-Mode` travels with the subrequest and decides only whether a
stopped app may start (a navigation) or is only reported (a background fetch, a
WebSocket reconnect); it is a lifecycle hint after admission, never an access decision.
A Launchpad without a recorded entry has no such route (404).

### The T3 Code link: Chat

The Launchpad's Chat entry (slice P7, [contract](launchpad-development.md#chat-entry))
opens T3 Code at the recorded `t3codeOrigin`, never at a name derived from the
Launchpad's own hostname. `GET /api/entry` hands the page the entry's public parts
(Launchpad origin, T3 Code origin, module origin rule) read-only, behind this admission;
the auth endpoint, cookie name and port are not among them. On a click the server asks
T3's own CLI (the launcher `t3` on its PATH) for a one-time pairing token and answers
`<t3codeOrigin>/pair#token=…`, the resident's shape; the token rides only in the
fragment of that navigation. The pairing route is a state-changing request under the
same-origin rule above; a Launchpad without an entry has neither the link nor the
route. T3 Code's own admission behind the gateway is unchanged (not in scope below).

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
| Cookie header over 16 KiB, the named cookie repeated, or its chunks with a gap or a repeated index | Deny |
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
