import { describe, expect, test } from 'vitest';

import { coverGeneratorConfigError } from '../src/ui/wechatCoverGeneratorConfig';
import { DEFAULT_SETTINGS } from '../src/types';

const readyStatus = {
  state: 'ready' as const,
  binaryPath: '/usr/local/bin/codex',
  binarySource: 'path' as const,
  version: 'codex-cli 0.130.0',
  connected: true,
  authenticated: true,
  authMode: 'chatgpt',
  currentModelId: 'gpt-5.6-sol',
  currentModel: null,
  models: [],
  imageGeneration: true,
  webSearch: true,
  error: null,
};

describe('WeChat cover generator configuration', () => {
  test('does not require Codex to be the default chat engine', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      defaultAgentId: 'claude' as const,
      configSources: { ...DEFAULT_SETTINGS.configSources, codex: 'localCli' as const },
    };

    expect(coverGeneratorConfigError(settings, readyStatus)).toBeNull();
  });

  test('reports an unavailable Codex image capability', () => {
    expect(coverGeneratorConfigError(DEFAULT_SETTINGS, {
      ...readyStatus,
      imageGeneration: false,
    })).toBe('当前 Codex 模型/配置不支持图片生成。');
  });
});
