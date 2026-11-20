// The units of the brain as the interim installer writes them (buddy-install.sh
// 2026-10-30.7, GBrain v0.60.315.0-lazurio.1), byte for byte as they are on
// a Personal Environment it installed. They hold no secret: the server reads
// its owner credential from its 0600 file at start.

export const interimServerUnit = `[Unit]
Description=gbrain MCP memory server (Streamable HTTP, loopback 127.0.0.1:3131)
Documentation=https://github.com/Lazurio/gbrain/blob/v0.60.315.0-lazurio.1/docs/mcp/DEPLOY.md
# One server holds the PGLite brain. Every client (Executor, Hermes) connects
# here with its own bearer token; nothing spawns a stdio gbrain next to it.
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
Environment=GBRAIN_HOME=%h
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=%h
# Owner bootstrap credential: read from its 0600 file at start, never stored in this unit.
ExecStartPre=/usr/bin/test -r %h/.gbrain/serve/admin-token
ExecStart=/bin/bash -c 'GBRAIN_ADMIN_BOOTSTRAP_TOKEN="$$(cat %h/.gbrain/serve/admin-token)" exec %h/.bun/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url http://127.0.0.1:3131'
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;

export const interimRefreshService = `[Unit]
Description=Lazurio: bring Buddy's gbrain vault up to date from GitHub (DEV-6676)
Documentation=https://github.com/Lazurio/gbrain/blob/v0.60.315.0-lazurio.1/docs/guides/live-sync.md
# The serve owns the vault (managed persistence): it commits and pushes Buddy's own page writes
# (Git durability) and indexes every new commit (sync.on_commit). This only fast-forwards the
# checkout to what other writers pushed, like the MacBook's 15-minute job did; it refuses, and
# changes nothing, while an uncommitted page overlaps the incoming change.
After=gbrain.service
Requires=gbrain.service

[Service]
Type=oneshot
Environment=GBRAIN_HOME=%h
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=%h
ExecStart=%h/.bun/bin/gbrain sources refresh default --json
`;

export const interimRefreshTimer = `[Unit]
Description=Lazurio: refresh Buddy's gbrain vault from GitHub every 15 minutes (DEV-6676)

[Timer]
OnBootSec=5min
OnUnitActiveSec=15min
RandomizedDelaySec=60
Persistent=true

[Install]
WantedBy=timers.target
`;
