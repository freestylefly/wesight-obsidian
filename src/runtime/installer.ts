import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';

import { getAgentDescriptor } from '../agents';
import { managedBinaryPath, runtimeInstallRecordPath, runtimeManagedDir } from '../paths';
import type { AgentId, InstallProgress, InstallResult } from '../types';
import { resolveCommand, readCommandVersion } from '../utils/command';
import { ensureDir, executableFileExists, writeJsonFile } from '../utils/fs';
import { invalidateRuntimeDiscoveryCache } from './discovery';

export interface RuntimeInstallPlan {
  agentId: AgentId;
  packageName: string;
  managedDir: string;
  args: string[];
}

export interface RuntimeInstallRecord {
  agentId: AgentId;
  packageName: string;
  binaryPath: string;
  version: string | null;
  installedAt: string;
}

const MAX_PROGRESS_CHARS = 320;

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > MAX_PROGRESS_CHARS ? `${text.slice(0, MAX_PROGRESS_CHARS)}...` : text;
}

export function buildRuntimeInstallPlan(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): RuntimeInstallPlan {
  const descriptor = getAgentDescriptor(agentId);
  const managedDir = runtimeManagedDir(agentId, env);
  return {
    agentId,
    packageName: descriptor.packageName,
    managedDir,
    args: ['install', '--prefix', managedDir, descriptor.packageName],
  };
}

export class RuntimeInstaller extends EventEmitter {
  private readonly activeChildren = new Map<AgentId, ChildProcess>();
  private readonly activeInstalls = new Map<AgentId, Promise<InstallResult>>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    super();
  }

  onProgress(listener: (progress: InstallProgress) => void): () => void {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }

  install(agentId: AgentId): Promise<InstallResult> {
    const active = this.activeInstalls.get(agentId);
    if (active) return active;
    const task = this.runInstall(agentId).finally(() => {
      this.activeInstalls.delete(agentId);
      this.activeChildren.delete(agentId);
    });
    this.activeInstalls.set(agentId, task);
    return task;
  }

  cancel(agentId: AgentId): void {
    const child = this.activeChildren.get(agentId);
    if (child) {
      child.kill('SIGTERM');
      this.emitProgress({
        agentId,
        phase: 'cancelled',
        message: 'Installation cancelled.',
      });
    }
  }

  private async runInstall(agentId: AgentId): Promise<InstallResult> {
    if (process.platform !== 'darwin') {
      const message = 'Managed installation currently supports macOS. Configure a CLI path or install the agent manually.';
      this.emitProgress({ agentId, phase: 'unsupported', message });
      return { success: false, agentId, unsupported: true, error: message };
    }

    const descriptor = getAgentDescriptor(agentId);
    const plan = buildRuntimeInstallPlan(agentId, this.env);
    const npmPath = resolveCommand('npm', this.env) ?? 'npm';
    ensureDir(plan.managedDir);
    this.emitProgress({
      agentId,
      phase: 'starting',
      message: `Installing ${descriptor.displayName} into ${plan.managedDir}.`,
    });

    return new Promise<InstallResult>((resolve) => {
      const child = spawn(npmPath, plan.args, {
        cwd: plan.managedDir,
        env: {
          ...this.env,
          PATH: [
            path.join(this.env.HOME ?? '', '.local', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            this.env.PATH ?? '',
          ].join(path.delimiter),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChildren.set(agentId, child);

      child.stdout?.on('data', chunk => {
        this.emitProgress({ agentId, phase: 'installing', message: oneLine(String(chunk)) });
      });
      child.stderr?.on('data', chunk => {
        this.emitProgress({ agentId, phase: 'installing', message: oneLine(String(chunk)) });
      });

      child.on('error', error => {
        const message = `Failed to start npm for ${descriptor.displayName}: ${error.message}`;
        this.emitProgress({ agentId, phase: 'error', message });
        resolve({ success: false, agentId, error: message });
      });

      child.on('close', (code, signal) => {
        if (signal === 'SIGTERM') {
          resolve({ success: false, agentId, cancelled: true, error: 'Installation cancelled.' });
          return;
        }
        if (code !== 0) {
          const message = `${descriptor.displayName} install failed with exit code ${code ?? 'unknown'}.`;
          this.emitProgress({ agentId, phase: 'error', message });
          resolve({ success: false, agentId, error: message });
          return;
        }

        this.emitProgress({ agentId, phase: 'verifying', message: `Verifying ${descriptor.binaryName}.` });
        const binaryPath = managedBinaryPath(agentId, descriptor.binaryName, this.env);
        if (!executableFileExists(binaryPath)) {
          const message = `${descriptor.displayName} installed, but ${descriptor.binaryName} was not found at ${binaryPath}.`;
          this.emitProgress({ agentId, phase: 'error', message });
          resolve({ success: false, agentId, error: message });
          return;
        }

        const version = readCommandVersion(binaryPath, this.env);
        const record: RuntimeInstallRecord = {
          agentId,
          packageName: descriptor.packageName,
          binaryPath,
          version,
          installedAt: new Date().toISOString(),
        };
        writeJsonFile(runtimeInstallRecordPath(agentId, this.env), record, 0o644);
        invalidateRuntimeDiscoveryCache(agentId);
        this.emitProgress({
          agentId,
          phase: 'success',
          message: `${descriptor.displayName} is ready.`,
          detail: version ?? binaryPath,
        });
        resolve({ success: true, agentId, binaryPath, version });
      });
    });
  }

  private emitProgress(progress: InstallProgress): void {
    this.emit('progress', progress);
  }
}
