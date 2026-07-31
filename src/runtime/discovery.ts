import fs from 'fs';
import os from 'os';
import path from 'path';

import { getAgentDescriptor } from '../agents';
import { managedBinaryPath, runtimeManagedDir } from '../paths';
import type { AgentId, AgentStatus, RuntimeConfigSource } from '../types';
import { resolveCommand, readCommandVersion } from '../utils/command';
import { executableFileExists } from '../utils/fs';

export interface RuntimeDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  configuredPaths?: Partial<Record<AgentId, string>>;
  configSources?: Partial<Record<AgentId, RuntimeConfigSource>>;
}

interface CachedStatus {
  status: AgentStatus;
  /** Probed lazily; undefined means "not requested yet". */
  version?: string | null;
  expiresAt: number;
}

// Probing spawns `which` (and `--version` when requested) synchronously, which can block
// the UI thread, so results are cached briefly across RuntimeDiscovery instances.
const STATUS_CACHE = new Map<string, CachedStatus>();
const STATUS_CACHE_TTL_MS = 30_000;

export function invalidateRuntimeDiscoveryCache(agentId?: AgentId): void {
  if (!agentId) {
    STATUS_CACHE.clear();
    return;
  }
  for (const key of [...STATUS_CACHE.keys()]) {
    if (key.startsWith(`${agentId}|`)) {
      STATUS_CACHE.delete(key);
    }
  }
}

export class RuntimeDiscovery {
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: RuntimeDiscoveryOptions = {}) {
    this.env = options.env ?? process.env;
  }

  resolve(agentId: AgentId, options: { withVersion?: boolean } = {}): AgentStatus {
    const configuredPath = this.options.configuredPaths?.[agentId]?.trim() ?? '';
    const configSource = this.options.configSources?.[agentId] ?? 'localCli';
    const cacheKey = [agentId, configuredPath, this.env.PATH ?? '', this.env.WESIGHT_HOME ?? ''].join('|');
    let entry = STATUS_CACHE.get(cacheKey);
    if (!entry || entry.expiresAt <= Date.now()) {
      entry = {
        status: this.probe(agentId, configuredPath, configSource),
        expiresAt: Date.now() + STATUS_CACHE_TTL_MS,
      };
      STATUS_CACHE.set(cacheKey, entry);
    }
    // `--version` spawns another synchronous subprocess, so only pay for it when
    // a caller actually displays the version (settings/diagnostics).
    if (options.withVersion && entry.version === undefined) {
      entry.version = entry.status.binaryPath
        ? readCommandVersion(entry.status.binaryPath, this.env)
        : null;
    }
    return { ...entry.status, configSource, version: entry.version ?? null };
  }

  private probe(agentId: AgentId, configuredPath: string, configSource: RuntimeConfigSource): AgentStatus {
    const descriptor = getAgentDescriptor(agentId);
    const managedDir = runtimeManagedDir(agentId, this.env);
    const localConfigFound = this.detectLocalConfig(agentId);

    const configured = this.resolveConfiguredPath(configuredPath);
    if (configured) {
      return {
        agentId,
        descriptor,
        state: 'ready',
        found: true,
        binaryPath: configured,
        source: 'configured',
        version: null,
        configuredPath,
        managedDir,
        configSource,
        localConfigFound,
        error: null,
      };
    }

    const managed = managedBinaryPath(agentId, descriptor.binaryName, this.env);
    if (executableFileExists(managed)) {
      return {
        agentId,
        descriptor,
        state: 'ready',
        found: true,
        binaryPath: managed,
        source: 'managed',
        version: null,
        configuredPath,
        managedDir,
        configSource,
        localConfigFound,
        error: null,
      };
    }

    const fromPath = resolveCommand(descriptor.binaryName, this.buildSearchEnv());
    if (fromPath) {
      return {
        agentId,
        descriptor,
        state: 'ready',
        found: true,
        binaryPath: fromPath,
        source: 'path',
        version: null,
        configuredPath,
        managedDir,
        configSource,
        localConfigFound,
        error: null,
      };
    }

    return {
      agentId,
      descriptor,
      state: 'missing',
      found: false,
      binaryPath: null,
      source: null,
      version: null,
      configuredPath,
      managedDir,
      configSource,
      localConfigFound,
      error: `${descriptor.binaryName} was not found.`,
    };
  }

  private resolveConfiguredPath(configuredPath: string): string | null {
    if (!configuredPath) return null;
    const expanded = configuredPath.startsWith('~/')
      ? path.join(os.homedir(), configuredPath.slice(2))
      : configuredPath;
    return executableFileExists(expanded) ? expanded : null;
  }

  private buildSearchEnv(): NodeJS.ProcessEnv {
    return {
      ...this.env,
      PATH: [
        this.env.PATH ?? '',
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.npm-global', 'bin'),
        path.join(os.homedir(), '.volta', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ].join(path.delimiter),
    };
  }

  private detectLocalConfig(agentId: AgentId): boolean {
    const home = os.homedir();
    const candidates = agentId === 'claude'
      ? [
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude', 'claude.json'),
        path.join(home, '.claude.json'),
      ]
      : agentId === 'codex'
        ? [
          path.join(home, '.codex', 'config.toml'),
          path.join(home, '.codex', 'auth.json'),
        ]
        : [
          path.join(home, '.config', 'opencode', 'opencode.json'),
          path.join(home, '.local', 'share', 'opencode', 'auth.json'),
        ];
    return candidates.some(candidate => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
  }
}
