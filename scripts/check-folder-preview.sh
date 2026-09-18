#!/bin/sh
# Native standalone smoke; only newly created synthetic fixtures are modified.
# Requires POSIX shell/core utilities, not Node or Bun. Not an installer test.
set -eu
binary=${1:?Usage: sh check-folder-preview.sh /absolute/path/to/cli}
case "$binary" in /*) ;; *) echo 'Absolute binary path required' >&2; exit 1;; esac
test -x "$binary"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fixture="$temporary/folder"
mkdir -m 700 "$fixture"
fixture=$(cd "$fixture" && pwd -P)
mkdir "$fixture/organizations" "$fixture/personalspace"
printf '%s\n' 'Synthetic organization data' > "$fixture/organizations/keep"
printf '%s\n' 'Synthetic personal data' > "$fixture/personalspace/keep"
cp "$fixture/organizations/keep" "$temporary/org-before"
cp "$fixture/personalspace/keep" "$temporary/personal-before"

run() {
  expected=$1
  shift
  actual=0
  env -i "$binary" "$@" > "$temporary/out" 2> "$temporary/err" || actual=$?
  if [ "$actual" -ne "$expected" ]; then
    echo "Unexpected exit status: $actual (expected $expected)" >&2
    exit 1
  fi
}
preview() {
  status=$1
  language=$2
  shift 2
  run "$status" folder-preview --folder "$fixture" --access remote \
    --purpose human --locale "$language" --detail concise --coordination direct "$@"
}

run 0 --help
for language in cs en; do
  preview 0 "$language"
  grep -F '"kind":"create"' "$temporary/out" >/dev/null
  test ! -e "$fixture/AGENTS.md"
done

printf '%s\n' 'Synthetic user instructions; preserve exactly.' > "$fixture/AGENTS.md"
cp "$fixture/AGENTS.md" "$temporary/instructions-before"
preview 2 en
grep -F '"reason":"unowned-file"' "$temporary/out" >/dev/null
preview 2 cs --previous-digest aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
grep -F '"reason":"drift"' "$temporary/out" >/dev/null
cmp "$temporary/instructions-before" "$fixture/AGENTS.md"

# Remove only the file created above; its replacement must never be followed.
rm "$fixture/AGENTS.md"
ln -s organizations/keep "$fixture/AGENTS.md"
preview 2 en
grep -F '"reason":"unsafe-path"' "$temporary/out" >/dev/null
test -L "$fixture/AGENTS.md"
cmp "$temporary/org-before" "$fixture/organizations/keep"
cmp "$temporary/personal-before" "$fixture/personalspace/keep"

preview 1 invalid-language
test ! -s "$temporary/out"
if grep -F "$fixture" "$temporary/err" >/dev/null; then
  echo 'Private fixture path leaked in error' >&2
  exit 1
fi
run 1 folder-preview --access remote --purpose human --locale en --detail concise --coordination direct
test ! -s "$temporary/out"
echo 'PASS: standalone cs/en preview, unowned file, drift, symlink, invalid input and protected fixture bytes'
