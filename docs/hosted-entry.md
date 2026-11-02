# Hosted entry: admission versus identity

> **Approved target update, 2026-10-06 (root 0192):** [Account and Environment access](environment-access.md) refines organizational admission: Lazurio membership and full/app grants, optional GitHub for visitors, Admin approval of the exact Headscale device, and delegated same-Organization sharing. Conflicting older target statements below are superseded; implemented behavior and evidence remain baseline only until a qualified migration. No runtime changes in this documentation update.

Status: **accepted direction of Matěj (2026-09-19); the adapter for the hosted
VM path is implemented (`src/launchpad/hosted-trust.ts`, the entry recorded on the
Machine binding from the handover), verified by unit tests against a fake auth endpoint
and by a [native run behind a stand-in gateway](evidence/hosted-entry-linux-arm64-2026-09-26.md);
the handover field exists in Machines 0.12.93 (not yet written by any released
Machines role; Machines #248, a Draft, writes it)
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
| Which named user uses the managed service? (**service identity**) | Lazurio Account (OIDC), optional | Log in only when a named user or managed-service enrollment is needed |
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
workspace"; it names no user for provider operations and grants no repository
right.

**The admitted session's user** ([F11's amendments of 2026-10-14 and
2026-10-16](decisions.md#f11--hosted-admission-is-not-identity)). The endpoint's own
answer to that revalidation names the session's user in two headers. The Environment
gateway's oauth2-proxy runs with `set_xauthrequest = true`: `X-Auth-Request-User`
carries its user claim, the identity provider's `sub`, the Lazurio account's immutable
id; `X-Auth-Request-Preferred-Username` carries the ID token's `preferred_username`,
which for the gateway's client is the Keycloak username, the user's Lazurio username
(root decision 0203 point 4). Caddy strips only `X-Auth-Request-Access-Token` from the
bare hostname's `/oauth2/*`. The Launchpad accepts only a lowercase UUID as the
subject, and as the username only one value of 3 to 39 lowercase letters and digits
with single dashes between them, never shaped like a UUID and never a service
account's (`service-account-…`); anything else is no username. It keeps both with the
cached admission. A header of the request itself still names nobody: the Machines
gateway removes every `X-Auth-Request-*` header from the browser's requests, and the
Launchpad never reads one anyway. Their one use is the membership of the Environment's own
vault, whose access is access to the Environment (root decision 0198 point 2, [F53's
addendum of
2026-10-14](decisions.md#f53-addendum-of-2026-10-14-nastavení--trezor-and-the-správci)
and [its amendment of
2026-10-16](decisions.md#f53-amendment-of-2026-10-16-the-address-of-the-lazurio-username)):
the username is the user's address there, `<username>@account.lazurio.ai` (root
decision 0203 point 5), and it is never derived from GitHub or from the subject. A
session signed in before the user's Keycloak username became their Lazurio username
still carries the old value, the account's id, which is no username, until it is
signed in again.

## Lazurio Account

Account login (OIDC) is added when the Launchpad needs a **named user** or
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
| Lazurio MausBot origin and loopback port (optional) | `entry.mausbot.*` | `entry.mausbotOrigin`, `mausbotListenPort` |
| Environment browser view origin and loopback port (optional, F38) | `entry.browser.*` | `entry.browserOrigin`, `browserListenPort` |
| Buddy's origin (optional, only a personal VM, root decision 0210) | `entry.buddy.external_origin` | `entry.buddyOrigin` |
| A module's origin | `entry.modules.origin_template` | `entry.moduleOriginTemplate`, filled by `moduleOrigin(template, moduleId)` |

The Platform composes nothing but this one substitution: `moduleOrigin` fills the one
`{module}` slot (the whole first label) with `moduleLabel(moduleId)`, and the rule of
that label is the gateway's, textually the same as Machines' `moduleLabel` (a valid
lazurio.module.v1 id only, dash runs collapsed and stripped, at most 63 characters,
reserved names refused), so a link names the hostname the gateway actually serves. No origin is derived from another (not T3 Code's or a
module's from the Launchpad's), from a request or from a hostname convention.

There is one writer and no transition path: no environment of the resident unit is
read and no CLI records an entry. Writing the entry is not switching the unit: the
Machines role writes `entry` to every Machine whose pinned Platform reads it
(Machines' "Entry" gate, Machines #248), also where the resident Launchpad still holds
the port, and the switch of the unit is a separate declaration of the Machines apply
([M2](launchpad-parity.md#c2-the-apply-in-order)). The Platform records the entry
whenever the handover carries it (declaration, not identity;
[machine handover](machine-handover.md#the-hosted-entry-decision-f16)). Selecting the
adapter by request sniffing (`Host`, forwarded headers) is rejected: headers are not
evidence.

### Admission, as in production today

A state-changing request (every method but `GET` and `HEAD`, and every request under
`/api/internal/`, which may start an app) is trusted only when `Sec-Fetch-Site` is `same-origin`,
`Origin` equals the configured external origin, exactly the named cookie is present, and a
request carrying only that cookie to the configured auth endpoint answers 2xx within 3 s.
A short positive cache (2 minutes, keyed by the cookie's digest) bounds auth-endpoint load
(upstream decision 0157). Denial is a redirect to the gateway's sign-in for top-level
navigations and a 401 for fetches and sockets. No forwarded identity header, no other
cookie, no `Host` is evidence. Admission says "this browser may enter this Machine"; who
the user is comes from the Lazurio Account; what they may touch in a repository comes
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
the auth endpoint, cookie name and port are not among them. A click follows that
origin as it is and asks the Launchpad for nothing on the way: T3 Code pairs the browser
itself (below). Until the
[addendum of 2026-10-31](decisions.md#f36-addendum-of-2026-10-31-the-click-into-chat-and-automate-no-longer-pairs)
the click asked the server for a one-time pairing token (`POST /api/chat/pair`) and
followed `<t3codeOrigin>/pair#token=…`, the resident's shape; that route is gone. A
Launchpad without an entry has no link. T3 Code's own admission behind the gateway is
unchanged (not in scope below). Lazurio MausBot is entered the same way when the entry
records it ([contract](launchpad-development.md#lazurio-mausbot-entry)): `mausbotOrigin`
is in the public parts, the loopback port is not, and a click follows the plain origin,
where MausBot pairs itself as T3 Code does (since 2026-10-22, below); the click's
`POST /api/mausbot/pair` is gone too.
The Environment browser's users' view ([F38](decisions.md#f38--the-environment-browser-of-a-remote-environment-one-chromium-a-window-per-thread-a-view-behind-the-gateway),
[F39](decisions.md#f39--the-peoples-view-of-the-environment-browser-one-tab-of-a-person-is-one-remote-tab))
follows the same pattern: `browserOrigin` is in the public parts, the loopback port is
not. `GET /.lazurio/browser.json` and the hand-over `GET /.lazurio/browser` answer, behind
this admission and on the forks' origins too (the gateway forwards `/.lazurio/*` to the
Launchpad), the view's address of a session's tab, `<browserOrigin>/t/<target id>`, or
`<browserOrigin>/` for a new tab without a session. No address carries a token: the
view's only admission is the gateway's. Asked for a session that has no window yet,
they open that session's window first, so a T3 thread's panel shows the thread's own tab
(F38, addendum 2026-10-06).

**T3 Code pairs itself (decision of the Organization Admin, 2026-10-17,
[contract](launchpad-development.md#chat-entry)).** The Environment pairs every browser
this admission lets in, whichever way it enters; since the addendum of 2026-10-31 it is
the only way a browser is paired. T3 Code's
web client asks for `GET /.lazurio/chat/pairing` on its own origin whenever it has no
session, or only a legacy one. The gateway forwards the request as it forwards every
`/.lazurio/*` read of the forks' origins (Machines `workloads/workspace-vm/ingress.ts`,
`shellRoute`):

- only `GET` and `HEAD`, after the gateway's own admission;
- with the Launchpad's own `Host`;
- with only the session cookie (whole or chunked), and without `Authorization`, `DPoP`
  or an upgrade.

The browser's other headers pass as they are, its Fetch Metadata among them; it sends
no `Origin` with a same-origin `GET`. So this admission applies unchanged (Host
equality, session revalidation), and the user it names labels the pairing. The route
then answers only a page's own script fetch: `Sec-Fetch-Site: same-origin`,
`Sec-Fetch-Mode` `cors` or `same-origin`, no prefetch. `same-origin` is relative to the
page that fetches, T3 Code's or the Launchpad's own origin, so another site or a
sibling hostname gets nothing. The gateway forwards the namespace on MausBot's origin
too, so a MausBot page would pass the same rule: the same admitted user, in a
first-party app of the same Environment. The route mints T3's operator pairing where
T3 Code offers it, the standard one on a public
Environment. It answers `{"kind":"chat-pairing","credential":"…","expiresAt":"…"}`
with `Cache-Control: no-store`; the credential rides only in that response body, which
the script of the same origin reads, never in a URL. It sits behind the
whole-Environment admission: an app-only session
([root 0192](environment-access.md#platform-consumer-qualification)) must be refused
here. T3 Code's own pairing page and its sessions stay T3's.

**Buddy's own T3 Code pairs itself the same way ([F61's addendum of
2026-10-22](decisions.md#f61-addendum-of-2026-10-22-the-pairing-on-buddys-origin-his-own-runtime-a-final-wake-refusal)).**
On an Osobní Prostředí whose entry records `buddyOrigin`, the gateway forwards the same
path of Buddy's origin here, again with the Launchpad's own `Host`. What tells the two
apart is the host the browser addressed, which the gateway's Caddy names in
`X-Forwarded-Host` and its scheme in `X-Forwarded-Proto`. Caddy sets both from the
request itself and never takes a browser's value, since the gateway trusts no proxy in
front of it; Machines already count on every request behind the gateway carrying them
(Lazurio MausBot, Machines `workloads/workspace-vm/README.md`). Only a request whose two
values are exactly the recorded `buddyOrigin`'s is paired with Buddy's T3 Code; every
other request pairs the Chat as before. This is not the request sniffing rejected
above: no origin, admission or adapter comes from a header. The recorded entry names
the origin, and the header only says which recorded origin a request came through.
After admission it chooses which of the admitted person's two T3 Codes the credential
is for, and a shell on the Machine can mint either.

**MausBot pairs itself the same way (addendum of 2026-10-22,
[contract](launchpad-development.md#lazurio-mausbot-entry)).** MausBot's web client asks
for `GET /.lazurio/mausbot/pairing` on its own origin whenever it has no session. The
gateway forwards it exactly as above, so nothing of the gateway changes. The route has the
same rule (only a page's own script fetch, behind the whole-Environment admission like the
chat self-pairing) and answers `{"kind":"mausbot-pairing","code":"XXXX-XXXX-XXXX"}`
with `Cache-Control: no-store`. The code rides only in that response body, and MausBot's
client redeems it with MausBot's own API. MausBot's pairing form and its sessions stay
MausBot's.

### Files links (decision F35)

`<Launchpad origin>/files/<path>`, the link `lazurio files link` prints, is an ordinary
Launchpad route behind this admission
([F35](decisions.md#f35--files-the-operators-documents-through-the-launchpad)). A `GET`
that carries the gateway's session cookie downloads the file; without the session it is
refused like any other request, and the gateway sends a browser to its sign-in first, so
a link opened from a chat signs in and then downloads. The link carries no token: there
is no public, anonymous or time-limited link, and it opens only for someone who may sign
in to the Environment. An upload (`POST /api/files/upload`) is a state-changing request
under the same-origin rule above. The routes read and write only the Documents folder of
the account the Launchpad runs as; a Launchpad without an entry serves the same page
locally, and its downloads ride the session token instead.

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
| Laptop offline or off the tailnet | The browser cannot resolve the address; after a first visit the offline guide's worker (decision F41) shows how to turn on Tailscale and choose the tailnet; the Dashboard shows the Machine as unreachable |
| Entry recorded without a Machine binding (`local`, a personal laptop), or a hosted Machine started with an entry that is not the recorded one | Refuse to start, naming the value; the recorded entry is the only source |

### Evidence required before the switch

Unit tests for every row above against a fake auth endpoint. Native run on a clean
Machine with a Caddy + oauth2-proxy pair configured like the Machines gateway. Then the
canary: one work VM of the pilot Organization switched by the Machines switch apply
([M2](launchpad-parity.md#c2-the-apply-in-order), which replaces the resident unit
with the installer-written one), `launchpad.<vm>.<org>.lazurio.io` opened through the
real gateway, one update through the pill, `update status` → `supervised: true` on the
installer-written unit. The laptop path is qualified afterwards on one work
laptop with a Conglomerate Host route (F16 order).

### Not in scope

Lazurio Account login itself, the team workspace's brokered identity, any gateway or
identity provider shipped by the Platform, T3 Code's own admission (the gateway's), and
the Dashboard API that serves the Assignment.
