import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AgentId } from '../types';

export interface LocalModelOption {
  /** Value passed to the CLI (`claude --model <id>`). Empty string = CLI default. */
  id: string;
  label: string;
  note?: string;
}

/** Model aliases the Claude Code CLI resolves on its own. */
const CLAUDE_MODEL_ALIASES: LocalModelOption[] = [
  { id: '', label: 'CLI default', note: 'uses local Claude settings' },
  { id: 'sonnet', label: 'Sonnet', note: 'alias' },
  { id: 'opus', label: 'Opus', note: 'alias' },
  { id: 'haiku', label: 'Haiku', note: 'alias' },
  { id: 'sonnet[1m]', label: 'Sonnet 1M', note: 'alias' },
];

function readJsonModel(filePath: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === 'string' && model.trim()) {
        return model.trim();
      }
    }
  } catch {
    // Missing or malformed local config is not an error; we just skip it.
  }
  return null;
}

function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function pushUnique(options: LocalModelOption[], seen: Set<string>, option: LocalModelOption): void {
  if (seen.has(option.id)) return;
  seen.add(option.id);
  options.push(option);
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '').trim();
}

function readClaudeConfiguredModels(env: NodeJS.ProcessEnv): Array<{ model: string | null; note: string }> {
  const home = os.homedir();
  return [
    { model: readJsonModel(path.join(home, '.claude', 'settings.json')), note: '~/.claude/settings.json' },
    { model: readJsonModel(path.join(home, '.claude', 'settings.local.json')), note: '~/.claude/settings.local.json' },
    { model: env.ANTHROPIC_MODEL?.trim() || null, note: 'ANTHROPIC_MODEL' },
  ];
}

export function getClaudeDetectedLocalModel(env: NodeJS.ProcessEnv = process.env): LocalModelOption | null {
  for (const { model, note } of readClaudeConfiguredModels(env)) {
    if (model) {
      return { id: model, label: model, note };
    }
  }
  return null;
}

/**
 * Models the local Claude Code CLI can run with, combining built-in aliases
 * with whatever the user's local config (~/.claude/settings.json) selects.
 */
export function listClaudeLocalModels(env: NodeJS.ProcessEnv = process.env): LocalModelOption[] {
  const options = [...CLAUDE_MODEL_ALIASES];
  const seen = new Set(options.map(option => option.id));
  for (const { model, note } of readClaudeConfiguredModels(env)) {
    if (model && !seen.has(model)) {
      seen.add(model);
      options.push({ id: model, label: model, note });
    }
  }
  return options;
}

export function listCodexLocalModels(): LocalModelOption[] {
  const options: LocalModelOption[] = [
    { id: '', label: 'CLI default', note: 'uses local Codex config' },
  ];
  const seen = new Set(options.map(option => option.id));
  const config = readTextFile(path.join(os.homedir(), '.codex', 'config.toml'));
  if (!config) return options;

  const model = config.match(/^\s*model\s*=\s*(['"][^'"]+['"]|[^\s#]+)/m)?.[1];
  const provider = config.match(/^\s*model_provider\s*=\s*(['"][^'"]+['"]|[^\s#]+)/m)?.[1];
  const cleanModel = model ? unquote(model) : '';
  const cleanProvider = provider ? unquote(provider) : '';
  if (cleanModel) {
    pushUnique(options, seen, {
      id: cleanProvider ? `${cleanProvider}/${cleanModel}` : cleanModel,
      label: cleanModel,
      note: cleanProvider ? `${cleanProvider} in ~/.codex/config.toml` : '~/.codex/config.toml',
    });
  }

  for (const match of config.matchAll(/^\s*\[model_providers\.([^\]]+)]/gm)) {
    const providerName = unquote(match[1] ?? '');
    if (providerName && cleanModel) {
      pushUnique(options, seen, {
        id: `${providerName}/${cleanModel}`,
        label: providerName,
        note: cleanModel,
      });
    }
  }
  return options;
}

function collectOpenCodeModels(payload: unknown): LocalModelOption[] {
  const options: LocalModelOption[] = [
    { id: '', label: 'CLI default', note: 'uses local OpenCode config' },
  ];
  const seen = new Set(options.map(option => option.id));
  if (!payload || typeof payload !== 'object') return options;
  const record = payload as Record<string, unknown>;
  const configuredModel = typeof record.model === 'string' ? record.model.trim() : '';
  if (configuredModel) {
    pushUnique(options, seen, { id: configuredModel, label: configuredModel, note: 'configured' });
  }
  const providers = record.provider;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return options;
  for (const [providerId, providerValue] of Object.entries(providers as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) continue;
    const models = (providerValue as Record<string, unknown>).models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    for (const modelId of Object.keys(models)) {
      pushUnique(options, seen, {
        id: `${providerId}/${modelId}`,
        label: modelId,
        note: providerId,
      });
    }
  }
  return options;
}

export function listOpenCodeLocalModels(): LocalModelOption[] {
  const configPaths = [
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.opencode.json'),
  ];
  for (const filePath of configPaths) {
    try {
      const options = collectOpenCodeModels(JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown);
      if (options.length > 1) return options;
    } catch {
      // Missing or malformed local config is not an error; we just skip it.
    }
  }
  return [{ id: '', label: 'CLI default', note: 'uses local OpenCode config' }];
}

export function listLocalModels(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): LocalModelOption[] {
  if (agentId === 'claude') return listClaudeLocalModels(env);
  if (agentId === 'codex') return listCodexLocalModels();
  return listOpenCodeLocalModels();
}
