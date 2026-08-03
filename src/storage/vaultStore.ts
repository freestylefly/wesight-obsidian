import { promises as fs } from 'fs';
import path from 'path';

import type { DataAdapter } from 'obsidian';

import type { ChatImageArtifact, ChatMessage, StoredConversation } from '../types';
import { createId } from '../utils/id';
import type { SlashCommand } from '../utils/slashCommands';

interface ConversationFile {
  version: 1;
  conversations: StoredConversation[];
}

const CONVERSATIONS_PATH = '.wesight/conversations.json';
const COMMANDS_PATH = '.wesight/commands.json';
const MENTION_CACHE_PATH = '.wesight/mention-cache.json';
const GENERATED_IMAGES_PATH = '.wesight/generated-images';
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;

export class VaultStore {
  constructor(private readonly adapter: DataAdapter) {}

  async listConversations(): Promise<StoredConversation[]> {
    const file = await this.readConversationsFile();
    return file.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConversation(id: string): Promise<StoredConversation | null> {
    const file = await this.readConversationsFile();
    return file.conversations.find(conversation => conversation.id === id) ?? null;
  }

  /**
   * Builds an in-memory conversation without touching disk. Empty sessions are
   * never persisted; the first replaceConversation() call after a message is
   * sent inserts it into the store.
   */
  createDraftConversation(agentId: StoredConversation['agentId']): StoredConversation {
    const now = Date.now();
    return {
      id: createId('conv'),
      title: 'New WeSight session',
      agentId,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  async appendMessage(conversationId: string, message: ChatMessage): Promise<StoredConversation> {
    const file = await this.readConversationsFile();
    let conversation = file.conversations.find(item => item.id === conversationId);
    if (!conversation) {
      conversation = {
        id: conversationId,
        title: message.content.slice(0, 60) || 'WeSight session',
        agentId: message.agentId ?? 'claude',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      file.conversations.unshift(conversation);
    }
    conversation.messages.push(message);
    conversation.updatedAt = Date.now();
    if (!conversation.title || conversation.title === 'New WeSight session') {
      conversation.title = message.content.replace(/\s+/g, ' ').trim().slice(0, 60) || conversation.title;
    }
    await this.writeConversationsFile(file);
    return conversation;
  }

  async replaceConversation(conversation: StoredConversation): Promise<void> {
    const file = await this.readConversationsFile();
    const index = file.conversations.findIndex(item => item.id === conversation.id);
    conversation.updatedAt = Date.now();
    if (index >= 0) {
      file.conversations[index] = conversation;
    } else {
      file.conversations.unshift(conversation);
    }
    await this.writeConversationsFile(file);
  }

  async deleteConversation(id: string): Promise<void> {
    const file = await this.readConversationsFile();
    file.conversations = file.conversations.filter(item => item.id !== id);
    await this.writeConversationsFile(file);
  }

  async listCommands(): Promise<SlashCommand[]> {
    return this.readJsonFile<SlashCommand[]>(COMMANDS_PATH, []);
  }

  async saveCommands(commands: SlashCommand[]): Promise<void> {
    await this.writeJsonFile(COMMANDS_PATH, commands);
  }

  async readMentionCache(): Promise<Record<string, unknown>> {
    return this.readJsonFile<Record<string, unknown>>(MENTION_CACHE_PATH, {});
  }

  async writeMentionCache(cache: Record<string, unknown>): Promise<void> {
    await this.writeJsonFile(MENTION_CACHE_PATH, cache);
  }

  async importGeneratedImage(
    conversationId: string,
    artifact: { itemId: string; sourcePath: string; mimeType?: string; revisedPrompt?: string },
  ): Promise<ChatImageArtifact> {
    if (!path.isAbsolute(artifact.sourcePath)) {
      throw new Error('Codex returned a non-absolute image path.');
    }
    const stat = await fs.stat(artifact.sourcePath);
    if (!stat.isFile()) throw new Error('Codex image path does not point to a file.');
    if (stat.size <= 0 || stat.size > MAX_GENERATED_IMAGE_BYTES) {
      throw new Error('Codex image size is invalid or exceeds 25 MB.');
    }
    const bytes = await fs.readFile(artifact.sourcePath);
    if (bytes.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('Codex image exceeds 25 MB.');
    const detected = detectImageFormat(bytes);
    if (!detected) throw new Error('Codex returned an unsupported image format.');
    if (artifact.mimeType && artifact.mimeType !== detected.mimeType) {
      throw new Error('Codex image MIME type does not match its file contents.');
    }

    const safeConversationId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'conversation';
    const directory = `${GENERATED_IMAGES_PATH}/${safeConversationId}`;
    await this.ensureDirectory(directory);
    const filename = `${Date.now()}-${createId('image')}${detected.extension}`;
    const vaultPath = `${directory}/${filename}`;
    const arrayBuffer = Uint8Array.from(bytes).buffer;
    await this.adapter.writeBinary(vaultPath, arrayBuffer);
    return {
      id: artifact.itemId || createId('artifact'),
      type: 'image',
      vaultPath,
      mimeType: detected.mimeType,
      createdAt: Date.now(),
      revisedPrompt: artifact.revisedPrompt,
    };
  }

  getResourcePath(vaultPath: string): string {
    return this.adapter.getResourcePath(vaultPath);
  }

  private async readConversationsFile(): Promise<ConversationFile> {
    try {
      if (!(await this.adapter.exists(CONVERSATIONS_PATH))) {
        return { version: 1, conversations: [] };
      }
      const parsed = JSON.parse(await this.adapter.read(CONVERSATIONS_PATH)) as ConversationFile;
      return {
        version: 1,
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      };
    } catch {
      return { version: 1, conversations: [] };
    }
  }

  private async writeConversationsFile(file: ConversationFile): Promise<void> {
    await this.writeJsonFile(CONVERSATIONS_PATH, file);
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      if (!(await this.adapter.exists(filePath))) {
        return fallback;
      }
      return JSON.parse(await this.adapter.read(filePath)) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    if (!(await this.adapter.exists('.wesight'))) {
      await this.adapter.mkdir('.wesight');
    }
    await this.adapter.write(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    const parts = directory.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current))) {
        try {
          await this.adapter.mkdir(current);
        } catch (error) {
          if (!(await this.adapter.exists(current))) throw error;
        }
      }
    }
  }
}

function detectImageFormat(bytes: Uint8Array): { mimeType: string; extension: string } | null {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return { mimeType: 'image/png', extension: '.png' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) return { mimeType: 'image/webp', extension: '.webp' };
  return null;
}
