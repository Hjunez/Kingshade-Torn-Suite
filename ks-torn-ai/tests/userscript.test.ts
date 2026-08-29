import { describe, expect, it } from 'vitest';

import { inspectUserscript } from '../src/repository/userscript.js';

describe('userscript inspection', () => {
  it('parses metadata and nearby status markers without model inference', () => {
    const source = `// ==UserScript==\n// @name         KS Torn War Dibs\n// @version      1.5.138\n// @downloadURL  https://example/a.user.js\n// @updateURL    https://example/a.user.js\n// @match        https://www.torn.com/*\n// ==/UserScript==\n\n/* KS Torn War Dibs TEST */`;

    const inspection = inspectUserscript(source);
    expect(inspection.beginsWithHeader).toBe(true);
    expect(inspection.headerClosed).toBe(true);
    expect(inspection.metadata.version).toBe('1.5.138');
    expect(inspection.metadata.fields.match).toEqual(['https://www.torn.com/*']);
    expect(inspection.statusMarkers).toEqual(['TEST']);
    expect(inspection.diagnostics).toEqual([]);
  });

  it('flags files that do not begin directly with the userscript header', () => {
    const inspection = inspectUserscript(`note\n// ==UserScript==\n// @name X\n// ==/UserScript==`);

    expect(inspection.beginsWithHeader).toBe(false);
    expect(inspection.diagnostics).toContain(
      'userscript file does not begin directly with // ==UserScript==',
    );
    expect(inspection.diagnostics).toContain('userscript header is missing @version');
  });

  it('flags divergent permanent install channels', () => {
    const inspection = inspectUserscript(
      `// ==UserScript==\n// @name X\n// @version 1.0.0\n// @downloadURL https://example/a\n// @updateURL https://example/b\n// ==/UserScript==`,
    );

    expect(inspection.diagnostics).toContain(
      '@updateURL and @downloadURL point to different locations',
    );
  });
});
