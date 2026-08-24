import { isPathAllowed, normalizeRelativeWorkerPath } from './path-policy.js';

export interface PatchInspection {
  changedPaths: readonly string[];
  errors: readonly string[];
}

const MAX_PATCH_BYTES = 1_000_000;
const PATCH_PATH_PATTERN =
  /^(?:---|\+\+\+|rename from|rename to|copy from|copy to)\s+(?:(?:a|b)\/)?(.+)$/;

function extractPatchPath(line: string): string | null {
  const match = PATCH_PATH_PATTERN.exec(line);
  if (match === null) {
    return null;
  }
  const raw = match[1]?.trim();
  if (raw === undefined || raw === '/dev/null') {
    return null;
  }
  const tabIndex = raw.indexOf('\t');
  return tabIndex >= 0 ? raw.slice(0, tabIndex) : raw;
}

export function inspectPatch(patch: string, allowedPaths: readonly string[]): PatchInspection {
  const errors: string[] = [];
  const changedPaths = new Set<string>();

  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    errors.push('patch exceeds the 1000000-byte Worker limit');
  }
  if (patch.includes('\0')) {
    errors.push('patch contains a NUL byte');
  }

  const sections = patch.split(/^diff --git /m).slice(1);
  if (sections.length === 0) {
    errors.push('patch does not contain a Git diff section');
  }

  for (const [sectionIndex, section] of sections.entries()) {
    let sectionPaths = 0;
    for (const line of section.split(/\r?\n/).slice(1)) {
      const rawPath = extractPatchPath(line);
      if (rawPath === null) {
        continue;
      }
      sectionPaths += 1;
      const normalized = normalizeRelativeWorkerPath(rawPath);
      if (normalized === null) {
        errors.push(`patch path is invalid: ${rawPath}`);
        continue;
      }
      changedPaths.add(normalized);
      if (!isPathAllowed(normalized, allowedPaths)) {
        errors.push(`patch path is outside worker scope: ${normalized}`);
      }
    }
    if (sectionPaths === 0) {
      errors.push(`patch section ${String(sectionIndex + 1)} has no supported file path headers`);
    }
  }

  if (changedPaths.size === 0) {
    errors.push('patch does not contain any writable file paths');
  }

  return { changedPaths: [...changedPaths].sort(), errors: [...new Set(errors)] };
}
