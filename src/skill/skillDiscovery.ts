import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentId } from '../types';
import { parseSkillFrontmatter } from './skillParser';

export interface LocalSkill {
  name: string;
  description: string;
  directory: string;
  agentId: AgentId;
}

const SKILL_FILE = 'SKILL.md';

const skillCache = new Map<AgentId, { skills: LocalSkill[]; loadedAt: number }>();
const CACHE_TTL_MS = 30_000;

export function getSkillDirectories(agentId: AgentId): string[] {
  const home = homedir();
  if (agentId === 'claude') {
    return [join(home, '.claude', 'skills')];
  }
  if (agentId === 'codex') {
    return [join(home, '.codex', 'skills')];
  }
  return [];
}

export async function loadLocalSkills(agentId: AgentId): Promise<LocalSkill[]> {
  const cached = skillCache.get(agentId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.skills;
  }
  const skills: LocalSkill[] = [];
  const dirs = getSkillDirectories(agentId);
  for (const dir of dirs) {
    const entries = await readDirectoryNames(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      const skillDir = join(dir, entry);
      const skillMdPath = join(skillDir, SKILL_FILE);
      try {
        const text = await readFile(skillMdPath, 'utf-8');
        const parsed = parseSkillFrontmatter(text, entry);
        if (!parsed) continue;
        skills.push({
          name: parsed.name,
          description: parsed.description,
          directory: skillDir,
          agentId,
        });
      } catch {
        // Skip directories without a readable SKILL.md
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  skillCache.set(agentId, { skills, loadedAt: Date.now() });
  return skills;
}

export function invalidateSkillCache(agentId?: AgentId): void {
  if (agentId) {
    skillCache.delete(agentId);
  } else {
    skillCache.clear();
  }
}

async function readDirectoryNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}
