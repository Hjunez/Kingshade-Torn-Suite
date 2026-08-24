function slashPath(value: string): string {
  return value.replace(/\\/g, '/');
}

const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const FORBIDDEN_PATH_CHARACTER = /[:*?"<>|]/;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !containsControlCharacter(segment) &&
    !FORBIDDEN_PATH_CHARACTER.test(segment) &&
    !WINDOWS_DEVICE_NAME.test(segment)
  );
}

export function normalizeRelativeWorkerPath(value: string): string | null {
  const normalized = slashPath(value.trim());
  if (normalized.length === 0 || normalized.length > 500) {
    return null;
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return null;
  }

  const segments = normalized.split('/');
  if (
    segments.some((segment) => segment !== '' && segment !== '.' && !isSafePathSegment(segment))
  ) {
    return null;
  }

  const compact = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
  return compact.length === 0 ? '.' : compact;
}

export function isPathAllowed(candidate: string, allowedPaths: readonly string[]): boolean {
  const normalizedCandidate = normalizeRelativeWorkerPath(candidate);
  if (normalizedCandidate === null) {
    return false;
  }

  return allowedPaths.some((allowed) => {
    const normalizedAllowed = normalizeRelativeWorkerPath(allowed);
    if (normalizedAllowed === null) {
      return false;
    }
    if (normalizedAllowed === '.') {
      return true;
    }
    return (
      normalizedCandidate === normalizedAllowed ||
      normalizedCandidate.startsWith(`${normalizedAllowed}/`)
    );
  });
}
