import type { AgentId } from '../types';
import { loadLocalSkills } from '../skill/skillDiscovery';

export interface SlashCommand {
  id: string;
  label: string;
  insertText: string;
  description: string;
}

export async function loadChatSkills(agentId: AgentId): Promise<SlashCommand[]> {
  const skills = await loadLocalSkills(agentId);
  return skills.map(skill => ({
    id: skill.name,
    label: `/${skill.name}`,
    insertText: skill.description,
    description: truncate(skill.description, 120),
  }));
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.toLowerCase();
  return commands.filter(command => (
    command.label.toLowerCase().includes(normalized)
    || command.description.toLowerCase().includes(normalized)
  ));
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength).trim()}…`;
}
