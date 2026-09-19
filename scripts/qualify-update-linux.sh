#!/usr/bin/env bash
# Native qualification of the product update on a REAL Linux with a REAL systemd
# user manager (docs/update.md "Evidence required before any Machine depends on
# this"). Runs ON the Linux Machine, as the user whose user manager is used:
#
#   bun run scripts/qualify-update-linux.ts build --target linux-arm64 --out <absent dir>
#   # copy <dir> to the Machine by whatever means it offers, then, there:
#   bash <dir>/qualify-update-linux.sh <dir> [<absent work directory>]
#
# The bundle holds three REAL product executables (src/cli.ts; versions 1.0.0,
# 1.1.0, 1.2.0), the signed loopback fixture repository server and this script.
# Nothing else is needed on the Machine: no Bun, no curl, no jq.
#
# Everything lives under the work directory with its OWN HOME, so the user's
# real install base and Folder are never touched. The only things outside it
# are what `lazurio install --service` really writes — one uniquely named unit
# in the user's systemd directory, enabled — plus this harness's drop-in next
# to it, and the transient worker units. All of it is disabled and removed at
# the end. The user manager must outlive the login session that starts this
# script when it is run over several sessions: `loginctl enable-linger` is the
# operator's decision and is NOT made here.
#
# Exit status 0 only when every journey passed. KEEP=1 keeps the work directory.
set -uo pipefail
# The product refuses group-writable Folder parents; Ubuntu's default umask is 002.
umask 077

BUNDLE=$(cd "${1:?bundle directory}" && pwd -P)
WORK=${2:-$HOME/update-qual-$(date +%Y%m%d-%H%M%S)}
# shellcheck disable=SC1091
. "$BUNDLE/bundle.env" # COMMIT, TARGET, TOOLCHAIN
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
mkdir -p "$WORK/home" "$WORK/state" || exit 2
WORK=$(cd "$WORK" && pwd -P)
QHOME=$WORK/home
BASE=$QHOME/.local/share/lazurio
FOLDER=$QHOME/Lazurio
UNIT=lazurio-qualify-$$.service
# Where the REAL user manager reads units: the installer must write there.
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
UNIT_FILE=$CONFIG_HOME/systemd/user/$UNIT
L=$BASE/bin/lazurio
FAILED=0
FIXTURE_PID=

