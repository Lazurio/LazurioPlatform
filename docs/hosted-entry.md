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
