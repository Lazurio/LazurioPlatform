# Workstation vault connection

The workstation consumer is an Organization module whose optional runtime key
enables its scheduling editor. Its ordinary drafts must work while disconnected.

This slice qualifies macOS only. Linux hosted admission remains unchanged.

The local operator explicitly binds a GitHub Organization slug to a selected
HTTPS Vaultwarden service. Each binding generates a fresh technical account;
it never accepts an existing account, browser session or personal password.
The service administrator pre-allows that exact account. Existing own-vault setup
then registers it and creates its own vault and collection using the existing
credential custody. Organization membership in a human vault is not required.

Bindings are non-secret per-user metadata alongside the existing vault custody,
written atomically under a kernel lock. A different Organization never selects
the first binding. A repeated identical connection reuses its identity; changing
the service requires deliberate disconnection first. Disconnecting removes local
admission, not the remote account or vault. Restart reads the binding and the
provider afresh. A running application retains its already supplied key until
stopped, as for hosted runtime secrets.

The CLI selects an Organization explicitly for setup/status. Module startup
selects only its declared Organization. Personalspace and hosted contexts do not
adopt these bindings. The same own-vault secret reader supplies only declared
values to the application process, never preparation or API responses.

Alternatives rejected: borrowing a human account gives the runtime unrelated
credentials; using a hosted handover fabricates a different Machine identity;
putting a provider key in the module or legacy launcher creates a second secret
source. The binding is local configuration within the operator's existing full
computer authority, not a new IAM or a proof of provider rights. Registration
still depends on live service permission.

Qualification includes missing binding, distinct Organizations, malformed or
symlinked state, concurrent configuration, repeated setup, provider refusal,
missing/duplicate/empty keys, and rotation on restart. Existing hosted admission
must remain unchanged. Source tests are not deployed macOS evidence. Deployment
uses the product build, migration and activation contracts; no source checkout
silently becomes the daily installation.
