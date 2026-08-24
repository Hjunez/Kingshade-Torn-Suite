import { Agent, fileSearchTool, webSearchTool } from '@openai/agents';

import type { KsLeslieConfig } from './config.js';
import { KS_LESLIE_SYSTEM_PROMPT } from './prompt.js';

function researchTools(config: KsLeslieConfig) {
  const tools = [webSearchTool({ searchContextSize: 'medium' })];

  if (config.vectorStoreId !== undefined) {
    tools.push(
      fileSearchTool(config.vectorStoreId, {
        maxNumResults: 8,
        includeSearchResults: true,
      }),
    );
  }

  return tools;
}

export function createKsLeslieAgent(config: KsLeslieConfig) {
  const researchAgent = new Agent({
    name: 'Torn Research',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: research current Torn facts and classify every material claim by evidence quality. Prefer official Torn sources.`,
    tools: researchTools(config),
  });

  const engineeringAgent = new Agent({
    name: 'Torn Engineering',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: analyze software architecture, source code, state machines, tests, regressions, and implementation options. Do not claim code was tested unless test output is available.`,
  });

  const reviewAgent = new Agent({
    name: 'Torn Review',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: independently review proposed Torn engineering changes for regressions, unsupported assumptions, Torn compliance, secret leakage, PDA compatibility, and missing tests.`,
  });

  return new Agent({
    name: 'KS Leslie',
    model: config.openAiModel,
    instructions: KS_LESLIE_SYSTEM_PROMPT,
    tools: [
      researchAgent.asTool({
        toolName: 'research_torn',
        toolDescription: 'Research current Torn facts, rules, API behavior, or community evidence.',
      }),
      engineeringAgent.asTool({
        toolName: 'analyze_torn_engineering',
        toolDescription:
          'Analyze Torn script architecture, code behavior, state machines, or regressions.',
      }),
      reviewAgent.asTool({
        toolName: 'review_torn_change',
        toolDescription:
          'Independently review a Torn engineering proposal or change before release.',
      }),
    ],
  });
}
