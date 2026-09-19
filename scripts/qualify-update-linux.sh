#!/usr/bin/env bash
# Native qualification of the product update on a REAL Linux with a REAL systemd
# user manager (docs/update.md "Evidence required before any Machine depends on
# this"). Runs ON a DISPOSABLE Linux Machine, as the user whose user manager is
# used, from the bundle built by `scripts/qualify-update-linux.ts`:
#
#   LAZURIO_QUALIFY_DISPOSABLE=1 bash <bundle>/qualify-update-linux.sh before-reboot
#   sudo reboot          # a REAL reboot in the middle of an activation
#   LAZURIO_QUALIFY_DISPOSABLE=1 bash <bundle>/qualify-update-linux.sh after-reboot
#
# It uses the user's REAL install base (~/.local/share/lazurio), Folder
# (~/Lazurio) and systemd user units, exactly as a person's installation does;
# that is why it refuses to run without the variable above and on a Machine
# that already has an installation. The user manager must survive the login
# session and start at boot: `loginctl enable-linger` is the operator's step.
#
# FIXTURE: the executables in the bundle are qualification builds. They ask a
# loopback origin served from this Machine and trust the fixture Sigstore root
# in the bundle; `lazurio --version` says so. Nothing else is needed here: no
# Bun, no curl, no jq.
set -uo pipefail
# The product refuses group-writable Folder parents; Ubuntu's default umask is 002.
umask 077

PHASE=${1:?before-reboot or after-reboot}
BUNDLE=$(cd "$(dirname "$0")" && pwd -P)
# shellcheck disable=SC1091
. "$BUNDLE/bundle.env" # COMMIT, TARGET, PORT, BUNDLE_PATH
[ "${LAZURIO_QUALIFY_DISPOSABLE:-}" = 1 ] || { echo "Refused: disposable Machines only (see the header)"; exit 2; }
[ "$BUNDLE" = "$BUNDLE_PATH" ] || { echo "Refused: the bundle was built for $BUNDLE_PATH"; exit 2; }
: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
BASE=$HOME/.local/share/lazurio
FOLDER=$HOME/Lazurio
WORK=$HOME/update-qual-work
UNIT=lazurio-launchpad.service
ROLLBACK_UNIT=lazurio-rollback.service
UNIT_DIR=$HOME/.config/systemd/user
L=$BASE/bin/lazurio
FAILED=0

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
lz() { "$L" "$@"; }
selected() { readlink "$L" | cut -d/ -f3; }
previous() { readlink "$BASE/previous" | cut -d/ -f2; }
high_water() { cat "$BASE/update/high-water" 2>/dev/null; }
marker() { cat "$BASE/update/pending.json" 2>/dev/null; }
unit_pid() { systemctl --user show "$UNIT" -p MainPID --value; }
launchpad_on() { # a live unit whose main process IS that version's executable
  [ "$(systemctl --user is-active "$UNIT")" = active ] &&
    [ "$(readlink "/proc/$(unit_pid)/exe")" = "$BASE/versions/$1/lazurio" ] &&
    [ -S "$BASE/update/launchpad.sock" ]
}
state() { say "   state: selector=$(selected) previous=$(previous) high-water=$(high_water) marker=$(marker)"; }
start_fixture() {
  echo "$1" >"$BUNDLE/tree/latest"
  "$BUNDLE/update-fixture-server" --tree "$BUNDLE/tree" --port "$PORT" >"$WORK/fixture.log" 2>&1 &
  echo $! >"$WORK/fixture.pid"
  wait_for 20 grep -q FIXTURE "$WORK/fixture.log" || { fail "fixture origin did not start"; exit 1; }
}
latest() { echo "$1" >"$BUNDLE/tree/latest"; say "   latest -> $1"; }
# Runs `lazurio update …` and records its output and exit status.
OUT=$WORK/update.out
update() { lz update "$@" >"$OUT" 2>"$WORK/update.err"; echo "exit=$?" >>"$OUT"; sed 's/^/   > /' "$OUT"; }
# Runs it in the background and kills it with SIGKILL as soon as the selector
# names <version>: what a power loss right after the switch leaves behind.
# With `boot`, the Machine "comes back": the unit starts what the selector names.
update_killed_after_switch() {
  # The executable itself, not a shell function: `$!` must be the updater.
  "$L" update --json >"$OUT" 2>&1 &
  local updater=$! exe
  exe=$(readlink "/proc/$updater/exe" | sed "s|$BASE|<base>|")
  until [ "$(selected)" = "$1" ] || ! kill -0 "$updater" 2>/dev/null; do sleep 0.02; done
  kill -9 "$updater" 2>/dev/null && say "   SIGKILL -> updater (pid $updater, $exe) right after the switch to $1"
  wait "$updater" 2>/dev/null
  if pgrep -f "lazurio update" >/dev/null; then fail "an updater is still alive"; else pass "no updater is alive"; fi
  if [ "${2:-}" = boot ]; then systemctl --user --no-block restart "$UNIT"; fi
}

