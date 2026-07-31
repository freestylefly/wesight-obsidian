import type { DataAdapter } from 'obsidian';

import type { ChatMessage, StoredConversation } from '../types';
import { createId } from '../utils/id';
import type { SlashCommand } from '../utils/slashCommands';

interface ConversationFile {
  version: 1;
  conversations: StoredConversation[];
}

const CONVERSATIONS_PATH = '.wesight/conversations.json';
const COMMANDS_PATH = '.wesight/commands.json';
const MENTION_CACHE_PATH = '.wesight/mention-cache.json';

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
}
