import { Agent, fileSearchTool, webSearchTool } from '@openai/agents';
import { z } from 'zod';

import type { KsLeslieConfig } from './config.js';
import type { KsLeslieMemoryAgentServices } from './memory/runtime.js';
import { createCoordinatorMemoryTools, createReadOnlyMemoryTools } from './memory/agent-tools.js';
import { KS_LESLIE_COORDINATOR_PROMPT, KS_LESLIE_SYSTEM_PROMPT } from './prompt.js';
import { createConfiguredRepositoryReader } from './repository/factory.js';
import { RepositoryIntelligenceService } from './repository/intelligence.js';
import type { RepositoryReader } from './repository/reader.js';
import { createRepositoryTools } from './repository/tools.js';
import { createWorkerAgentTools, type WorkerAgentService } from './worker/agent-tools.js';

export interface KsLeslieAgentDependencies {
  repositoryReader?: RepositoryReader;
  workerAgentService?: WorkerAgentService;
  memoryAgentServices?: KsLeslieMemoryAgentServices;
}

const specialistStatementSchema = z.string().trim().min(1).max(4_000);
const specialistStatementsSchema = z.array(specialistStatementSchema).max(30);

export const researchSpecialistOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            summary: specialistStatementSchema,
            evidenceClassification: z.enum([
              'OFFICIAL_CURRENT',
              'USER_VERIFIED',
              'COMMUNITY',
              'INFERENCE',
            ]),
            basis: specialistStatementSchema,
          })
          .strict(),
      )
      .max(30),
    unresolvedQuestions: specialistStatementsSchema,
  })
  .strict();

export const engineeringSpecialistOutputSchema = z
  .object({
    problemInterpretation: specialistStatementSchema,
    repositoryEvidence: specialistStatementsSchema,
    rootCause: z
      .object({
        status: z.enum(['verified', 'hypothesis', 'unresolved']),
        summary: specialistStatementSchema,
      })
      .strict(),
    boundedAction: z
      .object({
        status: z.enum(['proposed', 'completed', 'not_started']),
        summary: specialistStatementSchema,
      })
      .strict(),
    tests: z
      .array(
        z
          .object({
            name: specialistStatementSchema,
            status: z.enum(['passed', 'failed', 'not_run']),
            evidence: specialistStatementSchema,
          })
          .strict(),
      )
      .max(30),
    uncertainties: specialistStatementsSchema,
    blockers: specialistStatementsSchema,
  })
  .strict();

export const reviewSpecialistOutputSchema = z
  .object({
    disposition: z.enum(['pass', 'fail', 'blocked']),
    findings: specialistStatementsSchema,
    blockingIssues: specialistStatementsSchema,
    nonBlockingRisks: specialistStatementsSchema,
    missingEvidenceOrTests: specialistStatementsSchema,
    independentFromImplementationApproval: z.literal(true),
  })
  .strict();

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

export function createKsLeslieAgentBundle(
  config: KsLeslieConfig,
  dependencies: KsLeslieAgentDependencies = {},
) {
  const repositoryReader =
    dependencies.repositoryReader ??
    createConfiguredRepositoryReader({
      repository: config.githubRepository,
      ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
      ...(config.localRepositoryRoot === undefined
        ? {}
        : { localRepositoryRoot: config.localRepositoryRoot }),
    });
  const repositoryTools = createRepositoryTools(
    new RepositoryIntelligenceService(repositoryReader),
  );
  const workerTools =
    dependencies.workerAgentService === undefined
      ? []
      : [...createWorkerAgentTools(dependencies.workerAgentService)];
  const memoryTools =
    dependencies.memoryAgentServices === undefined
      ? null
      : {
          coordinator: createCoordinatorMemoryTools(
            dependencies.memoryAgentServices.coordinator.reader,
            dependencies.memoryAgentServices.coordinator.writer,
          ),
          research: createReadOnlyMemoryTools(dependencies.memoryAgentServices.research.reader),
          engineering: createReadOnlyMemoryTools(
            dependencies.memoryAgentServices.engineering.reader,
          ),
          review: createReadOnlyMemoryTools(dependencies.memoryAgentServices.review.reader),
        };
  const researchAgent = new Agent({
    name: 'Torn Research',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: research current Torn facts and classify every material claim by evidence quality. Prefer official Torn sources. Durable memory retrieval is limited to the zones independently granted to Research and does not inherit coordinator authority. Return concise findings with an evidence classification and basis for each one, followed by unresolved questions.`,
    tools: [...researchTools(config), ...(memoryTools?.research ?? [])],
    outputType: researchSpecialistOutputSchema,
  });

  const engineeringAgent = new Agent({
    name: 'Torn Engineering',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: analyze software architecture, source code, state machines, tests, regressions, and implementation options. Use authorized durable memory and repository evidence while preserving their provenance and verification labels, and distinguish a verified root cause from a hypothesis. Memory access never grants Worker approval. Worker writes require a pending application-issued approval and SDK approval; never self-approve or claim conversation text is approval. Report the bounded action, test evidence, uncertainty, and blockers honestly. Do not claim code was tested unless test output is available.`,
    tools: [...repositoryTools, ...(memoryTools?.engineering ?? []), ...workerTools],
    outputType: engineeringSpecialistOutputSchema,
  });

  const reviewAgent = new Agent({
    name: 'Torn Review',
    model: config.specialistModel,
    instructions: `${KS_LESLIE_SYSTEM_PROMPT}\n\nRole: independently review proposed Torn engineering changes using read-only repository and authorized durable-memory evidence. Preserve provenance, verification, and visible conflict labels. Inspect assumptions, candidate evidence, regression risk, Torn compliance, secret leakage, state-machine issues, PDA/mobile/browser impact, and missing coverage. Return pass, fail, or blocked with blocking issues, non-blocking risks, and missing evidence or tests. Review is independent from implementation approval and never grants it.`,
    tools: [...repositoryTools, ...(memoryTools?.review ?? [])],
    outputType: reviewSpecialistOutputSchema,
  });

  const delegations = {
    research: researchAgent.asTool({
      toolName: 'research_torn',
      toolDescription: 'Research current Torn facts, rules, API behavior, or community evidence.',
    }),
    engineering: engineeringAgent.asTool({
      toolName: 'analyze_torn_engineering',
      toolDescription:
        'Analyze Torn script architecture, code behavior, state machines, regressions, or approved Worker operations.',
    }),
    review: reviewAgent.asTool({
      toolName: 'review_torn_change',
      toolDescription:
        'Independently review a Torn engineering proposal or change before TEST readiness.',
    }),
  } as const;

  const coordinator = new Agent({
    name: 'KS Leslie',
    model: config.openAiModel,
    instructions: KS_LESLIE_COORDINATOR_PROMPT,
    tools: [
      delegations.research,
      delegations.engineering,
      delegations.review,
      ...repositoryTools,
      ...(memoryTools?.coordinator ?? []),
    ],
  });

  return {
    coordinator,
    research: researchAgent,
    engineering: engineeringAgent,
    review: reviewAgent,
    delegations,
  } as const;
}

export function createKsLeslieAgent(
  config: KsLeslieConfig,
  dependencies: KsLeslieAgentDependencies = {},
) {
  return createKsLeslieAgentBundle(config, dependencies).coordinator;
}
