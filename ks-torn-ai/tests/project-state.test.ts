import { describe, expect, it } from 'vitest';

import {
  normalizeProjectKey,
  resolveProject,
  type ProjectDescriptor,
} from '../src/repository/project-state.js';

const projects: ProjectDescriptor[] = [
  {
    id: 'war-dibs',
    displayName: 'KS Torn War Dibs',
    aliases: ['Dibs', 'Live Dibs'],
    primaryFiles: ['KS_Torn_War_Dibs.user.js'],
    testProfiles: ['war-dibs-unit', 'war-dibs-browser'],
    platformTargets: ['torn_pda', 'mobile_browser', 'desktop_browser'],
  },
];

describe('project state resolution', () => {
  it('normalizes human project names deterministically', () => {
    expect(normalizeProjectKey(' KS Torn War Dibs ')).toBe('ks-torn-war-dibs');
  });

  it('resolves a project by alias without model inference', () => {
    expect(resolveProject(projects, 'Live Dibs')?.id).toBe('war-dibs');
  });

  it('returns null instead of guessing an unknown project', () => {
    expect(resolveProject(projects, 'market advisor')).toBeNull();
  });
});
