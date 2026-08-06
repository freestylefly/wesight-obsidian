import os from 'os';
import path from 'path';

import type { AgentId } from './types';

export function wesightHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.WESIGHT_HOME?.trim();
  return configured ? expandHome(configured) : path.join(os.homedir(), '.wesight');
}

export function runtimeManagedDir(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'runtimes', agentId);
}

export function runtimeInstallRecordPath(agentId: AgentId, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeManagedDir(agentId, env), 'install.json');
}

export function managedBinaryPath(agentId: AgentId, binaryName: string, env: NodeJS.ProcessEnv = process.env): string {
  const binary = process.platform === 'win32' ? `${binaryName}.cmd` : binaryName;
  return path.join(runtimeManagedDir(agentId, env), 'node_modules', '.bin', binary);
}

export function larkCliAuthorizationRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'lark', 'authorization.json');
}

export function providersPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'providers.json');
}

export function logsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'logs');
}

export function tmpDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'tmp');
}

export function wechatThemeCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(wesightHome(env), 'cache', 'wechat-themes');
}

export function vaultWesightDir(vaultBasePath: string): string {
  return path.join(vaultBasePath, '.wesight');
}

 export function vaultPluginDir(configDir: string, pluginId: string): string {
   return path.join(configDir, 'plugins', pluginId);
 }

export function vaultTemplateThemePacksDir(pluginDir: string): string {
  return path.join(pluginDir, 'assets', 'theme');
}

export function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
