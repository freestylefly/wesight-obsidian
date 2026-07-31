import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildCodexOverrideArgs, prepareProviderProjection } from '../src/runtime/providerProjection';
import type { ProviderProfile } from '../src/types';

const profile: ProviderProfile = {
  id: 'profile_1',
  agentId: 'codex',
  name: 'OpenAI',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com/v1',
  model: 'gpt-5.4',
  defaultModel: 'gpt-5.4',
  models: ['gpt-5.4'],
  wireApi: 'chat',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
};

describe('provider projection', () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-projection-'));
    env = { WESIGHT_HOME: tempDir } as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('builds codex -c override args', () => {
    expect(buildCodexOverrideArgs(profile)).toContain('model="gpt-5.4"');
    expect(buildCodexOverrideArgs(profile)).toContain('model_providers.openai.wire_api="chat"');
  });

  test('writes temporary Codex config and cleans it up', () => {
    const projection = prepareProviderProjection('codex', profile, env);
    const codexHome = String(projection.env.CODEX_HOME);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'auth.json'))).toBe(true);
    projection.cleanup();
    expect(fs.existsSync(codexHome)).toBe(false);
  });

  test('maps Claude profile to Anthropic environment', () => {
    const projection = prepareProviderProjection('claude', { ...profile, agentId: 'claude' }, env);
    expect(projection.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(projection.env.ANTHROPIC_MODEL).toBe('gpt-5.4');
  });
});