say() { printf '%s\n' "$*"; }
step() { say ""; say "== $* =="; STEP_STARTED=$(date +%s%N); }
took() { local ms=$((($(date +%s%N) - STEP_STARTED) / 1000000)); say "   took $((ms / 1000)).$(((ms % 1000) / 100)) s"; }
pass() { say "   PASS  $*"; }
fail() { say "   FAIL  $*"; FAILED=$((FAILED + 1)); }
expect() { # expect <description> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1: $2"; else fail "$1: got '$2', expected '$3'"; fi
}
# FIRST string, number or boolean value of a JSON member; enough for the flat
# documents read here.
field() { grep -o "\"$1\": *\"\{0,1\}[^\",}]*" | head -n 1 | sed 's/^[^:]*: *"\{0,1\}//'; }
wait_for() { # wait_for <seconds> <command…>
  local deadline=$(($(date +%s) + $1)); shift
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 0.2
  done
}
# The product, run the way a person's shell would: through the selector.
product() { env -i HOME="$QHOME" XDG_CONFIG_HOME="$CONFIG_HOME" PATH="$PATH" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  ${DBUS_SESSION_BUS_ADDRESS:+DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"} "$@"; }
lz() { product "$L" "$@"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
name_of() { echo "$1+$(sha "$BUNDLE/lazurio-$1" | cut -c1-16)"; }
selected() { readlink "$L" | cut -d/ -f3; }
unit_pid() { systemctl --user show "$UNIT" -p MainPID --value; }
ready_field() { field "$1" <"$BASE/update/launchpad-readiness.json" 2>/dev/null; }
worker_unit() { systemctl --user list-units --all --plain --no-legend 'lazurio-update-*' | awk '{print $1}' | head -n 1; }
record_phase() { field phase <"$BASE/update/activation.json" 2>/dev/null; }
launchpad_on() { # launchpad_on <version>: a live instance announcing that version's digest
  [ "$(systemctl --user is-active "$UNIT")" = active ] &&
    [ "$(ready_field artifactSha256)" = "$(sha "$BUNDLE/lazurio-$1")" ] &&
    [ "$(ready_field pid)" = "$(unit_pid)" ]
}
ORIGINS=()
# No --service flag anywhere below: `lazurio install` recorded the service.

cleanup() {
  systemctl --user stop 'lazurio-update-*' >/dev/null 2>&1
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1
  rm -rf "$UNIT_FILE" "$UNIT_FILE.d"
  systemctl --user daemon-reload >/dev/null 2>&1
  systemctl --user reset-failed >/dev/null 2>&1
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null
  if [ "${KEEP:-0}" = 1 ]; then say "kept $WORK"; else chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"; fi
  # A disposable Machine is often powered off hard right after this script:
  # without a sync the removals above are not on disk and come back.
  sync
}
trap cleanup EXIT

say "target $TARGET, commit $COMMIT, $(systemctl --version | head -n 1)"
say "linger: $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"

step "a. signed fixture repository on loopback, served from this Machine"
"$BUNDLE/update-fixture-server" serve --state "$WORK/state" --target "$TARGET" --commit "$COMMIT" \
  --artifact "1.0.0=$BUNDLE/lazurio-1.0.0" --artifact "1.1.0=$BUNDLE/lazurio-1.1.0" \
  --artifact "1.2.0=$BUNDLE/lazurio-1.2.0" >"$WORK/fixture.log" 2>&1 &
FIXTURE_PID=$!
wait_for 30 test -s "$WORK/state/fixture.env" || { fail "fixture did not start"; exit 1; }
# shellcheck disable=SC1091
. "$WORK/state/fixture.env" # METADATA_URL, TARGET_URL, CONTROL_URL
ORIGINS=(--metadata-url "$METADATA_URL" --target-url "$TARGET_URL" --channel stable --loopback-fixture --json)
release() { "$BUNDLE/update-fixture-server" release --control "$CONTROL_URL" --version "$1" --sequence "$2"; }
for v in 1.0.0 1.1.0 1.2.0; do say "   $v  $(env -i "$BUNDLE/lazurio-$v" --version)"; done
pass "three real product executables run natively"
took

step "b. lazurio install --service systemd-user: the downloaded executable proves and installs ITSELF"
A=$(name_of 1.0.0); B=$(name_of 1.1.0); C=$(name_of 1.2.0)
release 1.0.0 1 | sed 's/^/   /'
DOWNLOADED=$WORK/Downloads/lazurio
mkdir -p "$WORK/Downloads" && cp "$BUNDLE/lazurio-1.0.0" "$DOWNLOADED"
# The Launchpad needs an initialized Folder; there is no Folder discovery.
product "$DOWNLOADED" folder-init --folder "$FOLDER" --access local --purpose human --locale en --detail concise --coordination direct >/dev/null ||
  fail "folder-init"
# A tampered download proves nothing and installs nothing.
cp "$DOWNLOADED" "$WORK/Downloads/tampered" && printf x >>"$WORK/Downloads/tampered"
product "$WORK/Downloads/tampered" install --bootstrap-root "$WORK/state/root.json" "${ORIGINS[@]}" >"$WORK/install.out"
expect "tampered executable" "$(field code <"$WORK/install.out")" unverified-executable
[ ! -e "$QHOME/.local" ] && pass "nothing was created" || fail "something was created"
# Ubuntu's default umask: the layout must be owner-only regardless.
(umask 002; product "$DOWNLOADED" install --service systemd-user --unit "$UNIT" --folder "$FOLDER" \
  --bootstrap-root "$WORK/state/root.json" "${ORIGINS[@]}" >"$WORK/install.out"; echo "exit=$?" >>"$WORK/install.out")
sed "s|$WORK|<work>|g;s/^/   > /" "$WORK/install.out"
expect "result" "$(field kind <"$WORK/install.out")" installed
expect "selector" "$(selected)" "$A"
expect "modes of base bin versions trust update (umask 002)" \
  "$(stat -c %a "$BASE" "$BASE/bin" "$BASE/versions" "$BASE/trust" "$BASE/update" | tr '\n' ' ')" "700 700 700 700 700 "
expect "modes of the executable and its identity" "$(stat -c %a "$BASE/versions/$A/lazurio" "$BASE/versions/$A/identity.json" | tr '\n' ' ')" "500 400 "
say "   unit written by the installer:"
sed "s|$WORK|<work>|g;s/^/   | /" "$UNIT_FILE"
expect "unit enabled" "$(systemctl --user is-enabled "$UNIT")" enabled
product "$DOWNLOADED" install "${ORIGINS[@]}" >"$WORK/install.out"
expect "a second install" "$(field code <"$WORK/install.out")" already-installed
took

step "c. the Launchpad runs as the systemd user service the installer wrote; ExecStart is the selector"
# The harness's faults live in a DROP-IN next to the installer's unit, not in
# the product and not in the unit: a gate script that refuses, or kills, the
# Launchpad of version 1.2.0 while a fault is switched on.
cat >"$WORK/unit-gate.sh" <<GATE
#!/bin/sh
fault=\$(cat "$WORK/fault" 2>/dev/null)
case "\$(readlink "$L")" in *1.2.0+*) ;; *) exit 0 ;; esac
[ "\$1" = pre ] && [ "\$fault" = refuse-1.2.0 ] && exit 1
[ "\$1" = post ] && [ "\$fault" = crash-1.2.0 ] && { sleep 1; kill -9 "\$2"; }
exit 0
GATE
chmod 700 "$WORK/unit-gate.sh"
mkdir -p "$UNIT_FILE.d"
cat >"$UNIT_FILE.d/qualification-gate.conf" <<DROPIN
[Service]
ExecStartPre=$WORK/unit-gate.sh pre
ExecStartPost=$WORK/unit-gate.sh post \$MAINPID
RestartSec=1
DROPIN
systemctl --user daemon-reload
if wait_for 30 launchpad_on 1.0.0; then
  pass "readiness announced: digest of 1.0.0, pid $(ready_field pid) = MainPID"
else
  fail "no readiness for 1.0.0: $(cat "$BASE/update/launchpad-readiness.json" 2>&1)"
fi
say "   i. ExecStart is the selector; the kernel runs: $(readlink "/proc/$(unit_pid)/exe" | sed "s|$BASE|<base>|")"
expect "i. the running executable is the versioned path, not the selector" \
  "$(readlink "/proc/$(unit_pid)/exe")" "$BASE/versions/$A/lazurio"
took

# Runs `lazurio update …` in the background and reports the transient worker.
UPDATE_OUT=$WORK/update.out
start_update() { : >"$UPDATE_OUT"; (lz update "$@" >"$UPDATE_OUT" 2>"$WORK/update.err"; echo "exit=$?" >>"$UPDATE_OUT") & UPDATE_JOB=$!; }
finish_update() { wait "$UPDATE_JOB" 2>/dev/null; sed 's/^/   > /' "$UPDATE_OUT"; }
confirming() { [ "$(record_phase)" = confirming ] && [ -n "$(worker_unit)" ]; }

step "d. 1.0.0 -> 1.1.0 under systemd: transient worker outside the Launchpad's control group, fresh stable instance"
release 1.1.0 2 | sed 's/^/   /'
OLD_PID=$(unit_pid)
start_update --stability-ms 5000 --deadline-ms 60000 "${ORIGINS[@]}"
if wait_for 60 confirming; then
  W=$(worker_unit)
  WORKER_GROUP=$(systemctl --user show "$W" -p ControlGroup --value)
  LAUNCHPAD_GROUP=$(systemctl --user show "$UNIT" -p ControlGroup --value)
  say "   worker     $(echo "$W" | sed 's/update-.*/update-<operation>.service/')  $(echo "$WORKER_GROUP" | sed 's|.*/||;s/update-.*/update-<operation>.service/')"
  say "   launchpad  ${LAUNCHPAD_GROUP##*/}"
  say "   worker runs: $(readlink "/proc/$(systemctl --user show "$W" -p MainPID --value)/exe" | sed "s|$BASE|<base>|")"
  case "$WORKER_GROUP" in "" | "$LAUNCHPAD_GROUP"*) fail "worker shares the Launchpad's control group" ;; *) pass "worker has its own control group" ;; esac
  expect "worker executes the PREVIOUS immutable executable" \
    "$(readlink "/proc/$(systemctl --user show "$W" -p MainPID --value)/exe")" "$BASE/versions/$A/lazurio"
  systemctl --user show "$W" -p Restart -p NRestarts | sed 's/^/   /'
