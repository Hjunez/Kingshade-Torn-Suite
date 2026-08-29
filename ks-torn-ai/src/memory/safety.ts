import { Buffer } from 'node:buffer';

import { redactRepositorySecrets } from '../repository/validation.js';
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_INVALIDATION_REASON_CHARS,
  MAX_MEMORY_SOURCE_CHARS,
  MAX_MEMORY_SUBJECT_CHARS,
  type MemoryRecord,
  type NewMemoryRecord,
} from './model.js';

const MAX_MEMORY_CONTENT_BYTES = 16_000;
const MAX_MEMORY_SOURCE_BYTES = 4_000;

const ADDITIONAL_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:authorization|proxy-authorization)\s*:\s*\S+/i,
  /\b(?:cookie|set-cookie|session(?:id|_id|token)?)\s*[:=]\s*\S{8,}/i,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|OPENSSH PRIVATE KEY)-----/i,
  /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?\S{6,}/i,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*['"]?\S{8,}/,
  /\b(?:torn[ _-]?api[ _-]?key)\s*[:=]\s*['"]?[A-Za-z0-9]{12,}/i,
];

const UNRELATED_PERSONAL_DATA_PATTERNS: readonly RegExp[] = [
  /\b(?:social security|national identification|passport|driver'?s license)\s+(?:number|id)\b/i,
  /\b(?:medical record|patient diagnosis|bank account|credit card)\b/i,
  /\b(?:private home address|personal phone number)\b/i,
];

export class MemorySafetyError extends Error {
  constructor(reason: 'content' | 'secret' | 'personal_data' | 'binary' | 'size') {
    super(`Memory record rejected by ${reason} safety policy`);
    this.name = 'MemorySafetyError';
  }
}

function containsDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) {
      return true;
    }
  }
  return false;
}

function validateText(value: string, maximumCharacters: number, maximumBytes: number): void {
  if (value.length === 0) {
    throw new MemorySafetyError('content');
  }
  if (value.length > maximumCharacters || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new MemorySafetyError('size');
  }
  if (containsDisallowedControl(value)) {
    throw new MemorySafetyError('binary');
  }
  if (
    redactRepositorySecrets(value).redactionCount > 0 ||
    ADDITIONAL_SECRET_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new MemorySafetyError('secret');
  }
  if (UNRELATED_PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new MemorySafetyError('personal_data');
  }
}

export function validateMemoryRecordSafety(record: NewMemoryRecord | MemoryRecord): void {
  for (const value of [
    record.id,
    record.projectId,
    record.ownerId,
    record.tenantId,
    record.supersedesRecordId,
    record.ownerVerificationEvidence?.verifiedByActorId,
  ]) {
    if (value !== undefined) {
      validateMemoryMetadataSafety(value);
    }
  }
  validateText(record.subject, MAX_MEMORY_SUBJECT_CHARS, MAX_MEMORY_SOURCE_BYTES);
  validateText(record.content, MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_CONTENT_BYTES);
  validateText(record.source.reference, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_SOURCE_BYTES);
  validateText(record.source.description, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_SOURCE_BYTES);
  if (record.lifecycle.status === 'INVALIDATED') {
    validateMemoryMetadataSafety(record.lifecycle.invalidatedByActorId);
    if (record.lifecycle.replacementRecordId !== undefined) {
      validateMemoryMetadataSafety(record.lifecycle.replacementRecordId);
    }
    validateText(
      record.lifecycle.reason,
      MAX_MEMORY_INVALIDATION_REASON_CHARS,
      MAX_MEMORY_SOURCE_BYTES,
    );
  }
}

export function validateMemoryMetadataSafety(value: string): void {
  validateText(value, MAX_MEMORY_SOURCE_CHARS, MAX_MEMORY_SOURCE_BYTES);
}

export function validateMemoryInvalidationReason(reason: string): void {
  validateText(reason, MAX_MEMORY_INVALIDATION_REASON_CHARS, MAX_MEMORY_SOURCE_BYTES);
}