say "phase $PHASE: target $TARGET, commit $COMMIT, $(systemctl --version | head -n 1), $(uname -r)"
say "linger: $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"

if [ "$PHASE" = before-reboot ]; then
  [ ! -e "$BASE" ] && [ ! -e "$UNIT_DIR/$UNIT" ] || { echo "Refused: this Machine already has an installation"; exit 2; }
  mkdir -p "$WORK" || exit 2
  for v in 1.0.0 1.1.0 1.1.5 1.2.0; do say "   $("$BUNDLE/lazurio-$v" --version)"; done

  step "1. install --service systemd-user: the downloaded executable installs ITSELF and the units"
  start_fixture v1.0.0
  "$BUNDLE/lazurio-1.0.0" folder-init --folder "$FOLDER" --access local --purpose human --locale en --detail concise --coordination direct >/dev/null || fail "folder-init"
  # Ubuntu's default umask: the layout must be owner-only regardless.
  (umask 002; "$BUNDLE/lazurio-1.0.0" install --service systemd-user --folder "$FOLDER" --json >"$OUT"; echo "exit=$?" >>"$OUT")
  sed 's/^/   > /' "$OUT"
  expect "result" "$(field kind <"$OUT")" installed
  expect "selector" "$(selected)" 1.0.0
  expect "modes of base bin versions update (umask 002)" "$(stat -c %a "$BASE" "$BASE/bin" "$BASE/versions" "$BASE/update" | tr '\n' ' ')" "700 700 700 700 "
  expect "mode of the executable" "$(stat -c %a "$BASE/versions/1.0.0/lazurio")" 500
  say "   units written by the installer:"
  sed 's/^/   | /' "$UNIT_DIR/$UNIT" "$UNIT_DIR/$ROLLBACK_UNIT"
  expect "unit enabled" "$(systemctl --user is-enabled "$UNIT")" enabled
  wait_for 30 launchpad_on 1.0.0 && pass "Launchpad active; the kernel runs versions/1.0.0/lazurio through the selector; health socket present" || fail "Launchpad is not on 1.0.0"
  expect "no high-water mark yet: the floor is the active version" "$(high_water)" ""
  # The harness's faults live in a DROP-IN next to the installer's unit, not in
  # the product: a gate that delays, refuses or kills the Launchpad of 1.2.0.
  cat >"$WORK/unit-gate.sh" <<GATE