else
  fail "never saw a confirming record with a worker unit"
fi
finish_update
expect "result" "$(field kind <"$UPDATE_OUT")" updated
expect "selector" "$(selected)" "$B"
launchpad_on 1.1.0 && pass "Launchpad active on 1.1.0" || fail "Launchpad is not on 1.1.0"
[ "$(unit_pid)" != "$OLD_PID" ] && pass "fresh instance: pid $OLD_PID -> $(unit_pid), started $(ready_field startedAt)" || fail "same pid"
[ ! -e "$BASE/update/activation.json" ] && pass "record removed" || fail "record still present"
expect "previous.json" "$(field name <"$BASE/update/previous.json")" "$A"
expect "observation" "$(field status <"$BASE/update/observed.json")" up-to-date
took

step "e1. 1.2.0 whose Launchpad is refused at start -> automatic rollback to 1.1.0"
release 1.2.0 3 | sed 's/^/   /'
echo refuse-1.2.0 >"$WORK/fault"
start_update --stability-ms 5000 --deadline-ms 60000 "${ORIGINS[@]}"
finish_update
expect "typed error" "$(field code <"$UPDATE_OUT")" activation-failed
expect "exit status" "$(grep -o 'exit=.*' "$UPDATE_OUT")" exit=40
expect "selector" "$(selected)" "$B"
wait_for 20 launchpad_on 1.1.0 && pass "Launchpad healthy again on 1.1.0" || fail "Launchpad not back on 1.1.0"
[ ! -e "$BASE/update/activation.json" ] && pass "record removed" || fail "record still present"
say "   observed: status=$(field status <"$BASE/update/observed.json") code=$(field code <"$BASE/update/observed.json") canRetry=$(field canRetry <"$BASE/update/observed.json") available=$(grep -A1 '"available"' "$BASE/update/observed.json" | field version)"
expect "observed error" "$(field code <"$BASE/update/observed.json")" activation-failed
took

