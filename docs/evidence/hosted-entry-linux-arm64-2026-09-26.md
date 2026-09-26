# The hosted request adapter behind a stand-in gateway — linux-arm64, 2026-09-26

Evidence for [hosted entry](../hosted-entry.md), section *Evidence required before the
switch*, second item: the native run of the adapter on a clean Machine behind a gateway
configured like the Machines gateway. The first item (unit tests against a fake auth
endpoint) is `tests/launchpad-hosted-trust.test.ts` and `tests/launchpad-hosted.test.ts`;
the third (the Spectoda canary) follows the Machines handover field of decision F16.

## Setup

Fresh disposable Ubuntu 24.04.4 ARM64 clone (systemd 255), the branch executable
`0.1.5-hosted.2` (commit `91f83c6c`) installed with `install --base`, the Folder adopted
from a workspace handover (`hosted-organization-personal`, derived). The Machines field
`entry.launchpad` does not exist yet, so the entry was written on the Machine binding in
`.lazurio/preferences.json` exactly as the handover projection will record it
(`externalOrigin https://launchpad.workspace.example.lazurio.io`, `authCheckUrl
https://workspace.example.lazurio.io/oauth2/auth`, `authCookieName
__Secure-lazurio-workspace`, `listenPort 20000`). This qualifies the adapter, not the
handover path. Stand-in gateway on the same Machine: Caddy 2.6.2 with its internal CA
(`local_certs`), `forward_auth` to an oauth2-proxy-like endpoint on `127.0.0.1:4180`
(`/oauth2/auth` answers 202 for the cookie value `valid`, 401 otherwise), `reverse_proxy
127.0.0.1:20000`; the two hostnames resolved to loopback; the stand-in CA trusted by the
Launchpad process for this run only (`NODE_EXTRA_CA_CERTS`).

## Transcript

```text
$ lazurio launchpad --folder ~/Lazurio --base ~/.local/share/lazurio
{"url":"https://launchpad.workspace.example.lazurio.io/","scope":"hosted-entry"}
LISTEN 127.0.0.1:20000 users:(("lazurio",pid=1507))

5. anonymous browser through the gateway            → 401 (denied by the gateway before the Launchpad)
6. admitted browser through the gateway: GET /      → 200, the shell
   POST /api/profile, Origin + Sec-Fetch-Site        → 200 {"revision":1,"preset":{…},"machine":{…}}
7. straight at the loopback port, bypassing the gateway:
   X-Forwarded-User: admin, X-Auth-Request-User      → 401 {"error":"denied","reason":"cookie-missing"}
   Cookie: __Secure-lazurio-workspace=forged          → 401 {"error":"denied","reason":"auth-denied"}
8. Host: other.workspace.example.lazurio.io, valid cookie → 401 {"error":"denied","reason":"host-mismatch"}
9. POST with a valid cookie, Origin https://evil.example, Sec-Fetch-Site cross-site
                                                     → 401 {"error":"denied","reason":"origin-mismatch"}
10. a cookie value the endpoint no longer accepts    → 401 {"error":"denied","reason":"auth-denied"}
11. auth endpoint stopped; a never-seen cookie value → 401 {"error":"denied","reason":"auth-denied"}
12. auth endpoint still down; the cookie admitted at step 6 → 200 (within its 2-minute positive cache)
13. lazurio machine folder-init                      → already-adopted, revision 1 (serving wrote nothing)
```

## Observations

- Every denial is the adapter's own, with its reason, regardless of what the gateway
  forwarded; nothing of the Launchpad — not the shell — answered an unadmitted request.
- With the gateway in the path of the auth endpoint, an endpoint outage reaches the
  Launchpad as the gateway's 502 and is reported as `auth-denied`, not
  `auth-unavailable`; the outcome is the same denial with no cached negative. The
  positive cache is bounded exactly as documented: a session admitted before the outage
  keeps working for at most two minutes.
- The stand-in gateway answered an anonymous browser with 401 instead of the 302 to
  sign-in a Machines gateway produces; a Caddyfile detail of the stand-in, not the
  adapter's behaviour.
- Not covered here: the shell in a real browser (WebSocket reconnect, the 401 → re-entry
  navigation), the Launchpad pill through the gateway, and the handover path itself
  (`folder-refresh` recording the entry) — the canary covers them.
