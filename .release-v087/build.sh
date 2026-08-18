#!/usr/bin/env bash
set -euo pipefail

SCOUT="Kingshade_Scout_Torn_PDA.user.js"
WAR="KS_War_Tools_Torn_PDA.user.js"
SCOUT_URL="https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/Kingshade_Scout_Torn_PDA.user.js"
WAR_URL="https://raw.githubusercontent.com/Hjunez/Kingshade-Torn-Suite/main/KS_War_Tools_Torn_PDA.user.js"

# Prove the patches are being applied to the verified public v0.8.6 baseline.
[[ "$(git hash-object "$SCOUT")" == "91b038ba3359cb74d305ee812f94c2dad231b8af" ]]
[[ "$(git hash-object "$WAR")" == "86b59fa71206f234811dc0329055ac0f9091ff32" ]]

git apply .release-v087/scout.patch
git apply .release-v087/war.patch

# Exact release-candidate hashes verified locally before publication.
echo '8f67611f24a94e72f5ce4ffd7dbf31e2ecd84c01be6fabd134bd14afe7e8438d  Kingshade_Scout_Torn_PDA.user.js' | sha256sum -c -
echo '8bc81e2c765b84906fb60b047a182557020814865e7c373acdf53d9c488cb050  KS_War_Tools_Torn_PDA.user.js' | sha256sum -c -
node --check "$SCOUT"
node --check "$WAR"

# Current release snapshot + permanent v0.8.5 migration endpoints.
cp "$SCOUT" Kingshade_Scout_Torn_PDA_v0.8.7.user.js
cp "$WAR" KS_War_Tools_Torn_PDA_v0.8.7.user.js
cp "$SCOUT" Kingshade_Scout_Torn_PDA_v0.8.5.user.js
cp "$WAR" KS_War_Tools_Torn_PDA_v0.8.5.user.js
printf '0.8.7\n' > VERSION

# README current-version references. Historical v0.8.6 snapshot files remain untouched.
python3 - <<'PY'
from pathlib import Path
p = Path('README.md')
s = p.read_text()
s = s.replace('Kingshade Suite-0.8.6-green', 'Kingshade Suite-0.8.7-green')
s = s.replace('## Kingshade Suite 0.8.6', '## Kingshade Suite 0.8.7')
s = s.replace('### Kingshade Scout 0.8.6', '### Kingshade Scout 0.8.7')
s = s.replace('### KS War Tools 0.8.6', '### KS War Tools 0.8.7')
s = s.replace('Kingshade_Scout_Torn_PDA_v0.8.6.user.js', 'Kingshade_Scout_Torn_PDA_v0.8.7.user.js')
s = s.replace('KS_War_Tools_Torn_PDA_v0.8.6.user.js', 'KS_War_Tools_Torn_PDA_v0.8.7.user.js')
s = s.replace('display version **0.8.6**', 'display version **0.8.7**')
p.write_text(s)

p = Path('CHANGELOG.md')
s = p.read_text()
marker = 'All notable changes to Kingshade Suite are documented here.\n\n'
entry = '''## [0.8.7] — 2026-08-18 — Release\n\n### War Tools timer synchronization\n\n- Exact Hospital, Jail and Federal countdowns now use Torn's visible TCT clock second as their phase source instead of the device/browser clock.\n- Exact timer updates are driven directly by the visible TCT clock DOM transition, with a guarded fallback/reconnect loop.\n- Exact countdowns continue to update while scrolling; travel estimates remain explicitly separate from exact status timers.\n- Removed the previously observed early/late phase error that was operationally significant near hospital release.\n\n### Validation\n\n- Device diagnostics verified that `window.getCurrentTimestamp()` leads Torn's visible TCT clock by about 500 ms on the tested Torn PDA environment, so it is not used as the exact-timer phase source.\n- Torn PDA regression video 12195 verified stable exact HOSP countdown rate through list scrolling.\n- Torn PDA expiry video 12354 verified `0m02s` at TCT `08:41:06`, `0m01s` at `08:41:07`, and timer expiry at `08:41:08` without advancing early. The row refreshed/reordered shortly after expiry; the video did not directly prove an attack-screen transition.\n- Scout has no functional behavior change in 0.8.7 beyond synchronized Suite version identity.\n- Release candidates passed JavaScript syntax checks and exact SHA-256 verification before publication.\n\n'''
if '## [0.8.7]' not in s:
    s = s.replace(marker, marker + entry, 1)
p.write_text(s)

p = Path('docs/RELEASE_PROCESS.md')
s = p.read_text()
s = s.replace('2. Rename both userscript files to include the same version.', '2. Create new versioned release snapshots for both scripts with the same version; retain older published versioned snapshots as immutable historical URLs.')
s = s.replace('- Duplicate userscript copies', '- Temporary duplicate userscript copies (published historical versioned snapshots are allowed)')
needle = '- The legacy v0.8.5 endpoint filenames remain present and byte-identical to the current release so existing v0.8.5 installations can migrate through Torn PDA\'s Update action.\n'
addition = '- Older published versioned release snapshots may remain for link stability; their embedded `@version` must match their filename and their updater metadata must still point to the permanent stable endpoint.\n- After the new stable files reach `main`, verify the real Torn PDA Update flow from the previous public version to the new version before marking the updater migration gate complete.\n'
if addition not in s:
    s = s.replace(needle, needle + addition)
p.write_text(s)
PY

# Harden release validation while preserving historical public versioned URLs.
cat > tools/validate-suite.sh <<'EOF'
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
EOF
chmod +x tools/validate-suite.sh

# Release-gate assertions.
for f in "$SCOUT" Kingshade_Scout_Torn_PDA_v0.8.7.user.js Kingshade_Scout_Torn_PDA_v0.8.5.user.js; do
  grep -Fq '// @version      0.8.7' "$f"
  grep -Fq "// @updateURL    ${SCOUT_URL}" "$f"
  grep -Fq "// @downloadURL  ${SCOUT_URL}" "$f"
done
for f in "$WAR" KS_War_Tools_Torn_PDA_v0.8.7.user.js KS_War_Tools_Torn_PDA_v0.8.5.user.js; do
  grep -Fq '// @version      0.8.7' "$f"
  grep -Fq "// @updateURL    ${WAR_URL}" "$f"
  grep -Fq "// @downloadURL  ${WAR_URL}" "$f"
done
cmp -s "$SCOUT" Kingshade_Scout_Torn_PDA_v0.8.7.user.js
cmp -s "$SCOUT" Kingshade_Scout_Torn_PDA_v0.8.5.user.js
cmp -s "$WAR" KS_War_Tools_Torn_PDA_v0.8.7.user.js
cmp -s "$WAR" KS_War_Tools_Torn_PDA_v0.8.5.user.js
bash tools/validate-suite.sh

# Remove one-shot release staging from the final PR.
git rm -rf .release-v087 .github/workflows/build-suite-v087-release.yml

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add VERSION README.md CHANGELOG.md docs/RELEASE_PROCESS.md tools/validate-suite.sh \
  Kingshade_Scout_Torn_PDA.user.js Kingshade_Scout_Torn_PDA_v0.8.5.user.js Kingshade_Scout_Torn_PDA_v0.8.7.user.js \
  KS_War_Tools_Torn_PDA.user.js KS_War_Tools_Torn_PDA_v0.8.5.user.js KS_War_Tools_Torn_PDA_v0.8.7.user.js

git commit -m 'Release Kingshade Suite v0.8.7 timer synchronization'
git push origin HEAD:release/v0.8.7
