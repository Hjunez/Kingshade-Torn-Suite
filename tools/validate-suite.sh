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
SCOUT_STABLE="Kingshade_Scout_Torn_PDA.user.js"
WAR_STABLE="KS_War_Tools_Torn_PDA.user.js"
SCOUT_LEGACY="Kingshade_Scout_Torn_PDA_v0.8.5.user.js"
WAR_LEGACY="KS_War_Tools_Torn_PDA_v0.8.5.user.js"
BOOT="Kingshades_Bootlegging_Clean_v4.1.1.user.js"

for f in "$SCOUT" "$WAR" "$SCOUT_STABLE" "$WAR_STABLE" "$SCOUT_LEGACY" "$WAR_LEGACY" "$BOOT"; do
  [[ -f "$f" ]] || fail "Missing required file: $f"
done

for f in "$SCOUT" "$WAR" "$SCOUT_STABLE" "$WAR_STABLE" "$SCOUT_LEGACY" "$WAR_LEGACY"; do
  grep -Eq "^// @version[[:space:]]+${VERSION}$" "$f" || fail "$f metadata version does not match VERSION."
  node --check "$f" >/dev/null || fail "$f failed JavaScript syntax check."
done

SCOUT_URL="https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/${SCOUT_STABLE}"
WAR_URL="https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/${WAR_STABLE}"
for f in "$SCOUT" "$SCOUT_STABLE" "$SCOUT_LEGACY"; do
  grep -Fq "// @updateURL    ${SCOUT_URL}" "$f" || fail "$f has wrong/missing Scout @updateURL."
  grep -Fq "// @downloadURL  ${SCOUT_URL}" "$f" || fail "$f has wrong/missing Scout @downloadURL."
done
for f in "$WAR" "$WAR_STABLE" "$WAR_LEGACY"; do
  grep -Fq "// @updateURL    ${WAR_URL}" "$f" || fail "$f has wrong/missing War Tools @updateURL."
  grep -Fq "// @downloadURL  ${WAR_URL}" "$f" || fail "$f has wrong/missing War Tools @downloadURL."
done

cmp -s "$SCOUT" "$SCOUT_STABLE" || fail "Stable Scout endpoint differs from current release."
cmp -s "$WAR" "$WAR_STABLE" || fail "Stable War Tools endpoint differs from current release."
cmp -s "$SCOUT" "$SCOUT_LEGACY" || fail "Legacy v0.8.5 Scout migration endpoint differs from current release."
cmp -s "$WAR" "$WAR_LEGACY" || fail "Legacy v0.8.5 War Tools migration endpoint differs from current release."

grep -q "$VERSION" README.md || fail "README does not mention Suite version $VERSION."
grep -q "$VERSION" CHANGELOG.md || fail "CHANGELOG does not mention Suite version $VERSION."

# Preserve published historical versioned URLs without confusing them with the current release.
shopt -s nullglob
for file in Kingshade_Scout_Torn_PDA_v*.user.js; do
  [[ "$file" == "$SCOUT" || "$file" == "$SCOUT_LEGACY" ]] && continue
  hist="${file#Kingshade_Scout_Torn_PDA_v}"
  hist="${hist%.user.js}"
  [[ "$hist" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unexpected Scout copy in repository root: $file"
  grep -Eq "^// @version[[:space:]]+${hist}$" "$file" || fail "$file metadata does not match historical filename."
  grep -Fq "// @updateURL    ${SCOUT_URL}" "$file" || fail "$file historical Scout @updateURL drifted."
  grep -Fq "// @downloadURL  ${SCOUT_URL}" "$file" || fail "$file historical Scout @downloadURL drifted."
  node --check "$file" >/dev/null || fail "$file failed JavaScript syntax check."
done
for file in KS_War_Tools_Torn_PDA_v*.user.js; do
  [[ "$file" == "$WAR" || "$file" == "$WAR_LEGACY" ]] && continue
  hist="${file#KS_War_Tools_Torn_PDA_v}"
  hist="${hist%.user.js}"
  [[ "$hist" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Unexpected War Tools copy in repository root: $file"
  grep -Eq "^// @version[[:space:]]+${hist}$" "$file" || fail "$file metadata does not match historical filename."
  grep -Fq "// @updateURL    ${WAR_URL}" "$file" || fail "$file historical War Tools @updateURL drifted."
  grep -Fq "// @downloadURL  ${WAR_URL}" "$file" || fail "$file historical War Tools @downloadURL drifted."
  node --check "$file" >/dev/null || fail "$file failed JavaScript syntax check."
done

forbidden=(TEST_NOTES_v*.txt KS_Status_Diagnostics*.user.js *.zip)
for pattern in "${forbidden[@]}"; do
  matches=( $pattern )
  ((${#matches[@]} == 0)) || fail "Forbidden temporary/release file in repository root: ${matches[*]}"
done

printf 'Kingshade Suite %s validation passed, including stable, legacy migration and historical release channels.\n' "$VERSION"
