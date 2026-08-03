import type { CodexRuntimeStatus, WeSightObsidianSettings } from '../types';

export function coverGeneratorConfigError(
  settings: WeSightObsidianSettings,
  status: CodexRuntimeStatus,
): string | null {
  if (settings.configSources.codex !== 'localCli') {
    return 'Codex 当前不是本地 CLI 配置。请检查 WeSight 设置中的 Codex 配置源。';
  }
  if (status.imageGeneration === false) {
    return '当前 Codex 模型/配置不支持图片生成。';
  }
  if (status.imageGeneration !== true) {
    return `无法确认 Codex 图片生成能力${status.error ? `：${status.error}` : '。'}`;
  }
  return null;
}
