#!/bin/sh
# Native CLI fixture journey, not software installation or crash qualification.
set -eu
test "$#" -eq 1
binary=$1
case "$binary" in /*) ;; *) echo 'Absolute binary path required' >&2; exit 1;; esac
test -x "$binary"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
temporary=$(cd "$temporary" && pwd -P)
fixture="$temporary/Lazurio"
run() {
  expected=$1
  shift
  actual=0
  env -i "$binary" "$@" > "$temporary/out" 2> "$temporary/err" || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    echo "Unexpected exit status $actual (expected $expected)" >&2
    exit 1
  fi
}
profile() {
  status=$1
  command=$2
  language=$3
  shift 3
  run "$status" "$command" --folder "$fixture" --access remote --purpose human \
    --locale "$language" --detail concise --coordination direct "$@"
}
profile 0 folder-init en
grep -Fx '{"kind":"initialized","revision":1}' "$temporary/out" >/dev/null
test -d "$fixture/organizations"
test -d "$fixture/personalspace"
printf '%s\n' 'Synthetic organization work' > "$fixture/organizations/keep"
printf '%s\n' 'Synthetic personal work' > "$fixture/personalspace/keep"
cp "$fixture/organizations/keep" "$temporary/org-before"
cp "$fixture/personalspace/keep" "$temporary/personal-before"
cp "$fixture/AGENTS.md" "$temporary/instructions-before"
profile 1 folder-init cs
cmp "$temporary/instructions-before" "$fixture/AGENTS.md"
profile 0 profile-update cs --expected-revision 1
grep -Fx '{"kind":"updated","revision":2}' "$temporary/out" >/dev/null
profile 2 profile-update en --expected-revision 1
grep -F '"reason":"stale-revision"' "$temporary/out" >/dev/null
profile 0 profile-update cs --expected-revision 2
grep -Fx '{"kind":"unchanged"}' "$temporary/out" >/dev/null
run 0 profile-resume --folder "$fixture" --target-revision 2
grep -Fx '{"kind":"recovered","revision":2}' "$temporary/out" >/dev/null
printf '%s\n' 'Manual instructions must survive' > "$fixture/AGENTS.md"
cp "$fixture/AGENTS.md" "$temporary/edited"
profile 2 profile-update en --expected-revision 2
run 1 profile-resume --folder "$fixture" --target-revision 2
cmp "$temporary/edited" "$fixture/AGENTS.md"
cmp "$temporary/org-before" "$fixture/organizations/keep"
cmp "$temporary/personal-before" "$fixture/personalspace/keep"
test ! -e "$fixture/.lazurio/transaction"
test -f "$fixture/.lazurio/history/initialization/before.json"
test -f "$fixture/.lazurio/history/revision-2/prepared.json"
echo 'PASS: native CLI fresh Folder, update, stale/no-op, archived resume and manual-edit preservation'
