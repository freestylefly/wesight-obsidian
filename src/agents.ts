import type { AgentDescriptor, AgentId } from './types';

export const AGENT_DESCRIPTORS: Record<AgentId, AgentDescriptor> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    shortName: 'Claude',
    packageName: '@anthropic-ai/claude-code',
    binaryName: 'claude',
    bestFor: 'Long-form vault work, edits, and agentic note workflows.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: true,
    docsUrl: 'https://code.claude.com/',
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    shortName: 'Codex',
    packageName: '@openai/codex',
    binaryName: 'codex',
    bestFor: 'Structured coding-agent turns with JSON event streaming.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: true,
    docsUrl: 'https://github.com/openai/codex',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    shortName: 'OpenCode',
    packageName: 'opencode-ai',
    binaryName: 'opencode',
    bestFor: 'Fast local agent execution with OpenCode project state.',
    supportsImages: true,
    supportsInlineEdit: true,
    supportsProviderProfiles: true,
    docsUrl: 'https://opencode.ai/',
  },
};

export const AGENT_IDS: AgentId[] = ['claude', 'codex', 'opencode'];

export function getAgentDescriptor(agentId: AgentId): AgentDescriptor {
  return AGENT_DESCRIPTORS[agentId];
}

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === 'string' && AGENT_IDS.includes(value as AgentId);
}
