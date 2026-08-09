import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';
import { wesightHome } from '../paths';

export const KNOWLEDGE_DRAFT_BEGIN = 'KB_DRAFT_JSON_BEGIN';
export const KNOWLEDGE_DRAFT_END = 'KB_DRAFT_JSON_END';
export const MAX_DRAFT_WRITES = 64;
export const MAX_DRAFT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface KnowledgeDraftWrite {
  path: string;
  mode: 'create' | 'replace';
  content: string;
  purpose?: string;
}

export interface KnowledgeDraftV1 {
  schema: 'wesight.knowledge-draft.v1';
  operationType: 'ingest' | 'save';
  writes: KnowledgeDraftWrite[];
  addressRequests?: unknown[];
  sourceManifestUpdates?: Record<string, unknown>;
  riskWarnings?: string[];
}

export interface TransactionBundle {
  bundlePath: string;
  operation: Record<string, unknown>;
  draft: KnowledgeDraftV1;
}

export function normalizeIngestRawSnapshot(
  draft: KnowledgeDraftV1,
  rawSnapshotPath: string,
  noteContent: string,
  snapshotAlreadyExists: boolean,
  sourceSha256: string,
): void {
  if (snapshotAlreadyExists) {
    draft.writes = draft.writes.filter(write => write.path !== rawSnapshotPath);
  } else {
    const existing = draft.writes.find(write => write.path === rawSnapshotPath);
    if (existing) {
      existing.mode = 'create';
      existing.content = noteContent;
      existing.purpose = existing.purpose ?? 'Immutable source snapshot';
    } else {
      draft.writes.unshift({
        path: rawSnapshotPath,
        mode: 'create',
        content: noteContent,
        purpose: 'Immutable source snapshot',
      });
    }
  }
  const pagesCreated = draft.writes
    .filter(write => write.mode === 'create' && write.path.startsWith('wiki/') && !write.path.startsWith('wiki/meta/'))
    .map(write => write.path);
  draft.sourceManifestUpdates = {
    [rawSnapshotPath]: { hash: sourceSha256, pages_created: pagesCreated },
  };
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function hashFile(filePath: string): Promise<string | null> {
  try {
    return sha256(await fsp.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function safeOperationId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  return `${prefix}-${timestamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function normalizePortableRelative(rawPath: string): string {
  if (!rawPath || rawPath.length > 512 || rawPath.includes('\0') || path.isAbsolute(rawPath)) {
    throw new Error(`事务路径无效：${rawPath || '(empty)'}`);
  }
  const relative = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new Error(`事务路径越界：${rawPath}`);
  }
  return normalized;
}

function normalizeDraftPath(vaultPath: string, rawPath: string): { relative: string; absolute: string } {
  const normalized = normalizePortableRelative(rawPath);
  const absolute = path.resolve(vaultPath, ...normalized.split('/'));
  const root = path.resolve(vaultPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`事务路径越界：${rawPath}`);
  }
  return { relative: normalized, absolute };
}

function validateDraft(raw: unknown, expectedType: 'ingest' | 'save'): KnowledgeDraftV1 {
  if (!raw || typeof raw !== 'object') throw new Error('Agent 草稿必须是 JSON 对象。');
  const value = raw as Record<string, unknown>;
  if (value.schema !== 'wesight.knowledge-draft.v1') throw new Error('Agent 草稿 schema 不正确。');
  if (value.operationType !== expectedType) throw new Error('Agent 草稿操作类型不匹配。');
  if (!Array.isArray(value.writes) || value.writes.length === 0) throw new Error('Agent 草稿没有写入内容。');
  if (value.writes.length > MAX_DRAFT_WRITES) throw new Error(`Agent 草稿超过 ${MAX_DRAFT_WRITES} 个写入。`);
  const seen = new Set<string>();
  const writes = value.writes.map((item, index): KnowledgeDraftWrite => {
    if (!item || typeof item !== 'object') throw new Error(`Agent 草稿第 ${index + 1} 项格式不正确。`);
    const write = item as Record<string, unknown>;
    if (typeof write.path !== 'string' || typeof write.content !== 'string') {
      throw new Error(`Agent 草稿第 ${index + 1} 项缺少路径或内容。`);
    }
    const normalizedPath = normalizePortableRelative(write.path);
    const mode = write.mode === 'replace' ? 'replace' : write.mode === 'create' ? 'create' : null;
    if (!mode) throw new Error(`Agent 草稿第 ${index + 1} 项 mode 无效。`);
    const key = normalizedPath.toLowerCase();
    if (seen.has(key)) throw new Error(`Agent 草稿包含重复路径：${normalizedPath}`);
    seen.add(key);
    return {
      path: normalizedPath,
      mode,
      content: write.content,
      purpose: typeof write.purpose === 'string' ? write.purpose : undefined,
    };
  });
  const addressRequests = Array.isArray(value.addressRequests) ? value.addressRequests : [];
  if (addressRequests.length > MAX_DRAFT_WRITES) throw new Error('Agent 草稿地址请求过多。');
  for (const rawRequest of addressRequests) {
    const request = rawRequest && typeof rawRequest === 'object' ? rawRequest as Record<string, unknown> : null;
    const requestPath = typeof request?.path === 'string' ? normalizePortableRelative(request.path) : '';
    if (!requestPath.startsWith('wiki/')) throw new Error('Agent 草稿地址请求路径无效。');
  }
  const sourceManifestUpdates = value.sourceManifestUpdates && typeof value.sourceManifestUpdates === 'object' && !Array.isArray(value.sourceManifestUpdates)
    ? value.sourceManifestUpdates as Record<string, unknown>
    : {};
  if (Object.keys(sourceManifestUpdates).length > MAX_DRAFT_WRITES) throw new Error('Agent 草稿来源清单更新过多。');
  for (const [sourceId, update] of Object.entries(sourceManifestUpdates)) {
    if (
      !sourceId.trim()
      || sourceId.includes('\0')
      || Buffer.byteLength(sourceId, 'utf8') > 1_024
      || !update
      || typeof update !== 'object'
      || Array.isArray(update)
    ) {
      throw new Error('Agent 草稿来源清单更新格式无效。');
    }
  }
  return {
    schema: 'wesight.knowledge-draft.v1',
    operationType: expectedType,
    writes,
    addressRequests,
    sourceManifestUpdates,
    riskWarnings: Array.isArray(value.riskWarnings)
      ? value.riskWarnings.filter((item): item is string => typeof item === 'string').slice(0, 64).map(item => item.slice(0, 500))
      : [],
  };
}

export function parseKnowledgeDraft(text: string, expectedType: 'ingest' | 'save'): KnowledgeDraftV1 {
  if (Buffer.byteLength(text, 'utf8') > MAX_DRAFT_OUTPUT_BYTES) {
    throw new Error('Agent 草稿超过 2 MiB 输出限制。');
  }
  const start = text.indexOf(KNOWLEDGE_DRAFT_BEGIN);
  const end = text.indexOf(KNOWLEDGE_DRAFT_END);
  if (start < 0 || end < 0 || end <= start) throw new Error('Agent 草稿缺少固定边界标记。');
  if (text.indexOf(KNOWLEDGE_DRAFT_BEGIN, start + KNOWLEDGE_DRAFT_BEGIN.length) >= 0) {
    throw new Error('Agent 草稿包含多个开始标记。');
  }
  const json = text.slice(start + KNOWLEDGE_DRAFT_BEGIN.length, end).trim();
  return validateDraft(JSON.parse(json), expectedType);
}

export async function buildTransactionFromDraft(
  vaultPath: string,
  draft: KnowledgeDraftV1,
): Promise<TransactionBundle> {
  const expectedHashes: Record<string, string | null> = {};
  const writes: Array<Record<string, unknown>> = [];
  for (const proposal of draft.writes) {
    const target = normalizeDraftPath(vaultPath, proposal.path);
    if (draft.operationType === 'save' && !target.relative.startsWith('wiki/')) {
      throw new Error(`保存操作只能写入 wiki/：${target.relative}`);
    }
    if (draft.operationType === 'ingest' && !target.relative.startsWith('wiki/') && !target.relative.startsWith('.raw/')) {
      throw new Error(`收录操作只能写入 wiki/ 或 .raw/：${target.relative}`);
    }
    if (target.relative.startsWith('.raw/') && proposal.mode !== 'create') {
      throw new Error(`原始资料只能新增：${target.relative}`);
    }
    const currentHash = await hashFile(target.absolute);
    if (proposal.mode === 'create' && currentHash !== null) throw new Error(`新增目标已存在：${target.relative}`);
    if (proposal.mode === 'replace' && currentHash === null) throw new Error(`更新目标不存在：${target.relative}`);
    expectedHashes[target.relative] = currentHash;
    writes.push({
      path: target.relative,
      mode: proposal.mode,
      content: proposal.content,
      sha256: sha256(proposal.content),
    });
  }
  const operation = {
    schema: 'claude-obsidian.transaction.v1',
    operation_id: safeOperationId(draft.operationType),
    operation_type: draft.operationType,
    expected_hashes: expectedHashes,
    writes,
    address_requests: draft.addressRequests ?? [],
    source_manifest_updates: draft.sourceManifestUpdates ?? {},
  };
  const tempDir = path.join(wesightHome(), 'tmp', 'knowledge-brain', 'transactions');
  await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
  await fsp.chmod(tempDir, 0o700);
  const bundlePath = path.join(tempDir, `${operation.operation_id}.json`);
  await fsp.writeFile(bundlePath, JSON.stringify(operation, null, 2), { mode: 0o600 });
  await fsp.chmod(bundlePath, 0o600);
  return { bundlePath, operation, draft };
}
