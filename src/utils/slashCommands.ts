export interface SlashCommand {
  id: string;
  label: string;
  insertText: string;
  description: string;
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'summarize',
    label: '/summarize',
    insertText: 'Summarize the current note and suggest follow-up links.',
    description: 'Summarize a note',
  },
  {
    id: 'rewrite',
    label: '/rewrite',
    insertText: 'Rewrite the selected or referenced text with clearer structure.',
    description: 'Improve writing',
  },
  {
    id: 'plan',
    label: '/plan',
    insertText: 'Create a concise implementation plan for this vault task.',
    description: 'Plan first',
  },
  {
    id: 'extract',
    label: '/extract',
    insertText: 'Extract action items, decisions, and open questions.',
    description: 'Extract structured notes',
  },
];

export function filterSlashCommands(query: string): SlashCommand[] {
  const normalized = query.toLowerCase();
  return BUILTIN_SLASH_COMMANDS.filter(command => (
    command.label.toLowerCase().includes(normalized)
    || command.description.toLowerCase().includes(normalized)
  ));
}
