export interface TestProfileStep {
  executable: string;
  args: readonly string[];
  workingDirectory: string;
  timeoutMs: number;
}

export interface TestProfile {
  id: string;
  purpose: string;
  steps: readonly TestProfileStep[];
}

export const KS_LESLIE_TEST_PROFILES: readonly TestProfile[] = [
  {
    id: 'suite-layout',
    purpose: 'Validate Kingshade Suite versions and repository layout using the repository-owned validator.',
    steps: [
      {
        executable: 'bash',
        args: ['tools/validate-suite.sh'],
        workingDirectory: '.',
        timeoutMs: 60_000,
      },
    ],
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
