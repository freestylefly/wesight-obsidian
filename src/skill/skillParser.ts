export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
}

export function parseSkillFrontmatter(text: string, fallbackName: string): ParsedSkillFrontmatter | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;
  const frontmatter = match[1];
  const name = extractField(frontmatter, 'name')?.trim() || fallbackName;
  const description = extractField(frontmatter, 'description') || '';
  if (!name) return null;
  return { name, description };
}

function extractField(frontmatter: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match quoted multi-line value first so actual newlines are not truncated by single-line regex
  const quotedStart = new RegExp(`^${escapedKey}:\\s*"`, 'm').exec(frontmatter);
  if (quotedStart) {
    const startIndex = quotedStart.index + quotedStart[0].length;
    const rest = frontmatter.slice(startIndex);
    let value = '';
    let escaped = false;
    for (let i = 0; i < rest.length; i += 1) {
      const char = rest[i];
      if (escaped) {
        value += char === 'n' ? '\n' : char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return value;
      }
      value += char;
    }
  }
  // Match single-line value: key: value
  const singleLine = new RegExp(`^${escapedKey}:\\s*(.*)$`, 'm').exec(frontmatter);
  if (singleLine) {
    const value = singleLine[1].trim();
    return unquote(value);
  }
  return null;
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
