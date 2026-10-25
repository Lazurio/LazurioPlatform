#!/usr/bin/env python3
"""Goldens for Buddy's persona (decision F64), produced by the interim installer itself.

Usage: python3 -I generate-goldens.py <buddy-install.sh> <goldens.json>

The interim installer (`buddy-install.sh`) is the byte authority for what the Platform derives
from `persona.json`. It lives outside this repository (an interim draft its maintainer owns, until
Machines take the install over, HumanAndMachine-ai/Machines#701), so the provenance here is the
installer's recorded sha256 plus the committed goldens; this script never copies its code. It checks the installer's sha256, extracts the
Python helper the installer writes at run time (the heredoc `cat > "$WORK/h.py" <<'PY'` ... `PY`)
into a temporary directory, and runs that helper's own commands exactly as the installer does:

- `persona-check FILE` for every validation case (its exit and its message);
- `soul-render FILE OUT LOCALE` and `acting-dropin-render FILE OUT` into real files, whose bytes
  and modes are recorded (the installer's write path: `atomic_write(data.encode(), mode)`);
- `persona-build OUT` with the `BI_*` variables, as `--buddy-name` and the other options do;
- `sd_env(value)` of the imported helper for raw quoting cases no valid persona can reach.

Nothing here reads a real persona or Environment: every name is an example.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unicodedata

INSTALLER_VERSION = "2026-10-25.1"
INSTALLER_SHA256 = "f241352974ea153b6ad21a02227676d12ab33094502dc71c617b94a1457d3c3e"
# 2026-10-24.2 (sha256 fdd770f3a36afccb08f6fddaaa95106e1357cd55515de681508949941a825ea5) rendered
# the same bytes in every render, build and quoting case; 2026-10-25.1 only adds the refusal of a
# lone surrogate in every member to persona_check.
HEREDOC_START = "cat > \"$WORK/h.py\" <<'PY'"
SCHEMA = "lazurio.buddy-persona.v1"


def persona(buddy="Rex", address="ty", nom="Ada", acc="Adu", dat="Adě", **extra):
    p = {"schema_version": SCHEMA, "buddy_name": buddy, "address": address,
         "user": {"nominative": nom, "accusative": acc, "dative": dat}}
    p.update(extra)
    return p


def text_of(p) -> str:
    """A persona file as the installer's persona-build writes one."""
    return json.dumps(p, ensure_ascii=False, indent=2) + "\n"


# ---- render cases: (id, persona, locales) --------------------------------------------------
TONE_PLAIN = "Krátce, s humorem a bez vaty."
TONE_QUOTING = 'Říkej "ahoj", cesta C:\\Users\\ada, 100% jistota, $HOME, `kód`, {x} <b>, tab\there\rcr'
RENDER = [
    # cs and en x ty and vy x with and without a tone
    ("rex-ty", persona(address="ty"), ("cs", "en")),
    ("rex-vy", persona(address="vy"), ("cs", "en")),
    ("rex-ty-tone", persona(address="ty", tone=TONE_PLAIN), ("cs", "en")),
    ("rex-vy-tone", persona(address="vy", tone=TONE_PLAIN), ("cs", "en")),
    # A Buddy named Buddy is no "Buddy, Buddy": Python's strip() and casefold()
    ("buddy", persona(buddy="Buddy", address="vy", nom="Bob", acc="Boba", dat="Bobovi"), ("cs", "en")),
    ("buddy-lower", persona(buddy="buddy"), ("cs",)),
    ("buddy-upper-spaced", persona(buddy="  BUDDY "), ("cs", "en")),
    ("buddy-nbsp", persona(buddy="\u00a0Buddy"), ("cs",)),
    ("buddy-ideographic-space", persona(buddy="\u2003Buddy\u3000"), ("en",)),
    # NEL (U+0085) is Python whitespace and no JavaScript whitespace
    ("buddy-nel", persona(buddy="\u0085Buddy"), ("cs",)),
    # U+FEFF is JavaScript whitespace and no Python whitespace
    ("buddy-bom-char", persona(buddy="\ufeffBuddy"), ("cs",)),
    ("buddy-not-quite", persona(buddy="Buddy Rex"), ("cs",)),
    ("bobr", persona(buddy="Bobr", address="vy", nom="Bob", acc="Boba", dat="Bobovi"), ("en",)),
    ("vera", persona(buddy="Bobr", address="vy", nom="Věra", acc="Věru", dat="Věře"), ("cs",)),
    # quoting: a tone is free text, names are not; a % in a name reaches the drop-in
    ("tone-quoting", persona(tone=TONE_QUOTING), ("cs", "en")),
    ("percent-names", persona(buddy="Rex 100%", nom="Ada%", acc="Adu%n", dat="Adě%%"), ("cs", "en")),
    ("unicode-names", persona(buddy="Rex 🦖", nom="Šárka", acc="Šárku", dat="Šárce"), ("cs", "en")),
    ("long-names", persona(buddy="R" * 60, nom="N" * 60, acc="A" * 60, dat="D" * 60, tone="t" * 300), ("cs",)),
    ("unknown-members", persona(confirmed_at="2026-10-25T00:00:00Z", extra={"kept": [1, 2]}), ("cs",)),
]

