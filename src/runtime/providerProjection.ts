import fs from 'fs';
import path from 'path';

import { tmpDir } from '../paths';
import type { AgentId, ProviderProfile } from '../types';
import { ensureDir, safeRemoveDir, writeJsonFile } from '../utils/fs';

export interface ProviderProjection {
  env: NodeJS.ProcessEnv;
  args: string[];
  cleanup: () => void;
}

function sanitizeProviderKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '') || 'custom';
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function makeTurnTmpDir(agentId: AgentId, env: NodeJS.ProcessEnv): string {
  return path.join(tmpDir(env), `${agentId}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function profileModel(profile: ProviderProfile): string {
  return (profile.defaultModel || profile.model || '').trim();
}

export function buildCodexOverrideArgs(profile: ProviderProfile): string[] {
  const providerKey = sanitizeProviderKey(profile.name || profile.id);
  const model = profileModel(profile);
  const wireApi = profile.wireApi ?? 'chat';
  const args = [
    '-c',
    `model_provider=${tomlString(providerKey)}`,
    '-c',
    `model_providers.${providerKey}.name=${tomlString(profile.name)}`,
    '-c',
    `model_providers.${providerKey}.wire_api=${tomlString(wireApi)}`,
    '-c',
    `model_providers.${providerKey}.requires_openai_auth=true`,
  ];
  if (model) {
    args.push('-c', `model=${tomlString(model)}`);
  }
  if (profile.baseUrl.trim()) {
    args.push('-c', `model_providers.${providerKey}.base_url=${tomlString(profile.baseUrl.trim())}`);
  }
  return args;
}

export function prepareProviderProjection(
  agentId: AgentId,
  profile: ProviderProfile | null,
  baseEnv: NodeJS.ProcessEnv,
): ProviderProjection {
  if (!profile) {
    return {
      env: { ...baseEnv },
      args: [],
      cleanup: () => undefined,
    };
  }

  if (agentId === 'claude') {
    const env = { ...baseEnv };
    const model = profileModel(profile);
    if (profile.apiKey) {
      env.ANTHROPIC_API_KEY = profile.apiKey;
      env.ANTHROPIC_AUTH_TOKEN = profile.apiKey;
    }
    if (profile.baseUrl) {
      env.ANTHROPIC_BASE_URL = profile.baseUrl;
    }
    if (model) {
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_REASONING_MODEL = model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_SMALL_FAST_MODEL = model;
    }
    return { env, args: [], cleanup: () => undefined };
  }

  if (agentId === 'codex') {
    const codexHome = makeTurnTmpDir('codex', baseEnv);
    ensureDir(codexHome);
    const providerKey = sanitizeProviderKey(profile.name || profile.id);
    const model = profileModel(profile);
    const wireApi = profile.wireApi ?? 'chat';
    const configLines = [
      `model_provider = ${tomlString(providerKey)}`,
      model ? `model = ${tomlString(model)}` : '',
      '',
      `[model_providers.${providerKey}]`,
      `name = ${tomlString(profile.name)}`,
      profile.baseUrl.trim() ? `base_url = ${tomlString(profile.baseUrl.trim())}` : '',
      `wire_api = ${tomlString(wireApi)}`,
      'requires_openai_auth = true',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `${configLines}\n`, { mode: 0o600 });
    writeJsonFile(path.join(codexHome, 'auth.json'), { OPENAI_API_KEY: profile.apiKey }, 0o600);
    return {
      env: {
        ...baseEnv,
        CODEX_HOME: codexHome,
        OPENAI_API_KEY: profile.apiKey,
      },
      args: buildCodexOverrideArgs(profile),
      cleanup: () => safeRemoveDir(codexHome),
    };
  }

  const configHome = makeTurnTmpDir('opencode', baseEnv);
  const configDir = path.join(configHome, 'opencode');
  ensureDir(configDir);
  const providerKey = sanitizeProviderKey(profile.name || profile.id);
  const model = profileModel(profile);
  const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  writeJsonFile(path.join(configDir, 'opencode.json'), {
    model: `${providerKey}/${modelId || 'gpt-5.4'}`,
    provider: {
      [providerKey]: {
        name: profile.name,
        npm: '@ai-sdk/openai-compatible',
        options: {
          apiKey: profile.apiKey,
          baseURL: profile.baseUrl,
        },
        models: {
          [modelId || 'gpt-5.4']: {},
        },
      },
    },
  }, 0o600);

  return {
    env: {
      ...baseEnv,
      XDG_CONFIG_HOME: configHome,
      OPENAI_API_KEY: profile.apiKey,
    },
    args: model ? ['--model', `${providerKey}/${modelId || model}`] : [],
    cleanup: () => safeRemoveDir(configHome),
  };
}
