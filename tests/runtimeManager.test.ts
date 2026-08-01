import fs from 'fs';
import os from 'os';
import path from 'path';

import { invalidateRuntimeDiscoveryCache } from '../src/runtime/discovery';
import { RuntimeManager } from '../src/runtime/runtimeManager';
import type { ProviderStore } from '../src/storage/providerStore';
import {
  DEFAULT_SETTINGS,
  type ChatTurnRequest,
  type ProviderProfile,
  type RuntimeTurnEvent,
  type WeSightObsidianSettings,
} from '../src/types';

function makeProfile(apiKey: string): ProviderProfile {
  return {
    id: 'moonshot-profile',
    agentId: 'claude',
    name: 'Moonshot',
    apiKey,
    baseUrl: 'https://api.moonshot.cn/anthropic',
    model: 'kimi-k3',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3'],
    wireApi: 'chat',
    anthropicAuthMode: 'authToken',
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeSettings(binaryPath: string): WeSightObsidianSettings {
  return {
    ...DEFAULT_SETTINGS,
    configSources: { ...DEFAULT_SETTINGS.configSources, claude: 'providerProfile' },
    configuredPaths: { ...DEFAULT_SETTINGS.configuredPaths, claude: binaryPath },
    providerProfileByAgent: { ...DEFAULT_SETTINGS.providerProfileByAgent, claude: 'moonshot-profile' },
    localModelByAgent: { ...DEFAULT_SETTINGS.localModelByAgent },
  };
}

const request: ChatTurnRequest = {
  conversationId: 'conversation-1',
  agentId: 'claude',
  prompt: 'Reply with OK.',
  cwd: process.cwd(),
  configSource: 'providerProfile',
  providerProfileId: 'moonshot-profile',
};

describe('RuntimeManager provider safeguards', () => {
  let tempDir: string;
  let previousWesightHome: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
    });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-runtime-manager-'));
    previousWesightHome = process.env.WESIGHT_HOME;
    process.env.WESIGHT_HOME = tempDir;
    invalidateRuntimeDiscoveryCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousWesightHome === undefined) delete process.env.WESIGHT_HOME;
    else process.env.WESIGHT_HOME = previousWesightHome;
    invalidateRuntimeDiscoveryCache();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('blocks a remote provider with an empty key before Claude starts', async () => {
    const marker = path.join(tempDir, 'started');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const events: RuntimeTurnEvent[] = [];

    await manager.runTurn(request, event => events.push(event));

    expect(fs.existsSync(marker)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].message).toContain('API Key 缺失');
      expect(events[0].providerProfileId).toBe(profile.id);
    }
  });

  test('prevents a second request during the provider cooldown', async () => {
    const marker = path.join(tempDir, 'starts');
    const binaryPath = path.join(tempDir, 'fake-claude');
    fs.writeFileSync(binaryPath, [
      '#!/bin/sh',
      `printf 'started\\n' >> ${JSON.stringify(marker)}`,
      'echo "API Error: rate limit exceeded (429); wait 60 seconds" >&2',
      'echo "(request id: request-429)" >&2',
      'exec sleep 5',
    ].join('\n'));
    fs.chmodSync(binaryPath, 0o755);
    const profile = makeProfile('sk-test');
    const providerStore = { find: () => profile } as unknown as ProviderStore;
    const manager = new RuntimeManager(providerStore, () => makeSettings(binaryPath));
    const firstEvents: RuntimeTurnEvent[] = [];
    const secondEvents: RuntimeTurnEvent[] = [];

    await manager.runTurn(request, event => firstEvents.push(event));
    await manager.runTurn(request, event => secondEvents.push(event));

    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.type).toBe('error');
    if (firstEvents[0]?.type === 'error') {
      expect(firstEvents[0].statusCode).toBe(429);
      expect(firstEvents[0].retryAfterSeconds).toBe(60);
      expect(firstEvents[0].requestId).toBe('request-429');
    }
    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0]?.type).toBe('error');
    if (secondEvents[0]?.type === 'error') {
      expect(secondEvents[0].statusCode).toBe(429);
      expect(secondEvents[0].retryAfterSeconds).toBeGreaterThan(0);
      expect(secondEvents[0].message).toContain('仍在冷却中');
    }
  });
});
