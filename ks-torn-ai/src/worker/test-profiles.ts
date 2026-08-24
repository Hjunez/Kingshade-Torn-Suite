export type TestProfileExecutable = 'bash' | 'node' | 'npm';

export interface TestProfileStep {
  executable: TestProfileExecutable;
  args: readonly string[];
  workingDirectory: string;
  timeoutMs: number;
}

interface TestProfileBase {
  id: string;
  purpose: string;
  source: string;
}

export interface AvailableTestProfile extends TestProfileBase {
  availability: 'available';
  steps: readonly TestProfileStep[];
}

export interface UnavailableTestProfile extends TestProfileBase {
  availability: 'unavailable';
  steps: readonly [];
  blocker: string;
}

export type TestProfile = AvailableTestProfile | UnavailableTestProfile;

const LESLIE_LOCKED_INSTALL: TestProfileStep = {
  executable: 'npm',
  args: ['ci', '--ignore-scripts'],
  workingDirectory: 'ks-torn-ai',
  timeoutMs: 300_000,
};

export const KS_LESLIE_TEST_PROFILES: readonly TestProfile[] = [
  {
    id: 'suite-layout',
    purpose:
      'Validate Kingshade Suite versions and repository layout using the repository-owned validator.',
    source: 'tools/run-suite-validator.mjs at the current Leslie remote branch',
    availability: 'available',
    steps: [
      {
        executable: 'node',
        args: ['tools/run-suite-validator.mjs'],
        workingDirectory: '.',
        timeoutMs: 60_000,
      },
    ],
  },
  {
    id: 'leslie-typecheck',
    purpose: 'Run the repository-owned strict TypeScript check for KS Leslie.',
    source: 'ks-torn-ai/package.json at the current Leslie remote branch',
    availability: 'available',
    steps: [
      LESLIE_LOCKED_INSTALL,
      {
        executable: 'npm',
        args: ['run', 'typecheck'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 120_000,
      },
    ],
  },
  {
    id: 'leslie-tests',
    purpose: 'Run the repository-owned deterministic KS Leslie Vitest suite.',
    source: 'ks-torn-ai/package.json at the current Leslie remote branch',
    availability: 'available',
    steps: [
      LESLIE_LOCKED_INSTALL,
      {
        executable: 'npm',
        args: ['test'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 180_000,
      },
    ],
  },
  {
    id: 'leslie-lint',
    purpose: 'Run the repository-owned strict ESLint gate for KS Leslie.',
    source: 'ks-torn-ai/package.json at the current Leslie remote branch',
    availability: 'available',
    steps: [
      LESLIE_LOCKED_INSTALL,
      {
        executable: 'npm',
        args: ['run', 'lint'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 120_000,
      },
    ],
  },
  {
    id: 'leslie-format',
    purpose: 'Run the repository-owned Prettier check for KS Leslie.',
    source: 'ks-torn-ai/package.json at the current Leslie remote branch',
    availability: 'available',
    steps: [
      LESLIE_LOCKED_INSTALL,
      {
        executable: 'npm',
        args: ['run', 'format'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 120_000,
      },
    ],
  },
  {
    id: 'leslie-verify',
    purpose: 'Run every repository-owned KS Leslie verification gate.',
    source: 'ks-torn-ai/package.json at the current Leslie remote branch',
    availability: 'available',
    steps: [
      LESLIE_LOCKED_INSTALL,
      {
        executable: 'npm',
        args: ['run', 'verify'],
        workingDirectory: 'ks-torn-ai',
        timeoutMs: 300_000,
      },
    ],
  },
  {
    id: 'userscript-syntax',
    purpose: 'Run a repository-owned userscript syntax profile.',
    source: 'tools/check-js-syntax.mjs at the current Leslie remote branch',
    availability: 'available',
    steps: [
      {
        executable: 'node',
        args: ['tools/check-js-syntax.mjs'],
        workingDirectory: '.',
        timeoutMs: 120_000,
      },
    ],
  },
  {
    id: 'kingshade-development-verify',
    purpose: 'Run the historical root Vitest, jsdom, Playwright, lint, and typecheck stack.',
    source: 'local-only commits d8ed012 and b5dc756',
    availability: 'unavailable',
    steps: [],
    blocker:
      'The commits are not on a remote branch and their LF checkout fails 15 of 20 integrity tests against CRLF fixture hashes.',
  },
  {
    id: 'war-dibs-desktop',
    purpose: 'Run the historical War Dibs desktop Chromium and Chrome regressions.',
    source: 'local-only commit 32e57b2',
    availability: 'unavailable',
    steps: [],
    blocker:
      'The commit is not on a remote branch and intentionally records red production-baseline regressions.',
  },
  {
    id: 'war-dibs-arena-smoke',
    purpose: 'Run the historical bounded offline War Dibs arena smoke profile.',
    source: 'local-only commit c4e34e0',
    availability: 'unavailable',
    steps: [],
    blocker:
      'The commit is not on a remote branch and depends on the intentionally red desktop harness.',
  },
  {
    id: 'war-dibs-compatibility',
    purpose: 'Run the historical War Dibs extension compatibility profiles.',
    source: 'local-only commit c4e34e0',
    availability: 'unavailable',
    steps: [],
    blocker:
      'The commit is not on a remote branch and depends on the intentionally red desktop harness.',
  },
];

export function resolveTestProfile(
  profiles: readonly TestProfile[],
  profileId: string,
): TestProfile | null {
  const matches = profiles.filter((profile) => profile.id === profileId);
  if (matches.length > 1) {
    throw new Error(`Duplicate test profile id: ${profileId}`);
  }
  return matches[0] ?? null;
}

export function requireAvailableTestProfile(
  profiles: readonly TestProfile[],
  profileId: string,
): AvailableTestProfile {
  const profile = resolveTestProfile(profiles, profileId);
  if (profile === null) {
    throw new Error(`unknown test profile: ${profileId}`);
  }
  if (profile.availability === 'unavailable') {
    throw new Error(`test profile ${profileId} is unavailable: ${profile.blocker}`);
  }
  return profile;
}

export function validateTestProfileReferences(
  profiles: readonly TestProfile[],
  referencedIds: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      errors.push(`duplicate test profile id: ${profile.id}`);
    }
    ids.add(profile.id);
    if (profile.availability === 'available' && profile.steps.length === 0) {
      errors.push(`available test profile has no steps: ${profile.id}`);
    }
  }
  for (const id of referencedIds) {
    const profile = profiles.find((candidate) => candidate.id === id);
    if (profile === undefined) {
      errors.push(`referenced test profile is not registered: ${id}`);
    } else if (profile.availability === 'unavailable') {
      errors.push(`referenced test profile is unavailable: ${id}`);
    }
  }
  return errors;
}