# ---- validation cases: (id, exact file text) ------------------------------------------------
base = persona()


def with_(**changes):
    p = json.loads(json.dumps(base))
    for key, value in changes.items():
        if key.startswith("user_"):
            if value is _DROP:
                p["user"].pop(key[5:], None)
            else:
                p["user"][key[5:]] = value
        elif value is _DROP:
            p.pop(key, None)
        else:
            p[key] = value
    return p


_DROP = object()
VALID = text_of(base)
CHECK = [
    ("valid", VALID),
    ("valid-tone", text_of(with_(tone="Krátce."))),
    ("valid-unknown-members", text_of(with_(confirmed_at="kdykoli", extra=None))),
    ("valid-minified", json.dumps(base, ensure_ascii=True)),
    ("valid-tone-300", text_of(with_(tone="x" * 300))),
    ("valid-tone-carriage-return", text_of(with_(tone="a\rb"))),
    ("valid-tone-tab", text_of(with_(tone="a\tb"))),
    ("valid-tone-astral-300", text_of(with_(tone="🦖" * 300))),
    ("valid-name-60", text_of(with_(buddy_name="x" * 60))),
    ("valid-name-astral-60", text_of(with_(buddy_name="🦖" * 60))),
    ("valid-nominative-astral-32", text_of(with_(user_nominative="🦖" * 32))),
    ("valid-dative-zero-width", text_of(with_(user_dative="Ad\u200bě"))),
    ("valid-buddy-zero-width", text_of(with_(buddy_name="Re\u200bx"))),
    ("valid-buddy-nel", text_of(with_(buddy_name="\u0085Rex"))),
    ("valid-buddy-spaces", text_of(with_(buddy_name=" Rex "))),
    ("valid-percent", text_of(with_(user_nominative="Ada%"))),
    ("valid-c1-dative", text_of(with_(user_dative="Ad\u0090ě"))),
    ("valid-duplicate-key-last-wins", VALID.replace('"address": "ty"', '"address": "oni", "address": "ty"')),
    ("bad-schema-missing", text_of(with_(schema_version=_DROP))),
    ("bad-schema-other", text_of(with_(schema_version="lazurio.buddy-persona.v2"))),
    ("bad-buddy-missing", text_of(with_(buddy_name=_DROP))),
    ("bad-buddy-empty", text_of(with_(buddy_name=""))),
    ("bad-buddy-null", text_of(with_(buddy_name=None))),
    ("bad-buddy-number", text_of(with_(buddy_name=5))),
    ("bad-buddy-zero", text_of(with_(buddy_name=0))),
    ("bad-buddy-list", text_of(with_(buddy_name=["Rex"]))),
    ("bad-buddy-61", text_of(with_(buddy_name="x" * 61))),
    ("bad-buddy-astral-61", text_of(with_(buddy_name="🦖" * 61))),
    ("bad-buddy-newline-end", text_of(with_(buddy_name="Rex\n"))),
    ("bad-buddy-tab", text_of(with_(buddy_name="Re\tx"))),
    ("bad-buddy-nul", text_of(with_(buddy_name="Re\u0000x"))),
    ("bad-buddy-us", text_of(with_(buddy_name="Re\u001fx"))),
    ("bad-buddy-del", text_of(with_(buddy_name="Re\u007fx"))),
] + [
    (f"bad-buddy-char-{ord(c):02x}", text_of(with_(buddy_name=f"Re{c}x"))) for c in "`$\\\"<>{}"
] + [
    ("bad-address-missing", text_of(with_(address=_DROP))),
    ("bad-address-other", text_of(with_(address="oni"))),
    ("bad-address-case", text_of(with_(address="Ty"))),
    ("bad-address-list", text_of(with_(address=["ty"]))),
    ("bad-user-missing", text_of(with_(user=_DROP))),
    ("bad-user-null", text_of(with_(user=None))),
    ("bad-user-empty", text_of(with_(user={}))),
    ("bad-user-list", text_of(with_(user=["Ada"]))),
    ("bad-user-string", text_of(with_(user="Ada"))),
    ("bad-nominative-missing", text_of(with_(user_nominative=_DROP))),
    ("bad-accusative-missing", text_of(with_(user_accusative=_DROP))),
    ("bad-dative-missing", text_of(with_(user_dative=_DROP))),
    ("bad-dative-quote", text_of(with_(user_dative='Ad"ě'))),
    ("bad-nominative-zero-width", text_of(with_(user_nominative="Ada\u200b"))),
    ("bad-accusative-zero-width", text_of(with_(user_accusative="Ad\u200bu"))),
    ("bad-nominative-leading-space", text_of(with_(user_nominative=" Ada"))),
    ("bad-nominative-trailing-nbsp", text_of(with_(user_nominative="Ada\u00a0"))),
    ("bad-nominative-nel", text_of(with_(user_nominative="\u0085Ada"))),
    ("bad-nominative-bom-char", text_of(with_(user_nominative="\ufeffAda"))),
    ("bad-nominative-line-separator", text_of(with_(user_nominative="A\u2028da"))),
    ("bad-nominative-paragraph-separator", text_of(with_(user_nominative="A\u2029da"))),
    ("bad-nominative-private-use", text_of(with_(user_nominative="A\ue000da"))),
    ("bad-nominative-c1", text_of(with_(user_nominative="A\u0090da"))),
    ("bad-nominative-astral-33", text_of(with_(user_nominative="🦖" * 33))),
    ("bad-accusative-61", text_of(with_(user_accusative="x" * 61))),
    ("bad-tone-empty", text_of(with_(tone=""))),
    ("bad-tone-null", text_of(with_(tone=None))),
    ("bad-tone-number", text_of(with_(tone=3))),
    ("bad-tone-301", text_of(with_(tone="x" * 301))),
    ("bad-tone-newline", text_of(with_(tone="a\nb"))),
    ("bad-document-array", json.dumps([base])),
    ("bad-document-string", json.dumps("persona")),
    ("bad-document-empty", ""),
    ("bad-document-not-json", "{schema_version: 1}"),
    ("bad-document-bom", "\ufeff" + VALID),
    # A lone surrogate (only a \ud800 escape makes one) no file can store: refused in every member.
    ("lone-surrogate-buddy", VALID.replace('"buddy_name": "Rex"', '"buddy_name": "R\\ud800x"')),
    ("lone-surrogate-nominative", VALID.replace('"nominative": "Ada"', '"nominative": "A\\udc00da"')),
    ("lone-surrogate-accusative", VALID.replace('"accusative": "Adu"', '"accusative": "A\\ud83du"')),
    ("lone-surrogate-dative", VALID.replace('"dative": "Adě"', '"dative": "Ad\\udfffě"')),
    ("lone-surrogate-tone", text_of(with_(tone="x")).replace('"tone": "x"', '"tone": "a\\ud800b"')),
    # The order of the checks: the nominative's surrogate before the accusative's NAME_RE.
    ("order-nominative-surrogate-before-accusative",
     VALID.replace('"nominative": "Ada"', '"nominative": "A\\udc00da"').replace('"accusative": "Adu"', '"accusative": "A$u"')),
    # A paired surrogate is one character, a valid name.
    ("valid-paired-surrogate-escape", VALID.replace('"buddy_name": "Rex"', '"buddy_name": "R\\ud83e\\udd96x"')),
    # Python's json reads NaN; JSON does not have it.
    ("nan-member", VALID.replace('"address": "ty"', '"address": "ty", "x": NaN')),
]

