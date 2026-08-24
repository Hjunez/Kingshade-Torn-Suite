import type { GitCommitObservation } from './evidence-adapters.js';

export const MAX_HISTORY_COMMITS = 50;
export const MAX_COMMIT_MESSAGE_CHARS = 2_000;
export const MAX_SOURCE_CHUNK_LINES = 400;
export const MAX_SOURCE_CHUNK_BYTES = 120_000;
export const MAX_REPOSITORY_FILE_BYTES = 1_000_000;
export const MAX_GITHUB_RESPONSE_BYTES = 2_000_000;
export const MAX_COMPARE_FILES = 1_000;
export const MAX_REF_LENGTH = 255;

const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function isValidGitHubRepository(value: string): boolean {
  const parts = value.split('/');
  if (parts.length !== 2) {
    return false;
  }
  return parts.every(
    (part) =>
      part.length >= 1 &&
      part.length <= 100 &&
      part !== '.' &&
      part !== '..' &&
      REPOSITORY_COMPONENT_PATTERN.test(part),
  );
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:OPENAI_API_KEY|GITHUB_TOKEN|KS_LESLIE_GITHUB_TOKEN|TORN_API_KEY)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{12,}={0,2}['"]?/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{16,}={0,2}['"]?/gi,
];

export interface SecretRedactionResult {
  value: string;
  redactionCount: number;
}

export function redactRepositorySecrets(value: string): SecretRedactionResult {
  let redactionCount = 0;
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      redactionCount += 1;
      return '[REDACTED REPOSITORY SECRET]';
    });
  }
  return { value: redacted, redactionCount };
}

export function validateGitHubRepository(value: string): void {
  if (!isValidGitHubRepository(value)) {
    throw new Error('GitHub repository must be a safe owner/name identifier');
  }
}

export function isValidRepositoryRef(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > MAX_REF_LENGTH ||
    value !== value.trim() ||
    !REF_PATTERN.test(value) ||
    value.includes('..') ||
    value.includes('//') ||
    value.includes('@{') ||
    value.endsWith('/') ||
    value.endsWith('.') ||
    value.endsWith('.lock')
  ) {
    return false;
  }

  return value
    .split('/')
    .every(
      (segment) =>
        segment !== '.' &&
        segment !== '..' &&
        !segment.startsWith('.') &&
        !segment.endsWith('.') &&
        !segment.endsWith('.lock'),
    );
}

export function validateRepositoryRef(value: string): void {
  if (!isValidRepositoryRef(value)) {
    throw new Error(`Invalid repository ref: ${value}`);
  }
}

export function normalizeRepositoryPath(value: string): string | null {
  if (
    value.length < 1 ||
    value.length > 1_024 ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.startsWith('/')
  ) {
    return null;
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

export function validateHistoryLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_COMMITS) {
    throw new Error(`History limit must be between 1 and ${String(MAX_HISTORY_COMMITS)}`);
  }
}

function truncateCommitMessage(value: string): string {
  if (value.length <= MAX_COMMIT_MESSAGE_CHARS) {
    return value;
  }
  const marker = '\n[commit message truncated]';
  return `${value.slice(0, MAX_COMMIT_MESSAGE_CHARS - marker.length)}${marker}`;
}

export function normalizeCommitObservation(commit: GitCommitObservation): GitCommitObservation {
  if (commit.sha.length < 1 || commit.sha.length > 128) {
    throw new Error('Repository commit has an invalid SHA');
  }
  if (!Number.isFinite(Date.parse(commit.committedAt))) {
    throw new Error(`Repository commit has an invalid timestamp: ${commit.sha}`);
  }

  return {
    sha: commit.sha,
    message: truncateCommitMessage(redactRepositorySecrets(commit.message).value),
    committedAt: commit.committedAt,
  };
}
