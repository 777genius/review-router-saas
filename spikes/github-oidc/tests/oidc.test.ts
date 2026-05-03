import { describe, expect, it } from 'vitest';
import { validateOidcClaims, type GitHubOidcClaims } from '../src/oidc.js';

const baseClaims = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'review-router-spike',
  exp: Math.floor(Date.now() / 1000) + 300,
  iat: Math.floor(Date.now() / 1000),
  repository: '777genius/review-router-spike',
  repository_id: '123456',
  repository_owner: '777genius',
  repository_owner_id: '13103045',
  event_name: 'pull_request',
  run_id: '1000',
  run_attempt: '1',
} satisfies Partial<GitHubOidcClaims>;

describe('validateOidcClaims', () => {
  it('accepts valid claims', () => {
    const claims = validateOidcClaims(baseClaims, 'review-router-spike', '123456');
    expect(claims.repository_id).toBe('123456');
  });

  it('rejects audience mismatch', () => {
    expect(() => validateOidcClaims({ ...baseClaims, aud: 'wrong' }, 'review-router-spike')).toThrow(/audience/);
  });

  it('rejects repository mismatch', () => {
    expect(() => validateOidcClaims(baseClaims, 'review-router-spike', '999')).toThrow(/repository_id/);
  });

  it('accepts array audience containing expected value', () => {
    const claims = validateOidcClaims({ ...baseClaims, aud: ['other', 'review-router-spike'] }, 'review-router-spike');
    expect(claims.aud).toEqual(['other', 'review-router-spike']);
  });
});
