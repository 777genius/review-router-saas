import { describe, expect, it } from 'vitest';
import { parseHealthReport } from '../src/privacy.js';

const validReport = {
  protocolVersion: 'v1',
  actionVersion: 'v1.0.0',
  configVersion: 1,
  configSource: 'saas',
  status: 'succeeded',
  providerTypes: ['codex'],
};

describe('parseHealthReport', () => {
  it('accepts safe metadata', () => {
    expect(parseHealthReport(validReport).status).toBe('succeeded');
  });

  it('rejects secret-looking content', () => {
    expect(() => parseHealthReport({
      ...validReport,
      safeErrorSummary: 'OPENAI_API_KEY=sk-testsecret0000000000000000',
    })).toThrow(/prohibited/);
  });

  it('rejects diff-looking content', () => {
    expect(() => parseHealthReport({
      ...validReport,
      safeErrorSummary: 'diff --git a/src/a.ts b/src/a.ts',
    })).toThrow(/prohibited/);
  });

  it('rejects oversized payload', () => {
    expect(() => parseHealthReport({
      ...validReport,
      safeErrorSummary: 'x'.repeat(70 * 1024),
    })).toThrow(/64 KB/);
  });
});
