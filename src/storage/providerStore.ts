import fs from 'fs';

import { providersPath } from '../paths';
import type { AgentId, ExportedProviderProfile, ProviderProfile, ProviderWireApi } from '../types';
import { createId } from '../utils/id';
import { readJsonFile, writeJsonFile } from '../utils/fs';

interface ProviderStoreFile {
  version: 1;
  profiles: ProviderProfile[];
}

const EMPTY_STORE: ProviderStoreFile = {
  version: 1,
  profiles: [],
};

export interface ProviderProfileInput {
  agentId: AgentId;
  id?: string;
  name: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  models?: string[];
  wireApi?: ProviderWireApi;
  isDefault?: boolean;
}

function normalizeModels(models: unknown, activeModel: string): string[] {
  const list = Array.isArray(models)
    ? models.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : [];
  if (activeModel && !list.includes(activeModel)) {
    list.unshift(activeModel);
  }
  return [...new Set(list)];
}

function inferWireApi(baseUrl: string, explicit?: unknown): ProviderWireApi {
  if (explicit === 'responses' || explicit === 'chat') {
    return explicit;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com' ? 'responses' : 'chat';
  } catch {
    return 'chat';
  }
}

function normalizeProfile(profile: ProviderProfile): ProviderProfile {
  const defaultModel = (profile.defaultModel ?? profile.model ?? '').trim();
  return {
    id: profile.id,
    agentId: profile.agentId,
    name: profile.name,
    apiKey: profile.apiKey ?? '',
    baseUrl: profile.baseUrl ?? '',
    model: defaultModel,
    defaultModel,
    models: normalizeModels(profile.models, defaultModel),
    wireApi: inferWireApi(profile.baseUrl ?? '', profile.wireApi),
    isDefault: Boolean(profile.isDefault),
    createdAt: Number(profile.createdAt) || Date.now(),
    updatedAt: Number(profile.updatedAt) || Date.now(),
  };
}

function cloneProfile(profile: ProviderProfile): ProviderProfile {
  return { ...profile, models: [...profile.models] };
}

interface ProviderReadCache {
  mtimeMs: number;
  size: number;
  profiles: ProviderProfile[];
}

export class ProviderStore {
  // list()/find() are called several times per UI render and each read hits the
  // disk synchronously, so cache the parsed file keyed on its stat signature.
  private readCache: ProviderReadCache | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  get path(): string {
    return providersPath(this.env);
  }

  list(agentId?: AgentId): ProviderProfile[] {
    const profiles = this.read().profiles.map(normalizeProfile);
    return agentId ? profiles.filter(profile => profile.agentId === agentId) : profiles;
  }

  find(agentId: AgentId, idOrName?: string): ProviderProfile | null {
    const profiles = this.list(agentId);
    if (idOrName?.trim()) {
      const needle = idOrName.trim();
      return profiles.find(profile => profile.id === needle || profile.name === needle) ?? null;
    }
    return profiles.find(profile => profile.isDefault) ?? profiles[0] ?? null;
  }

  save(input: ProviderProfileInput): ProviderProfile {
    const store = this.read();
    const now = Date.now();
    const defaultModel = (input.defaultModel ?? input.model ?? '').trim();
    const profile: ProviderProfile = {
      id: input.id?.trim() || createId('profile'),
      agentId: input.agentId,
      name: input.name.trim(),
      apiKey: input.apiKey ?? '',
      baseUrl: input.baseUrl ?? '',
      model: defaultModel,
      defaultModel,
      models: normalizeModels(input.models, defaultModel),
      wireApi: inferWireApi(input.baseUrl ?? '', input.wireApi),
      isDefault: Boolean(input.isDefault),
      createdAt: now,
      updatedAt: now,
    };

    if (!profile.name) {
      throw new Error('Provider profile name is required.');
    }

    const existingIndex = store.profiles.findIndex(item => item.id === profile.id);
    const currentForAgent = store.profiles.filter(item => item.agentId === profile.agentId);
    if (currentForAgent.length === 0) {
      profile.isDefault = true;
    }

    if (existingIndex >= 0) {
      profile.createdAt = store.profiles[existingIndex]?.createdAt ?? now;
      store.profiles[existingIndex] = profile;
    } else {
      store.profiles.push(profile);
    }

    if (profile.isDefault) {
      for (const item of store.profiles) {
        if (item.agentId === profile.agentId && item.id !== profile.id) {
          item.isDefault = false;
        }
      }
    }

    this.write(store);
    return profile;
  }

