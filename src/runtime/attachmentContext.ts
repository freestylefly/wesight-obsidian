import type { FileAttachment } from '../types';

const ATTACHMENT_CONTEXT_HEADING = 'Attached local paths:';

export function appendAttachmentContext(prompt: string, attachments: FileAttachment[] = []): string {
  if (attachments.length === 0) return prompt;
  const lines = [ATTACHMENT_CONTEXT_HEADING];
  let hasExternal = false;
  for (const attachment of attachments) {
    const kind = attachment.kind === 'directory' ? 'Directory' : 'File';
    const name = attachment.displayName?.trim();
    lines.push(`- ${kind}${name ? ` "${name}"` : ''}: ${attachment.absolutePath}`);
    if (attachment.source === 'external') hasExternal = true;
    if (attachment.kind === 'directory' && attachment.ignoredPatterns?.length) {
      lines.push(`  Ignore while reading this directory: ${attachment.ignoredPatterns.join(', ')}`);
      if (attachment.ignoredPatterns.includes('.env.*')) {
        lines.push('  Keep .env.example files available as non-secret examples.');
      }
    }
  }
  if (hasExternal) {
    lines.push('Treat external attachment paths as read-only context. Do not modify, rename, or delete them.');
  }
  return [prompt.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}
