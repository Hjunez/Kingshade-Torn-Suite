import { z } from 'zod';

import {
  knowledgeZoneSchema,
  memoryActorIdSchema,
  memoryProjectIdSchema,
  memoryTenantIdSchema,
  type MemoryRecord,
} from './model.js';

export const memoryRoleSchema = z.enum([
  'OWNER_DEVELOPER',
  'TORN_ADVISOR',
  'FACTION_MEMBER',
  'DEVELOPER',
]);

export const memoryCapabilitySchema = z.enum([
  'MEMORY_READ',
  'MEMORY_PROPOSE',
  'MEMORY_INGEST',
  'MEMORY_INVALIDATE',
  'MEMORY_VERIFY_OWNER',
]);

export const memoryAccessContextSchema = z
  .object({
    actorId: memoryActorIdSchema,
    role: memoryRoleSchema,
    capabilities: z.array(memoryCapabilitySchema).max(10),
    projectGrants: z.array(memoryProjectIdSchema).max(100),
    allowedZones: z.array(knowledgeZoneSchema).max(4),
    tenantGrants: z.array(memoryTenantIdSchema).max(100),
  })
  .strict();

export type MemoryRole = z.infer<typeof memoryRoleSchema>;
export type MemoryCapability = z.infer<typeof memoryCapabilitySchema>;
type ParsedMemoryAccessContext = z.infer<typeof memoryAccessContextSchema>;
export type MemoryAccessContext = Readonly<
  Omit<
    ParsedMemoryAccessContext,
    'capabilities' | 'projectGrants' | 'allowedZones' | 'tenantGrants'
  > & {
    capabilities: readonly MemoryCapability[];
    projectGrants: readonly string[];
    allowedZones: readonly MemoryRecord['zone'][];
    tenantGrants: readonly string[];
  }
>;

export class MemoryAuthorizationError extends Error {
  constructor() {
    super('Memory access denied');
    this.name = 'MemoryAuthorizationError';
  }
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function violatesMinimalRoleBoundary(context: ParsedMemoryAccessContext): boolean {
  if (
    (context.role === 'TORN_ADVISOR' || context.role === 'FACTION_MEMBER') &&
    (context.allowedZones.includes('PRIVATE_KINGSHADE_DEV') ||
      context.capabilities.some((capability) => capability !== 'MEMORY_READ'))
  ) {
    return true;
  }
  return context.role !== 'OWNER_DEVELOPER' && context.capabilities.includes('MEMORY_VERIFY_OWNER');
}

export function createTrustedMemoryAccessContext(input: unknown): MemoryAccessContext {
  const parsed = memoryAccessContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new MemoryAuthorizationError();
  }
  if (
    hasDuplicates(parsed.data.capabilities) ||
    hasDuplicates(parsed.data.projectGrants) ||
    hasDuplicates(parsed.data.allowedZones) ||
    hasDuplicates(parsed.data.tenantGrants) ||
    violatesMinimalRoleBoundary(parsed.data)
  ) {
    throw new MemoryAuthorizationError();
  }
  return Object.freeze({
    ...parsed.data,
    capabilities: Object.freeze([...parsed.data.capabilities]),
    projectGrants: Object.freeze([...parsed.data.projectGrants]),
    allowedZones: Object.freeze([...parsed.data.allowedZones]),
    tenantGrants: Object.freeze([...parsed.data.tenantGrants]),
  });
}

function requireContext(context: MemoryAccessContext | null | undefined): MemoryAccessContext {
  if (context === null || context === undefined) {
    throw new MemoryAuthorizationError();
  }
  return createTrustedMemoryAccessContext(context);
}

function hasRecordScope(context: MemoryAccessContext, record: MemoryRecord): boolean {
  if (
    !context.projectGrants.includes(record.projectId) ||
    !context.allowedZones.includes(record.zone)
  ) {
    return false;
  }
  if (record.zone === 'USER_PRIVATE') {
    return record.ownerId === context.actorId;
  }
  if (record.zone === 'FACTION_SHARED') {
    return record.tenantId !== undefined && context.tenantGrants.includes(record.tenantId);
  }
  return true;
}

export function canReadMemoryRecord(
  context: MemoryAccessContext | null | undefined,
  record: MemoryRecord,
): boolean {
  try {
    const trusted = requireContext(context);
    return trusted.capabilities.includes('MEMORY_READ') && hasRecordScope(trusted, record);
  } catch (error: unknown) {
    if (error instanceof MemoryAuthorizationError) {
      return false;
    }
    throw error;
  }
}

export function requireMemoryCapability(
  context: MemoryAccessContext | null | undefined,
  capability: MemoryCapability,
): MemoryAccessContext {
  const trusted = requireContext(context);
  if (!trusted.capabilities.includes(capability)) {
    throw new MemoryAuthorizationError();
  }
  return trusted;
}

export function requireMemoryRecordScope(
  context: MemoryAccessContext | null | undefined,
  capability: MemoryCapability,
  record: MemoryRecord,
): MemoryAccessContext {
  const trusted = requireMemoryCapability(context, capability);
  if (!hasRecordScope(trusted, record)) {
    throw new MemoryAuthorizationError();
  }
  return trusted;
}
