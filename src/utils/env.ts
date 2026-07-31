export function parseEnvironmentText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key) continue;
    result[key] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

export function mergeEnvironment(base: NodeJS.ProcessEnv, text: string): NodeJS.ProcessEnv {
  return {
    ...base,
    ...parseEnvironmentText(text),
  };
}

export function redactSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '********';
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