step "e2. 1.2.0 whose Launchpad starts and is killed, again and again -> deadline, rollback, unit restartable"
echo crash-1.2.0 >"$WORK/fault"
start_update --stability-ms 5000 --deadline-ms 25000 "${ORIGINS[@]}"
finish_update
expect "typed error" "$(field code <"$UPDATE_OUT")" activation-failed
expect "selector" "$(selected)" "$B"
wait_for 20 launchpad_on 1.1.0 && pass "Launchpad healthy again on 1.1.0 (after the crash loop)" || fail "Launchpad not back on 1.1.0: $(systemctl --user is-active "$UNIT") / $(systemctl --user show "$UNIT" -p Result --value)"
rm -f "$WORK/fault"
lz update --check "${ORIGINS[@]}" >"$WORK/check.out"; CHECK=$?
expect "a later check offers the retry (exit 10)" "$CHECK" 10
took

step "f. kill -9 of the worker while confirming -> systemd restarts it and it finishes ITS record"
start_update --stability-ms 8000 --deadline-ms 90000 "${ORIGINS[@]}"
if wait_for 60 confirming; then
  W=$(worker_unit); OPERATION=$(field operation <"$BASE/update/activation.json")
  systemctl --user kill --signal=SIGKILL "$W" && say "   SIGKILL -> worker (record: $(record_phase))"
  restarted() { [ "$(systemctl --user show "$W" -p NRestarts --value)" = 1 ]; }
  wait_for 20 restarted || true
  say "   NRestarts=$(systemctl --user show "$W" -p NRestarts --value)"
