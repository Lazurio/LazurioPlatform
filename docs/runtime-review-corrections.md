# Runtime review corrections

Follow-up to the review of `9ce1e1f369b8b974d04f883d8e5b762cf733c734`.
This is development evidence, not a release or completed production binding.

- A retained application handle whose app/guard exited or whose stop was requested
  now refuses another start with `application-cleanup-required`. Only confirmed
  `group-stopped` releases ownership. API and compiled CLI regression tests verify
  the same result; CLI domain refusal is exit 2. The UI presents cleanup guidance
  rather than successful start. A live retained process can still be already managed;
  that result does not establish health or functional readiness.
- Install authority snapshots include presence and bytes of `.npmrc` and
  `bunfig.toml` between the selected checkout root and dependency owner. Explicitly
  supplied HOME/XDG configuration roots additionally cover `.npmrc` and
  `.bunfig.toml`, including directory identity. The execution environment must equal
  the captured data-only environment. An authority captured without an environment
  remains usable for inspection, but cannot execute installation. Custom npm
  user/global configuration path overrides are not yet qualified and are refused.
  No ambient environment lookup, configuration copying, secret logging or new
  credential store is introduced. Callers must authorize and maintain custody of
  the supplied roots; repeated hashes are not an atomic filesystem transaction or
  protection from arbitrary hostile mutation between observations.
- The browser link predicate accepts exactly `localhost` alongside numeric loopback
  hosts, consistent with the existing module lease contract. A real fixture test
  follows a localhost lease through lifecycle health/entrypoint and UI presentation.
  Lookalike external hostnames remain refused; remote access still requires its own
  qualified route.

Tests cover configuration appearance, modification and removal; environment
replacement before execution; actual install hooks changing local/global configuration;
process-group cleanup and preservation of the changed files. Synthetic fixtures only.
Chromium consumer journeys passed in Czech and English after these changes. Earlier
real-module/VM evidence is tied to earlier commits and is not automatically upgraded
by this correction. Renew exact-head review and relevant integration qualification.