  remove(id: string): ProviderProfile | null {
    const store = this.read();
    const index = store.profiles.findIndex(profile => profile.id === id);
    if (index < 0) return null;
    const [removed] = store.profiles.splice(index, 1);
    const siblings = store.profiles.filter(profile => profile.agentId === removed.agentId);
    if (removed.isDefault && siblings.length > 0 && !siblings.some(profile => profile.isDefault)) {
      siblings[0].isDefault = true;
    }
    this.write(store);
    return removed;
  }

  setActiveModel(id: string, model: string): ProviderProfile {
    const store = this.read();
    const target = store.profiles.find(profile => profile.id === id);
    if (!target) {
      throw new Error(`Provider profile not found: ${id}`);
    }
    target.model = model.trim();
    target.defaultModel = target.model;
    target.models = normalizeModels(target.models, target.defaultModel);
    target.updatedAt = Date.now();
    this.write(store);
    return normalizeProfile(target);
  }

  setDefault(agentId: AgentId, id: string): ProviderProfile {
    const store = this.read();
    const target = store.profiles.find(profile => profile.agentId === agentId && profile.id === id);
    if (!target) {
      throw new Error(`Provider profile not found: ${id}`);
    }
    for (const profile of store.profiles) {
      if (profile.agentId === agentId) {
        profile.isDefault = profile.id === id;
        profile.updatedAt = Date.now();
      }
    }
    this.write(store);
    return target;
  }

  exportProfiles(options: { includeSecrets?: boolean } = {}): ExportedProviderProfile[] {
    return this.list().map(profile => {
      if (options.includeSecrets) {
        return { ...profile };
      }
      return {
        id: profile.id,
        agentId: profile.agentId,
        name: profile.name,
        baseUrl: profile.baseUrl,
        model: profile.model,
        defaultModel: profile.defaultModel,
        models: profile.models,
        wireApi: profile.wireApi,
        isDefault: profile.isDefault,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        apiKey: '',
        apiKeyRedacted: Boolean(profile.apiKey),
      };
    });
  }

  importProfiles(profiles: ExportedProviderProfile[]): ProviderProfile[] {
    const imported: ProviderProfile[] = [];
    for (const profile of profiles) {
      imported.push(this.save({
        agentId: profile.agentId,
        id: profile.id,
        name: profile.name,
        apiKey: profile.apiKeyRedacted ? '' : profile.apiKey ?? '',
        baseUrl: profile.baseUrl,
        model: profile.model,
        defaultModel: profile.defaultModel,
        models: profile.models,
        wireApi: profile.wireApi,
        isDefault: profile.isDefault,
      }));
    }
    return imported;
  }

  private read(): ProviderStoreFile {
    const stat = this.statStore();
    if (!stat) {
      this.readCache = null;
      return { version: 1, profiles: [] };
    }
    if (this.readCache && this.readCache.mtimeMs === stat.mtimeMs && this.readCache.size === stat.size) {
      return { version: 1, profiles: this.readCache.profiles.map(cloneProfile) };
    }
    const store = readJsonFile<ProviderStoreFile>(this.path, EMPTY_STORE);
    const profiles = Array.isArray(store.profiles) ? store.profiles.map(normalizeProfile) : [];
    this.readCache = { mtimeMs: stat.mtimeMs, size: stat.size, profiles: profiles.map(cloneProfile) };
    return { version: 1, profiles };
  }

  private write(store: ProviderStoreFile): void {
    writeJsonFile(this.path, store, 0o600);
    try {
      fs.chmodSync(this.path, 0o600);
    } catch {
      // Best-effort secret-store hardening.
    }
    const stat = this.statStore();
    this.readCache = stat
      ? { mtimeMs: stat.mtimeMs, size: stat.size, profiles: store.profiles.map(profile => cloneProfile(normalizeProfile(profile))) }
      : null;
  }

  private statStore(): fs.Stats | null {
    try {
      return fs.statSync(this.path);
    } catch {
      return null;
    }
  }
}
