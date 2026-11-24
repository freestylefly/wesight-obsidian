import type { ConfigSourcesByAgent, WeSightObsidianSettings } from '../types';
/** Existing installs without a config-source field used local CLI historically. */
export function memberAiConfigSources(
  value: Partial<WeSightObsidianSettings> | null | undefined,
): ConfigSourcesByAgent {
  const existing = Boolean(value && Object.keys(value).length);
  const claude = value?.configSources?.claude;
  return {
    claude:
      claude === 'localCli' || claude === 'providerProfile' || claude === 'wesightManaged'
        ? claude
        : existing
          ? 'localCli'
          : 'wesightManaged',
    codex: 'localCli',
    opencode: value?.configSources?.opencode === 'providerProfile' ? 'providerProfile' : 'localCli',
    antigravity: 'localCli',
  };
}