# ---- persona-build cases: (id, BI_* values) ------------------------------------------------
BUILD = [
    ("build-plain", {"BI_BUDDY": "Rex", "BI_ADDRESS": "ty", "BI_NOM": "Ada", "BI_ACC": "Adu", "BI_DAT": "Adě", "BI_TONE": ""}),
    ("build-tone", {"BI_BUDDY": "Buddy", "BI_ADDRESS": "vy", "BI_NOM": "Bob", "BI_ACC": "Boba", "BI_DAT": "Bobovi", "BI_TONE": "Krátce."}),
    ("build-stripped", {"BI_BUDDY": "  Rex\u00a0", "BI_ADDRESS": " vy\t", "BI_NOM": "\u3000Šárka ", "BI_ACC": " Šárku", "BI_DAT": "Šárce\u0085", "BI_TONE": "  "}),
    ("build-tone-quoting", {"BI_BUDDY": "Rex 🦖", "BI_ADDRESS": "ty", "BI_NOM": "Ada", "BI_ACC": "Adu", "BI_DAT": "Adě", "BI_TONE": TONE_QUOTING}),
]

# ---- sd_env cases: raw values no valid persona name can carry -------------------------------
SD_ENV = [
    "T3CODE_ACTING_FOR=Ada",
    'T3CODE_ACTING_FOR=A"da',
    "T3CODE_ACTING_FOR=A\\da",
    "T3CODE_ACTING_FOR=A%da",
    "T3CODE_ACTING_FOR=%%",
    'T3CODE_ACTING_FOR=\\"%',
    "T3CODE_ACTING_FOR=Šárka 🦖",
    "",
]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_helper(installer: str, into: str) -> str:
    lines = open(installer, encoding="utf-8").read().split("\n")
    start = lines.index(HEREDOC_START) + 1
    end = lines.index("PY", start)
    path = os.path.join(into, "h.py")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines[start:end]) + "\n")
    return path


