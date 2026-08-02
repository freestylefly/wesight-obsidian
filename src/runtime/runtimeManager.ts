import type { AgentStatus, ChatTurnRequest, ProviderProfile, RuntimeTurnEvent, WeSightObsidianSettings } from '../types';
import { ProviderStore } from '../storage/providerStore';
import { appendLocalLog } from '../storage/localLog';
import { providerHost, requiresProviderApiKey, resolveAnthropicAuthMode } from '../utils/providerAuth';
import { RuntimeDiscovery } from './discovery';
import { AgentAdapter } from './adapter';

export type RuntimeEventListener = (event: RuntimeTurnEvent) => void;

export class RuntimeManager {
  // Multiple turns can be in flight at once (chat + inline edit), so track every
  // live adapter instead of only the most recent one.
  private readonly activeAdapters = new Set<AgentAdapter>();
  private readonly cooldownByProfile = new Map<string, number>();

  constructor(
    private readonly providerStore: ProviderStore,
    private getSettings: () => WeSightObsidianSettings,
  ) {}

  resolveStatus(request: ChatTurnRequest): AgentStatus {
    const settings = this.getSettings();
    return new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(request.agentId);
  }

  /**
   * Runs one turn and delivers its events only to the provided listener, so
   * concurrent runs (for example chat and inline edit) never see each other's
   * output.
   */
  async runTurn(request: ChatTurnRequest, onEvent: RuntimeEventListener): Promise<void> {
    const deliver = (event: RuntimeTurnEvent): void => {
      if (event.type === 'error') {
        if (event.providerProfileId && event.retryAfterSeconds) {
          this.cooldownByProfile.set(event.providerProfileId, Date.now() + event.retryAfterSeconds * 1_000);
        }
        appendLocalLog('runtime_error', {
          message: event.message,
          detail: event.detail,
          statusCode: event.statusCode,
          retryAfterSeconds: event.retryAfterSeconds,
          requestId: event.requestId,
          providerProfileId: event.providerProfileId,
          diagnostic: event.diagnostic,
        });
      }
      onEvent(event);
    };

    if (request.signal?.aborted) {
      deliver({ type: 'done' });
      return;
    }

    const settings = this.getSettings();
    const status = new RuntimeDiscovery({
      configuredPaths: settings.configuredPaths,
      configSources: settings.configSources,
    }).resolve(request.agentId);
    if (!status.binaryPath) {
      appendLocalLog('runtime_missing', { agentId: request.agentId, error: status.error });
      deliver({
        type: 'error',
        message: `${status.descriptor.displayName} is not installed.`,
        detail: status.error ?? undefined,
      });
      return;
    }

    const profile = this.resolveProviderProfile(request);
    if (request.configSource === 'providerProfile' && !profile) {
      appendLocalLog('runtime_profile_missing', {
        agentId: request.agentId,
        providerProfileId: request.providerProfileId ?? null,
      });
      deliver({
        type: 'error',
        message: 'The selected provider profile no longer exists.',
        detail: 'Pick another profile from the model selector or switch back to Local CLI.',
      });
      return;
    }
    if (profile && requiresProviderApiKey(profile.baseUrl) && !profile.apiKey.trim()) {
      deliver({
        type: 'error',
        message: `${profile.name} API Key 缺失，请在 WeSight 设置中重新输入后再试。`,
        providerProfileId: profile.id,
      });
      return;
    }
    if (profile) {
      const cooldownUntil = this.cooldownByProfile.get(profile.id) ?? 0;
      if (cooldownUntil > Date.now()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1_000));
        deliver({
          type: 'error',
          message: `${profile.name} 仍在冷却中，请等待 ${retryAfterSeconds} 秒后再试。`,
          statusCode: 429,
          retryAfterSeconds,
          providerProfileId: profile.id,
        });
        return;
      }
      this.cooldownByProfile.delete(profile.id);
    }
    const adapter = new AgentAdapter({
      agentId: request.agentId,
      binaryPath: status.binaryPath,
      sharedEnvironmentVariables: settings.sharedEnvironmentVariables,
      providerProfile: profile,
    });
    const cancelAdapter = (): void => adapter.cancel();
    request.signal?.addEventListener('abort', cancelAdapter, { once: true });
    this.activeAdapters.add(adapter);
    const startedAt = Date.now();
    appendLocalLog('runtime_turn_start', {
      agentId: request.agentId,
      configSource: request.configSource,
      providerProfileId: profile?.id,
      providerName: profile?.name,
      providerHost: profile ? providerHost(profile.baseUrl) : null,
      model: profile?.defaultModel || profile?.model || request.model || null,
      anthropicAuthMode: profile?.agentId === 'claude' ? resolveAnthropicAuthMode(profile) : null,
    });
    const unsubscribe = adapter.onRuntimeEvent(deliver);
    try {
      await adapter.run(request);
      appendLocalLog('runtime_turn_finish', {
        agentId: request.agentId,
        providerProfileId: profile?.id,
        durationMs: Date.now() - startedAt,
        cancelled: Boolean(request.signal?.aborted),
      });
    } finally {
      request.signal?.removeEventListener('abort', cancelAdapter);
      unsubscribe();
      this.activeAdapters.delete(adapter);
    }
  }

  cancel(): void {
    for (const adapter of this.activeAdapters) {
      adapter.cancel();
    }
  }

  private resolveProviderProfile(request: ChatTurnRequest): ProviderProfile | null {
    if (request.configSource !== 'providerProfile') return null;
    const selected = request.providerProfileId?.trim();
    return this.providerStore.find(request.agentId, selected || undefined);
  }
}
