import { isPathAllowed, normalizeRelativeWorkerPath } from './path-policy.js';

export interface PatchInspection {
  changedPaths: readonly string[];
  errors: readonly string[];
}

function extractPatchPath(line: string): string | null {
  const match = line.match(/^(?:---|\+\+\+|rename from|rename to)\s+(?:(?:a|b)\/)?(.+)$/);
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

  if (patch.includes('\0')) {
    errors.push('patch contains a NUL byte');
  }

  for (const line of patch.split(/\r?\n/)) {
    const rawPath = extractPatchPath(line);
    if (rawPath === null) {
      continue;
    }
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

  if (changedPaths.size === 0) {
    errors.push('patch does not contain any writable file paths');
  }

  return { changedPaths: [...changedPaths].sort(), errors };
}
