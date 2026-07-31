import type { AgentStatus, ChatTurnRequest, ProviderProfile, RuntimeTurnEvent, WeSightObsidianSettings } from '../types';
import { ProviderStore } from '../storage/providerStore';
import { appendLocalLog } from '../storage/localLog';
import { RuntimeDiscovery } from './discovery';
import { AgentAdapter } from './adapter';

export type RuntimeEventListener = (event: RuntimeTurnEvent) => void;

export class RuntimeManager {
  // Multiple turns can be in flight at once (chat + inline edit), so track every
  // live adapter instead of only the most recent one.
  private readonly activeAdapters = new Set<AgentAdapter>();

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
        appendLocalLog('runtime_error', { message: event.message, detail: event.detail });
      }
      onEvent(event);
    };

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
    const adapter = new AgentAdapter({
      agentId: request.agentId,
      binaryPath: status.binaryPath,
      sharedEnvironmentVariables: settings.sharedEnvironmentVariables,
      providerProfile: profile,
    });
    this.activeAdapters.add(adapter);
    appendLocalLog('runtime_turn_start', { agentId: request.agentId, configSource: request.configSource });
    const unsubscribe = adapter.onRuntimeEvent(deliver);
    try {
      await adapter.run(request);
      appendLocalLog('runtime_turn_finish', { agentId: request.agentId });
    } finally {
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