else
  fail "never saw a confirming record with a worker unit"
fi
finish_update
wait_for 60 test ! -e "$BASE/update/activation.json" && pass "record settled without any command" || fail "record still present"
expect "selector" "$(selected)" "$C"
wait_for 20 launchpad_on 1.2.0 && pass "Launchpad active on 1.2.0" || fail "Launchpad is not on 1.2.0"
expect "same operation confirmed" "$(field operationId <"$BASE/update/observed.json")" "${OPERATION:-?}"
expect "previous.json" "$(field name <"$BASE/update/previous.json")" "$B"
took

step "h. lazurio update rollback 1.2.0 -> 1.1.0 through the same worker path"
start_update rollback --stability-ms 5000 --deadline-ms 60000 --json
finish_update
expect "result" "$(field kind <"$UPDATE_OUT")" rolled-back
expect "selector" "$(selected)" "$B"
launchpad_on 1.1.0 && pass "Launchpad active on 1.1.0" || fail "Launchpad is not on 1.1.0"
expect "previous.json" "$(field name <"$BASE/update/previous.json")" "$C"
took

step "g. reboot-equivalent: worker gone, Launchpad unit (re)started with a record present -> it settles the record itself"
start_update --stability-ms 8000 --deadline-ms 90000 "${ORIGINS[@]}"
if wait_for 60 confirming; then
  systemctl --user stop "$(worker_unit)" && say "   worker unit stopped (a transient unit does not survive a reboot)"
  systemctl --user restart "$UNIT" && say "   Launchpad unit restarted with record phase=$(record_phase)"
  [ -e "$BASE/update/activation.json" ] && pass "record present, no worker: $(worker_unit | grep -c .) worker units" || fail "record vanished early"
else
  fail "never saw a confirming record with a worker unit"
fi
finish_update
wait_for 40 test ! -e "$BASE/update/activation.json" && pass "the Launchpad confirmed itself after its stability period; no command was run" || fail "record still present"
expect "selector" "$(selected)" "$C"
launchpad_on 1.2.0 && pass "Launchpad active on 1.2.0" || fail "Launchpad is not on 1.2.0"
expect "observation" "$(field status <"$BASE/update/observed.json")" up-to-date
took

step "f2. worker AND Launchpad gone past the deadline -> a plain later 'lazurio --version' undoes it"
start_update rollback --stability-ms 8000 --deadline-ms 12000 --json
if wait_for 60 confirming; then
  systemctl --user stop "$(worker_unit)" "$UNIT" && say "   worker and Launchpad stopped; selector names $(selected | cut -d+ -f1), record phase=$(record_phase)"
else
  fail "never saw a confirming record with a worker unit"
fi
finish_update
sleep 13
say "   \$ lazurio --version"
lz --version 2>&1 | sed "s/+[0-9a-f]\{16\}/+<sha16>/;s/^/   > /"
[ ! -e "$BASE/update/activation.json" ] && pass "record settled by an ordinary command" || fail "record still present"
expect "selector back on the version that was confirmed" "$(selected)" "$C"
expect "observed error" "$(field code <"$BASE/update/observed.json")" activation-interrupted
wait_for 30 launchpad_on 1.2.0 && pass "the undo restarted the Launchpad onto 1.2.0" || fail "Launchpad is not on 1.2.0"
took

say ""
if [ "$FAILED" -eq 0 ]; then say "QUALIFIED: every journey passed"; else say "NOT QUALIFIED: $FAILED check(s) failed"; fi
exit "$FAILED"
