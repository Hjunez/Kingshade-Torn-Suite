import type { ProjectDescriptor } from './project-state.js';

export const KINGSHADE_PROJECTS: readonly ProjectDescriptor[] = [
  {
    id: 'war-dibs',
    displayName: 'KS Torn War Dibs',
    aliases: ['War Dibs', 'Live Dibs', 'Dibs'],
    primaryFiles: ['KS_Torn_War_Dibs.user.js'],
    testProfiles: ['suite-layout', 'userscript-syntax'],
    platformTargets: ['torn_pda', 'mobile_browser', 'desktop_browser'],
  },
  {
    id: 'ffscouter-call-guard',
    displayName: 'KS FFScouter Call Guard',
    aliases: ['FFScouter Call Guard', 'Call Guard'],
    primaryFiles: ['KS_FFScouter_Call_Guard.user.js'],
    testProfiles: ['suite-layout', 'userscript-syntax'],
    platformTargets: ['torn_pda', 'mobile_browser', 'desktop_browser'],
  },
  {
    id: 'war-tools',
    displayName: 'KS War Tools',
    aliases: ['War Tools', 'KS War Tools for Torn PDA'],
    primaryFiles: ['KS_War_Tools_Torn_PDA.user.js'],
    testProfiles: ['suite-layout', 'userscript-syntax'],
    platformTargets: ['torn_pda', 'mobile_browser', 'desktop_browser'],
  },
  {
    id: 'scout',
    displayName: 'Kingshade Scout',
    aliases: ['Scout', 'KS Scout', 'Scout Core'],
    primaryFiles: ['Kingshade_Scout_Torn_PDA.user.js'],
    testProfiles: ['suite-layout', 'userscript-syntax'],
    platformTargets: ['torn_pda', 'mobile_browser', 'desktop_browser'],
  },
];
