#!/usr/bin/env bash
# Git plumbing of the published update repository for the release and refresh
# workflows. The tree (TUF metadata, channel documents, identities, notes)
# lives on the `gh-pages` branch, which GitHub Pages serves; one pushed commit
# is one deployment of the whole tree. History is only ever appended: no force
# push, nothing deleted. The token is sent as a request header and never
# becomes part of a remote URL, a config file or the log.
#
#   update-tree.sh checkout <directory>   clone the branch, or start it
#   update-tree.sh push <directory> <commit message>
#
# UPDATE_TREE_CNAME, when set, is the custom domain of the Pages site: `push`
# adds the CNAME file GitHub Pages reads it from, and refuses another value.
#
# Needs GITHUB_REPOSITORY and GH_TOKEN (contents: write for `push`). A local
# rehearsal names another remote — a bare repository — in UPDATE_TREE_REMOTE
# and needs neither.
set -euo pipefail

command="${1:?checkout or push}"
tree="${2:?tree directory}"
if [ -n "${UPDATE_TREE_REMOTE:-}" ]; then
  remote="$UPDATE_TREE_REMOTE"
  authenticated() { git "$@"; }
else
  : "${GITHUB_REPOSITORY:?}" "${GH_TOKEN:?}"
  remote="https://github.com/$GITHUB_REPOSITORY.git"
  authenticated() {
    local header
    local encoded
    encoded="$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')"
    # GitHub masks the token itself, not its encoded form.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$encoded"; fi
    git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $encoded" "$@"
  }
fi

case "$command" in
  checkout)
    mkdir -p "$tree"
    git -C "$tree" init --quiet --initial-branch gh-pages
    git -C "$tree" remote add origin "$remote"
    # Exit status 2 is the ONLY answer that means "no such branch". A failed
    # login, an outage or anything else must stop the run: read as "nothing
    # published yet", it would let the daily refresh go green while the
    # timestamp runs out.
    status=0
    authenticated -C "$tree" ls-remote --exit-code --heads origin gh-pages >/dev/null || status=$?
    if [ "$status" -eq 0 ]; then
      authenticated -C "$tree" fetch --quiet --depth 1 origin gh-pages
      git -C "$tree" reset --quiet --hard FETCH_HEAD
    elif [ "$status" -eq 2 ]; then
      echo "::notice::No gh-pages branch yet; this run starts the published tree."
    else
      echo "::error::Cannot read the published tree (git ls-remote exit $status)."
      exit 1
    fi
    ;;
  push)
    message="${3:?commit message}"
    # Served as plain files: no Jekyll build, no ignored names.
    touch "$tree/.nojekyll"
    if [ -n "${UPDATE_TREE_CNAME:-}" ]; then
      if [ ! -e "$tree/CNAME" ]; then
        printf '%s\n' "$UPDATE_TREE_CNAME" >"$tree/CNAME"
      elif [ "$(tr -d '[:space:]' <"$tree/CNAME")" != "$UPDATE_TREE_CNAME" ]; then
        echo "::error::The tree is published under another domain than the product is built for."
        exit 1
      fi
    fi
    git -C "$tree" add --all
    if git -C "$tree" diff --cached --quiet; then
      echo "Nothing changed; nothing to deploy."
      echo "changed=false" >>"${GITHUB_OUTPUT:-/dev/null}"
      exit 0
    fi
    # Append-only: a published file is never modified or removed, except the
    # timestamp, which exists to be replaced.
    rewritten="$(git -C "$tree" diff --cached --name-only --diff-filter=MDRT -- . ':(exclude)metadata/timestamp.json')"
    if [ -n "$rewritten" ]; then
      echo "::error::Refusing to rewrite or remove published files:"
      echo "$rewritten"
      exit 1
    fi
    git -C "$tree" \
      -c user.name="github-actions[bot]" \
      -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit --quiet --message "$message"
    authenticated -C "$tree" push --quiet origin HEAD:refs/heads/gh-pages
    echo "changed=true" >>"${GITHUB_OUTPUT:-/dev/null}"
    ;;
  *)
    echo "Unknown command: $command" >&2
    exit 2
    ;;
esac
