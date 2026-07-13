#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -f VERSION ]] || fail "VERSION is missing."
VERSION="$(tr -d '[:space:]' < VERSION)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "VERSION is not valid semantic versioning: $VERSION"

SCOUT="Kingshade_Scout_Torn_PDA_v${VERSION}.user.js"
WAR="KS_War_Tools_Torn_PDA_v${VERSION}.user.js"
BOOT="Kingshades_Bootlegging_Clean_v4.1.1.user.js"

[[ -f "$SCOUT" ]] || fail "Missing $SCOUT"
[[ -f "$WAR" ]] || fail "Missing $WAR"
[[ -f "$BOOT" ]] || fail "Missing standalone Bootlegging script: $BOOT"

grep -Eq "^// @version[[:space:]]+${VERSION}$" "$SCOUT" || fail "Scout metadata version does not match VERSION."
grep -Eq "^// @version[[:space:]]+${VERSION}$" "$WAR" || fail "War Tools metadata version does not match VERSION."
grep -q "$VERSION" README.md || fail "README does not mention Suite version $VERSION."
grep -q "$VERSION" CHANGELOG.md || fail "CHANGELOG does not mention Suite version $VERSION."

shopt -s nullglob
for file in Kingshade_Scout_Torn_PDA*.user.js; do
  [[ "$file" == "$SCOUT" ]] || fail "Unexpected Scout copy in repository root: $file"
done
for file in KS_War_Tools_Torn_PDA*.user.js; do
  [[ "$file" == "$WAR" ]] || fail "Unexpected War Tools copy in repository root: $file"
done

forbidden=(TEST_NOTES_v*.txt KS_Status_Diagnostics*.user.js *.zip)
for pattern in "${forbidden[@]}"; do
  matches=( $pattern )
  ((${#matches[@]} == 0)) || fail "Forbidden temporary/release file in repository root: ${matches[*]}"
done

printf 'Kingshade Suite %s validation passed.\n' "$VERSION"
