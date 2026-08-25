export const SYNTHETIC_DEBUG_BASELINE_MODES = ['KNOWN_GOOD', 'DEFECT_REFERENCE'] as const;

export type SyntheticDebugBaselineMode = (typeof SYNTHETIC_DEBUG_BASELINE_MODES)[number];

export function resolvedSyntheticDebugBaselineMode(
  mode: SyntheticDebugBaselineMode | undefined,
): SyntheticDebugBaselineMode {
  return mode ?? 'KNOWN_GOOD';
}
