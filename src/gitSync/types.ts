export interface GitSyncTarget {
  root: string;
  branch: string;
  remote: string;
  remoteBranch: string;
  remoteUrlHash: string;
}

export interface GitSyncSettings {
  autoPull: boolean;
  pullOnOpen: boolean;
  autoPush: boolean;
  autoCommit: boolean;
  intervalMinutes: number;
  idleMinutes: number;
  excludedPaths: string[];
  commitMessage: string;
  target: GitSyncTarget | null;
}

export const DEFAULT_GIT_SYNC_SETTINGS: GitSyncSettings = {
  autoPull: false,
  pullOnOpen: false,
  autoPush: false,
  autoCommit: false,
  intervalMinutes: 5,
  idleMinutes: 5,
  excludedPaths: ['.wesight/', '.env', '.env.*'],
  commitMessage: '知识库更新 · {device} · {time}',
  target: null,
};

export interface GitSyncChange {
  path: string;
  index: string;
  working: string;
  untracked: boolean;
  conflict: boolean;
}

export interface GitSyncHistory {
  at: number;
  action: string;
  ok: boolean;
  message: string;
}

/** Recognizes the stored network failure emitted by automatic synchronization. */
export function isAutomaticOfflineHistory(entry: GitSyncHistory): boolean {
  return entry.action === '自动同步' && !entry.ok
    && [
      '无法连接远程仓库，请检查网络；自动同步将在下次检查时重试。',
      '无法连接远程仓库，请检查网络。',
      '无法连接远程仓库，请检查网络',
      '当前离线，已跳过自动同步。',
    ].includes(entry.message);
}

export interface GitSyncState {
  available: boolean;
  root: string | null;
  branch: string | null;
  remote: string | null;
  remoteBranch: string | null;
  remoteUrl: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitSyncChange[];
  operation: string | null;
  pausedReason: string | null;
  error: string | null;
  checkedAt: number | null;
  remoteCheckedAt: number | null;
  history: GitSyncHistory[];
}

export interface GitSyncResult {
  ok: boolean;
  message: string;
  skipped?: boolean;
}

export function parseGitChanges(porcelain: string): GitSyncChange[] {
  const records = porcelain.split('\0');
  const changes: GitSyncChange[] = [];
  const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const pair = record.slice(0, 2);
    changes.push({
      path: record.slice(3),
      index: pair[0],
      working: pair[1],
      untracked: pair === '??',
      conflict: conflicts.has(pair),
    });
    if (pair.includes('R') || pair.includes('C')) i++;
  }
  return changes;
}

/** Matches vault-relative paths; directories end in / and * is supported. */
export function isSyncPathExcluded(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return patterns.some(raw => {
    const pattern = raw.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
    if (!pattern) return false;
    if (pattern.endsWith('/')) return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    const expression = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${expression}$`).test(normalized);
  });
}

export function gitSyncSummary(state: GitSyncState): string {
  if (state.operation) return `${state.operation}…`;
  if (state.error) return state.error;
  if (state.pausedReason) return state.pausedReason;
  if (state.behind > 0) return `有 ${state.behind} 个团队提交待拉取`;
  if (state.ahead > 0) return `有 ${state.ahead} 个本地提交待推送`;
  if (state.changes.length) return `有 ${state.changes.length} 个文件尚未提交`;
  return state.available ? '当前分支与远程一致' : '正在检测当前仓库';
}