#!/bin/sh
fault=\$(cat "$WORK/fault" 2>/dev/null)
case "\$(readlink "$L")" in *versions/1.2.0/*) ;; *) exit 0 ;; esac
[ "\$1" = pre ] && [ "\$fault" = refuse-1.2.0 ] && exit 1
[ "\$1" = pre ] && [ "\$fault" = slow-1.2.0 ] && sleep 20
[ "\$1" = post ] && [ "\$fault" = crash-1.2.0 ] && { sleep 1; kill -9 "\$2"; }
exit 0
GATE
  chmod 700 "$WORK/unit-gate.sh"
  mkdir -p "$UNIT_DIR/$UNIT.d"
  cat >"$UNIT_DIR/$UNIT.d/qualification-gate.conf" <<DROPIN
[Service]
ExecStartPre=$WORK/unit-gate.sh pre
ExecStartPost=$WORK/unit-gate.sh post \$MAINPID
TimeoutStartSec=60
DROPIN
  systemctl --user daemon-reload
  took

  step "2. A -> B (1.0.0 -> 1.1.0): attested release, restart, health at the new version, commit"
  latest v1.1.0
  lz update --check >"$OUT" 2>&1; expect "update --check exit status (10 = available)" "$?" 10
  OLD_PID=$(unit_pid)
  update --json
  expect "result" "$(field kind <"$OUT")" updated
  expect "selector" "$(selected)" 1.1.0
  expect "previous" "$(previous)" 1.0.0
  expect "high-water raised at commit" "$(high_water)" 1.1.0
  expect "marker deleted by the commit" "$(marker)" ""
  launchpad_on 1.1.0 && pass "Launchpad active on 1.1.0 (pid $OLD_PID -> $(unit_pid))" || fail "Launchpad is not on 1.1.0"
  # Only now does `previous` exist, which the rollback unit's ExecStart names.
  systemd-analyze --user verify "$UNIT_DIR/$UNIT" "$UNIT_DIR/$ROLLBACK_UNIT" >"$WORK/verify.out" 2>&1
  expect "systemd-analyze verify accepts both units (exit status)" "$?" 0
  sed 's/^/   | /' "$WORK/verify.out"
  say "   \$ lazurio --version"; lz --version | sed 's/^/   > /'
  took

  step "3. failed B (1.2.0 refused at start): automatic switch-back within the health deadline"
  latest v1.2.0
  echo refuse-1.2.0 >"$WORK/fault"
  update --json
  expect "typed error" "$(field code <"$OUT")" activation-failed
  expect "exit status" "$(grep -o 'exit=.*' "$OUT")" exit=1
  expect "selector" "$(selected)" 1.1.0
  expect "an undone activation never raised the mark" "$(high_water)" 1.1.0
  expect "marker deleted by the undo" "$(marker)" ""
  wait_for 20 launchpad_on 1.1.0 && pass "Launchpad healthy again on 1.1.0" || fail "Launchpad not back on 1.1.0: $(systemctl --user is-active "$UNIT")"
  say "   rollback unit during that attempt (updater alive, lock held -> it must do nothing):"
  journalctl --user -u "$ROLLBACK_UNIT" -o cat --no-pager 2>/dev/null | tail -n 3 | sed 's/^/   | /'
  lz update --check >/dev/null 2>&1; expect "the retry is the same action (check exit 10)" "$?" 10
  took

  step "4. power loss after the switch + crashing 1.2.0 -> OnFailure=lazurio-rollback.service undoes (no updater, no command)"
  echo crash-1.2.0 >"$WORK/fault"
  update_killed_after_switch 1.2.0 boot
  state
  expect "the dead updater left the marker" "$(marker)" '{"from":"1.1.0","to":"1.2.0"}'
  say "   nobody runs any command now; systemd alone is in charge"
  undone() { [ "$(selected)" = 1.1.0 ] && [ -z "$(marker)" ] && launchpad_on 1.1.0; }
  wait_for 90 undone && pass "rollback unit switched back, reset the failed unit and restarted it: Launchpad on 1.1.0" || fail "not undone: $(systemctl --user is-active "$UNIT") / $(systemctl --user show "$UNIT" -p Result --value)"
  state
  expect "the mark was not raised" "$(high_water)" 1.1.0
  say "   journal of the rollback unit:"
  journalctl --user -u "$ROLLBACK_UNIT" -o cat --no-pager 2>/dev/null | tail -n 4 | sed 's/^/   | /'
  took

  step "5a. power loss after the switch to a HEALTHY 1.2.0 — followed by a REAL reboot"
  echo slow-1.2.0 >"$WORK/fault" # only so that the updater is killed before it can commit
  update_killed_after_switch 1.2.0
  rm -f "$WORK/fault"
  state
  expect "selector" "$(selected)" 1.2.0
  expect "the dead updater left the marker" "$(marker)" '{"from":"1.1.0","to":"1.2.0"}'
  expect "not committed: the mark is still" "$(high_water)" 1.1.0
  sync
  took
  say ""
  say "NOW: sudo reboot, then run this script with after-reboot. Checks failed so far: $FAILED"
  echo "$FAILED" >"$WORK/failed-before-reboot"
  exit "$FAILED"
fi

[ "$PHASE" = after-reboot ] || { echo "Unknown phase"; exit 2; }
FAILED=$(cat "$WORK/failed-before-reboot" 2>/dev/null || echo 1)
say "uptime: $(uptime -p); boot id $(cat /proc/sys/kernel/random/boot_id)"

step "5b. after the reboot: the Launchpad of 1.2.0 started healthy by itself and committed the marker"
committed() { [ -z "$(marker)" ] && [ "$(high_water)" = 1.2.0 ]; }
wait_for 90 committed && pass "marker deleted and mark raised to 1.2.0 without any command" || fail "not committed"
state
wait_for 30 launchpad_on 1.2.0 && pass "Launchpad active on 1.2.0 after boot" || fail "Launchpad is not on 1.2.0"
say "   system boot: $(who -b | sed 's/^ *system boot *//')"
say "   Launchpad started: $(journalctl --user -b -u "$UNIT" -o short-precise --no-pager | grep -m 1 'Started' | cut -d' ' -f1-3)"
say "   high-water written: $(stat -c %y "$BASE/update/high-water")  (the Launchpad commits once it outlived its first 15 s)"
say "   commands run by anyone since boot until then: none (this script started at $(date '+%H:%M:%S'))"
expect "previous" "$(previous)" 1.1.0
lz update status | sed 's/^/   > /'
took

