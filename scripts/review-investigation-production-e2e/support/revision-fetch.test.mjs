import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisionFetch } from './revision-fetch.fixture.ts';
const fixture = { owner: 'fixture', repo: 'test', installationId: '123', pullRequestNumber: 7,
  revision: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40) } };
test('current-revision prerequisite receives exact parent fixture data', async () => {
  const fetch = revisionFetch(fixture);
  const token = await fetch('https://api.github.com/app/installations/123/access_tokens', { method: 'POST' });
  assert.equal(token.status, 201);
  const pr = await (await fetch('https://api.github.com/repos/fixture/test/pulls/7')).json();
  assert.equal(pr.head.sha, fixture.revision.headSha);
  assert.equal(pr.base.sha, fixture.revision.baseSha);
  const compare = await (await fetch(`https://api.github.com/repos/fixture/test/compare/${fixture.revision.baseSha}...${fixture.revision.headSha}`)).json();
  assert.equal(compare.merge_base_commit.sha, fixture.revision.mergeBaseSha);
});
test('unknown origins, methods, queries, identities and publication fail closed', async () => {
  const fetch = revisionFetch(fixture);
  for (const url of [
    'http://api.github.com/repos/fixture/test/pulls/7',
    'https://elsewhere.test/repos/fixture/test/pulls/7',
    'https://api.github.com/repos/fixture/test/pulls/8',
    'https://api.github.com/repos/fixture/test/pulls/7?secret=value',
    'https://api.github.com/repos/fixture/test/issues/7/comments',
    'https://api.github.com/repos/fixture/test/compare/wrong...revision',
  ]) await assert.rejects(fetch(url), /^Error: item11_external_fetch_denied$/);
  await assert.rejects(fetch('https://api.github.com/repos/fixture/test/pulls/7', { method: 'POST' }), /item11_external_fetch_denied/);
});
