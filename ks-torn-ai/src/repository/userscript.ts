export interface UserscriptMetadata {
  name: string | null;
  version: string | null;
  updateUrl: string | null;
  downloadUrl: string | null;
  fields: Readonly<Record<string, readonly string[]>>;
}

export type ScriptStatusMarker = 'TEST' | 'RELEASE' | 'RC' | 'ALPHA' | 'BETA';

export interface UserscriptInspection {
  beginsWithHeader: boolean;
  headerClosed: boolean;
  metadata: UserscriptMetadata;
  statusMarkers: readonly ScriptStatusMarker[];
  diagnostics: readonly string[];
}

const HEADER_START = '// ==UserScript==';
const HEADER_END = '// ==/UserScript==';
const STATUS_MARKERS: readonly ScriptStatusMarker[] = ['TEST', 'RELEASE', 'RC', 'ALPHA', 'BETA'];

function firstValue(fields: Readonly<Record<string, readonly string[]>>, key: string): string | null {
  return fields[key]?.[0] ?? null;
}

export function inspectUserscript(source: string): UserscriptInspection {
  const lines = source.split(/\r?\n/);
  const beginsWithHeader = lines[0] === HEADER_START;
  const diagnostics: string[] = [];

  if (!beginsWithHeader) {
    diagnostics.push('userscript file does not begin directly with // ==UserScript==');
  }

  const startIndex = beginsWithHeader ? 0 : lines.indexOf(HEADER_START);
  const endIndex = startIndex >= 0 ? lines.indexOf(HEADER_END, startIndex + 1) : -1;
  const headerClosed = startIndex >= 0 && endIndex > startIndex;
  if (!headerClosed) {
    diagnostics.push('userscript header is missing a valid closing marker');
  }

  const mutableFields: Record<string, string[]> = {};
  if (headerClosed) {
    for (const line of lines.slice(startIndex + 1, endIndex)) {
      const match = /^\/\/\s+@([^\s]+)(?:\s+(.*?))?\s*$/.exec(line);
      if (match === null) {
        continue;
      }
      const key = match[1];
      if (key === undefined) {
        continue;
      }
      const value = match[2] ?? '';
      (mutableFields[key] ??= []).push(value);
    }
  }

  const fields: Readonly<Record<string, readonly string[]>> = mutableFields;
  const metadata: UserscriptMetadata = {
    name: firstValue(fields, 'name'),
    version: firstValue(fields, 'version'),
    updateUrl: firstValue(fields, 'updateURL'),
    downloadUrl: firstValue(fields, 'downloadURL'),
    fields,
  };

  if (metadata.name === null) {
    diagnostics.push('userscript header is missing @name');
  }
  if (metadata.version === null) {
    diagnostics.push('userscript header is missing @version');
  }
  if (
    metadata.updateUrl !== null &&
    metadata.downloadUrl !== null &&
    metadata.updateUrl !== metadata.downloadUrl
  ) {
    diagnostics.push('@updateURL and @downloadURL point to different locations');
  }

  const nearbyBody = headerClosed ? lines.slice(endIndex + 1, endIndex + 31).join('\n') : '';
  const statusMarkers = STATUS_MARKERS.filter((marker) =>
    new RegExp(`\\b${marker}\\b`, 'i').test(nearbyBody),
  );

  return {
    beginsWithHeader,
    headerClosed,
    metadata,
    statusMarkers,
    diagnostics,
  };
}
