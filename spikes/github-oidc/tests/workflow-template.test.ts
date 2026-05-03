import { describe, expect, it } from 'vitest';
import { renderSpikeWorkflow } from '../src/workflow-template.js';

describe('renderSpikeWorkflow', () => {
  it('uses pull_request and does not use pull_request_target', () => {
    const yaml = renderSpikeWorkflow({ audience: 'review-router-spike', endpointUrl: '' });
    expect(yaml).toContain('pull_request:');
    expect(yaml).not.toContain('pull_request_target');
  });

  it('enables id-token write and disables checkout credential persistence', () => {
    const yaml = renderSpikeWorkflow({ audience: 'review-router-spike', endpointUrl: '' });
    expect(yaml).toContain('id-token: write');
    expect(yaml).toContain('persist-credentials: false');
  });

  it('does not print raw token', () => {
    const yaml = renderSpikeWorkflow({ audience: 'review-router-spike', endpointUrl: '' });
    expect(yaml).not.toContain('echo "$token"');
  });
});
