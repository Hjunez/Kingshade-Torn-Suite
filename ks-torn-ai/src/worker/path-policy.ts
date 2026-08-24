function slashPath(value: string): string {
  return value.replace(/\\/g, '/');
}

export function normalizeRelativeWorkerPath(value: string): string | null {
  const normalized = slashPath(value.trim());
  if (normalized.length === 0 || normalized.includes('\0')) {
    return null;
  }
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
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
      normalizedCandidate === normalizedAllowed || normalizedCandidate.startsWith(`${normalizedAllowed}/`)
    );
  });
}
