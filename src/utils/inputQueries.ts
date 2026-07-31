export function findMentionQuery(input: string, cursor: number): string | null {
  const before = input.slice(0, cursor);
  const match = before.match(/@([^\s@]*)$/);
  return match ? match[1] : null;
}

export function findSlashQuery(input: string, cursor: number): string | null {
  const before = input.slice(0, cursor);
  const match = before.match(/(?:^|\s)\/([^\s/]*)$/);
  return match ? match[1] : null;
}