step "6. explicit rollback 1.2.0 -> 1.1.0: previous after its own self-check, same restart and health rule"
start_fixture v1.2.0
lz update rollback --json >"$OUT" 2>&1; echo "exit=$?" >>"$OUT"; sed 's/^/   > /' "$OUT"
expect "result" "$(field kind <"$OUT")" rolled-back
expect "selector" "$(selected)" 1.1.0
expect "previous" "$(previous)" 1.2.0
expect "the version left stays the floor" "$(high_water)" 1.2.0
expect "marker" "$(marker)" ""
launchpad_on 1.1.0 && pass "Launchpad active on 1.1.0" || fail "Launchpad is not on 1.1.0"
took

step "7. the floor: no network path goes below the high-water mark; the equal retry is allowed"
latest v1.1.5 # newer than the active 1.1.0, below the mark 1.2.0
lz update --check >"$OUT" 2>&1; expect "latest below the floor is not an update (check exit 0)" "$?" 0
update --json
expect "update through latest" "$(field kind <"$OUT")" up-to-date
update --version v1.1.5 --json
expect "exact tag below the floor" "$(field code <"$OUT")" release-invalid
expect "reason" "$(field reason <"$OUT")" below-floor
expect "selector unchanged" "$(selected)" 1.1.0
update --version v1.2.0 --json
expect "equal to the mark, not active: allowed" "$(field kind <"$OUT")" updated
expect "selector" "$(selected)" 1.2.0
launchpad_on 1.2.0 && pass "Launchpad active on 1.2.0" || fail "Launchpad is not on 1.2.0"
lz update status --json | sed 's/^/   > /'
took

kill "$(cat "$WORK/fixture.pid")" 2>/dev/null
say ""
if [ "$FAILED" -eq 0 ]; then say "QUALIFIED: every journey passed"; else say "NOT QUALIFIED: $FAILED check(s) failed"; fi
exit "$FAILED"