def helper(h: str, *args: str, env: dict | None = None):
    return subprocess.run([sys.executable, "-I", h, *args], capture_output=True, env=env,
                          cwd=os.path.dirname(h), timeout=60)


FIELDS = (("schema_version", "schema_version"), ("buddy_name", "buddy_name"), ("address", "address"),
          ("user.nominative", "user.nominative"), ("user.accusative", "user.accusative"),
          ("user.dative", "user.dative"), ("tone", "tone"))


def verdict(result) -> dict:
    if result.returncode == 0:
        return {"outcome": "accepted"}
    err = result.stderr.decode("utf-8", "replace").strip().splitlines()
    last = err[-1] if err else ""
    if last.startswith("persona: "):
        for needle, field in FIELDS:
            if last.startswith(f"persona: {needle} ") or last.startswith(f"persona: {needle}:"):
                return {"outcome": "refused", "field": field}
        raise SystemExit(f"unrecognized refusal: {last}")
    return {"outcome": "crashed", "error": last.split(":", 1)[0]}


def main(argv):
    installer, out = argv[1], argv[2]
    data = open(installer, "rb").read()
    if sha256_bytes(data) != INSTALLER_SHA256:
        raise SystemExit(f"{installer} is not buddy-install.sh {INSTALLER_VERSION} (sha256 {INSTALLER_SHA256})")
    work = tempfile.mkdtemp(prefix="buddy-goldens-")
    os.chmod(work, 0o700)
    h = extract_helper(installer, work)
    spec = importlib.util.spec_from_file_location("installer_helper", h)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def write_case(name: str, text: str) -> str:
        path = os.path.join(work, f"{name}.json")
        with open(path, "w", encoding="utf-8", errors="surrogatepass") as f:
            f.write(text)
        return path

    renders = []
    for case, p, locales in RENDER:
        source = write_case(case, text_of(p))
        check = helper(h, "persona-check", source)
        assert check.returncode == 0, (case, check.stderr)
        entry = {"id": case, "persona": p, "soul": {}}
        for locale in locales:
            target = os.path.join(work, f"{case}.{locale}.SOUL.md")
            r = helper(h, "soul-render", source, target, locale)
            assert r.returncode == 0 and r.stdout.strip() == b"changed", (case, locale, r.stderr)
            raw = open(target, "rb").read()
            entry["soul"][locale] = {"text": raw.decode("utf-8"), "sha256": sha256_bytes(raw),
                                     "mode": oct(stat.S_IMODE(os.stat(target).st_mode))}
        target = os.path.join(work, f"{case}.lazurio-acting-sender.conf")
        r = helper(h, "acting-dropin-render", source, target)
        assert r.returncode == 0, (case, r.stderr)
        raw = open(target, "rb").read()
        entry["actingDropin"] = {"text": raw.decode("utf-8"), "sha256": sha256_bytes(raw),
                                 "mode": oct(stat.S_IMODE(os.stat(target).st_mode))}
        renders.append(entry)

    checks = []
    for case, text in CHECK:
        source = write_case(case, text)
        result = verdict(helper(h, "persona-check", source))
        checks.append({"id": case, "text": text, **result})

    builds = []
    for case, values in BUILD:
        target = os.path.join(work, f"{case}.persona.json")
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), **values}
        r = helper(h, "persona-build", target, env=env)
        assert r.returncode == 0, (case, r.stderr)
        raw = open(target, "rb").read()
        builds.append({"id": case, "values": values, "text": raw.decode("utf-8"), "sha256": sha256_bytes(raw),
                       "mode": oct(stat.S_IMODE(os.stat(target).st_mode))})

    quoting = [{"value": value, "quoted": module.sd_env(value)} for value in SD_ENV]

    goldens = {
        "provenance": {
            "installer": "buddy-install.sh", "version": INSTALLER_VERSION, "sha256": INSTALLER_SHA256,
            "method": ("the installer's own helper (heredoc h.py) run as `python3 -I h.py persona-check | "
                       "soul-render | acting-dropin-render | persona-build` into real files, and its sd_env imported"),
            "generator": "tests/fixtures/buddy-persona/generate-goldens.py",
            "python": sys.version.split()[0], "unicode": unicodedata.unidata_version,
        },
        "render": renders, "check": checks, "build": builds, "sdEnv": quoting,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(goldens, f, ensure_ascii=True, indent=1)
        f.write("\n")
    print(f"{len(renders)} renders, {len(checks)} checks, {len(builds)} builds, {len(quoting)} quoting cases -> {out}")


if __name__ == "__main__":
    main(sys.argv)
