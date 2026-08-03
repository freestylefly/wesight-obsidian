import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DataAdapter } from 'obsidian';
import { VaultStore } from '../src/storage/vaultStore';

class MemoryAdapter {
  readonly directories = new Set<string>();
  readonly binaries = new Map<string, ArrayBuffer>();
  readonly texts = new Map<string, string>();

  async exists(target: string): Promise<boolean> {
    return this.directories.has(target) || this.binaries.has(target) || this.texts.has(target);
  }

  async mkdir(target: string): Promise<void> {
    this.directories.add(target);
  }

  async writeBinary(target: string, value: ArrayBuffer): Promise<void> {
    this.binaries.set(target, value);
  }

  async write(target: string, value: string): Promise<void> {
    this.texts.set(target, value);
  }

  async read(target: string): Promise<string> {
    const value = this.texts.get(target);
    if (value === undefined) throw new Error(`Missing ${target}`);
    return value;
  }

  getResourcePath(target: string): string {
    return `app://vault/${target}`;
  }
}

describe('VaultStore generated images', () => {
  let tempDir: string;
  let sourcePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-image-artifact-'));
    sourcePath = path.join(tempDir, 'result.png');
    fs.writeFileSync(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('validates and copies an image into a conversation-scoped Vault path', async () => {
    const adapter = new MemoryAdapter();
    const store = new VaultStore(adapter as unknown as DataAdapter);

    const artifact = await store.importGeneratedImage('conversation/unsafe', {
      itemId: 'image-1',
      sourcePath,
      mimeType: 'image/png',
      revisedPrompt: 'A quiet mountain lake',
    });

    expect(artifact).toMatchObject({
      id: 'image-1',
      type: 'image',
      mimeType: 'image/png',
      revisedPrompt: 'A quiet mountain lake',
    });
    expect(artifact.vaultPath).toMatch(/^\.wesight\/generated-images\/conversation_unsafe\/.+\.png$/);
    expect(adapter.binaries.get(artifact.vaultPath)?.byteLength).toBe(8);
    expect(store.getResourcePath(artifact.vaultPath)).toBe(`app://vault/${artifact.vaultPath}`);

    await store.replaceConversation({
      id: 'conversation/unsafe',
      title: 'Generated image',
      agentId: 'codex',
      createdAt: 1,
      updatedAt: 1,
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: '',
        createdAt: 1,
        agentId: 'codex',
        metadata: { artifacts: [artifact] },
      }],
    });
    const restartedStore = new VaultStore(adapter as unknown as DataAdapter);
    const restored = await restartedStore.getConversation('conversation/unsafe');
    expect(restored?.messages[0]?.metadata?.artifacts).toEqual([artifact]);
  });

  test('rejects relative, mismatched, and unsupported image files', async () => {
    const store = new VaultStore(new MemoryAdapter() as unknown as DataAdapter);

    await expect(store.importGeneratedImage('conversation', {
      itemId: 'relative',
      sourcePath: 'result.png',
    })).rejects.toThrow('non-absolute');
    await expect(store.importGeneratedImage('conversation', {
      itemId: 'mismatch',
      sourcePath,
      mimeType: 'image/jpeg',
    })).rejects.toThrow('does not match');
    const textPath = path.join(tempDir, 'result.webp');
    fs.writeFileSync(textPath, 'not an image');
    await expect(store.importGeneratedImage('conversation', {
      itemId: 'unsupported',
      sourcePath: textPath,
    })).rejects.toThrow('unsupported');
  });
});
