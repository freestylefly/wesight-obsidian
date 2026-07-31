import fs from 'fs';
import os from 'os';
import path from 'path';

import { ProviderStore } from '../src/storage/providerStore';

function createSecretStorage() {
  const values = new Map<string, string>();
  return {
    getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => {
      values.set(id, value);
    },
  };
}

describe('ProviderStore', () => {
  let tempDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-provider-'));
    env = { WESIGHT_HOME: tempDir };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('makes the first profile default for an agent', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    const profile = store.save({
      agentId: 'codex',
      name: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-5.4',
    });
    expect(profile.isDefault).toBe(true);
    expect(store.find('codex')?.id).toBe(profile.id);
  });

  test('redacts secrets during export', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    store.save({
      agentId: 'claude',
      name: 'anthropic',
      apiKey: 'sk-secret-value',
    });
    expect(store.exportProfiles()[0]).toMatchObject({
      apiKey: '',
      apiKeyRedacted: true,
    });
    expect(store.exportProfiles({ includeSecrets: true })[0].apiKey).toBe('sk-secret-value');
    expect(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8'))
      .not.toContain('sk-secret-value');
  });

  test('migrates legacy plaintext API keys into SecretStorage', () => {
    const secrets = createSecretStorage();
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({
      version: 1,
      profiles: [{
        id: 'legacy-profile',
        agentId: 'codex',
        name: 'legacy',
        apiKey: 'sk-legacy-secret',
        baseUrl: 'https://api.example.com/v1',
        model: 'example-model',
        defaultModel: 'example-model',
        models: ['example-model'],
        wireApi: 'chat',
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      }],
    }));

    const store = new ProviderStore(secrets, env);
    expect(store.find('codex')?.apiKey).toBe('sk-legacy-secret');
    expect(secrets.getSecret('wesight-provider-api-key:legacy-profile')).toBe('sk-legacy-secret');
    expect(fs.readFileSync(path.join(tempDir, 'providers.json'), 'utf8'))
      .not.toContain('sk-legacy-secret');
  });

  test('validates imported provider profiles before saving', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    expect(() => store.importProfiles([{ agentId: 'unknown', name: 'invalid' }]))
      .toThrow('invalid agentId');
    expect(store.list()).toEqual([]);
  });

  test('keeps one default per agent', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    const first = store.save({ agentId: 'opencode', name: 'first' });
    const second = store.save({ agentId: 'opencode', name: 'second', isDefault: true });
    expect(store.find('opencode')?.id).toBe(second.id);
    expect(store.list('opencode').find(profile => profile.id === first.id)?.isDefault).toBe(false);
  });

  test('normalizes profile models and wire API defaults', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    const profile = store.save({
      agentId: 'codex',
      name: 'deepseek',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
    expect(profile.defaultModel).toBe('deepseek-chat');
    expect(profile.models).toEqual(['deepseek-chat']);
    expect(profile.wireApi).toBe('chat');
  });

  test('uses responses wire API for the official OpenAI endpoint', () => {
    const store = new ProviderStore(createSecretStorage(), env);
    const profile = store.save({
      agentId: 'codex',
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-5.4',
    });
    expect(profile.wireApi).toBe('responses');
  });
});
