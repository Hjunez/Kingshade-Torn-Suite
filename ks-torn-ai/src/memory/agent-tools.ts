import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';

import {
  evidenceClassificationSchema,
  knowledgeZoneSchema,
  memoryProjectIdSchema,
  memoryRecordIdSchema,
  memoryRecordKindSchema,
  verificationStateSchema,
} from './model.js';
import {
  MAX_MEMORY_RETRIEVAL_RESULTS,
  MAX_RETRIEVED_CONTENT_CHARS,
  MAX_RETRIEVED_SOURCE_CHARS,
  AuthorizedMemoryReader,
  PendingMemoryWriter,
  memoryRetrievalRequestSchema,
  pendingMemoryProposalSchema,
} from './service.js';

export const MEMORY_RETRIEVAL_TOOL_NAME = 'retrieve_authorized_memory' as const;
export const MEMORY_PROPOSAL_TOOL_NAME = 'propose_durable_memory' as const;

export const retrieveAuthorizedMemoryInputSchema = memoryRetrievalRequestSchema;
export const proposeDurableMemoryInputSchema = pendingMemoryProposalSchema;

const retrievedMemoryRecordSchema = z
  .object({
    id: memoryRecordIdSchema,
    projectId: memoryProjectIdSchema,
    kind: memoryRecordKindSchema,
    zone: knowledgeZoneSchema,
    subject: z.string().max(240),
    content: z.string().max(MAX_RETRIEVED_CONTENT_CHARS),
    evidenceClassification: evidenceClassificationSchema,
    verificationState: verificationStateSchema,
    sourceReference: z.string().max(MAX_RETRIEVED_SOURCE_CHARS),
    sourceDescription: z.string().max(MAX_RETRIEVED_SOURCE_CHARS),
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
    lifecycleStatus: z.literal('ACTIVE'),
    supersedesRecordId: memoryRecordIdSchema.nullable(),
    conflictingRecordIds: z.array(memoryRecordIdSchema).max(20),
    relevanceScore: z.number().int().nonnegative(),
  })
  .strict();

const memoryRetrievalOutputSchema = z
  .object({
    status: z.enum(['ok', 'error']),
    errorCode: z.enum(['NONE', 'OPERATION_FAILED']),
    authorizationAppliedBeforeRanking: z.literal(true),
    records: z.array(retrievedMemoryRecordSchema).max(MAX_MEMORY_RETRIEVAL_RESULTS),
    truncated: z.boolean(),
  })
  .strict();

const pendingMemoryProposalOutputSchema = z
  .object({
    status: z.enum(['pending_review', 'rejected']),
    proposalId: memoryRecordIdSchema.nullable(),
    projectId: memoryProjectIdSchema.nullable(),
    zone: knowledgeZoneSchema.nullable(),
    evidenceClassification: z.literal('INFERENCE_HYPOTHESIS'),
    verificationState: z.literal('HYPOTHESIS'),
    lifecycleStatus: z.literal('PENDING'),
    duplicateOfRecordId: memoryRecordIdSchema.nullable(),
  })
  .strict();

function memoryReadError() {
  return {
    status: 'error' as const,
    errorCode: 'OPERATION_FAILED' as const,
    authorizationAppliedBeforeRanking: true as const,
    records: [],
    truncated: false,
  };
}

function memoryProposalError() {
  return {
    status: 'rejected' as const,
    proposalId: null,
    projectId: null,
    zone: null,
    evidenceClassification: 'INFERENCE_HYPOTHESIS' as const,
    verificationState: 'HYPOTHESIS' as const,
    lifecycleStatus: 'PENDING' as const,
    duplicateOfRecordId: null,
  };
}

export function createAuthorizedMemoryRetrievalTool(reader: AuthorizedMemoryReader): Tool {
  return tool({
    name: MEMORY_RETRIEVAL_TOOL_NAME,
    description:
      'Retrieve bounded durable Torn project memory. Trusted application context filters authorization before relevance ranking. Read-only.',
    parameters: retrieveAuthorizedMemoryInputSchema,
    outputSchema: memoryRetrievalOutputSchema,
    errorFunction: memoryReadError,
    execute: async (input) => ({
      status: 'ok' as const,
      errorCode: 'NONE' as const,
      ...(await reader.retrieve(input)),
    }),
  });
}

export function createCoordinatorMemoryTools(
  reader: AuthorizedMemoryReader,
  writer: PendingMemoryWriter,
): readonly Tool[] {
  return [
    createAuthorizedMemoryRetrievalTool(reader),
    tool({
      name: MEMORY_PROPOSAL_TOOL_NAME,
      description:
        'Save a bounded Torn project memory proposal for trusted review. Application wiring injects authority; every proposal remains a pending hypothesis.',
      parameters: proposeDurableMemoryInputSchema,
      outputSchema: pendingMemoryProposalOutputSchema,
      errorFunction: memoryProposalError,
      execute: async (input) => await writer.propose(input),
    }),
  ];
}

export function createReadOnlyMemoryTools(reader: AuthorizedMemoryReader): readonly Tool[] {
  return [createAuthorizedMemoryRetrievalTool(reader)];
}
