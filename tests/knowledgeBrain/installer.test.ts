import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  installKnowledgeRuntime,
  readInstallRecord,
  runtimeInstallDir,
  writeInstallRecord,
  type InstallRecord,
} from '../../src/knowledgeBrain/installer';
import { CLAUDE_OBSIDIAN_MANIFEST } from '../../src/knowledgeBrain/manifest';

describe('knowledge runtime installer records', () => {
  let root: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-installer-'));
    priorHome = process.env.WESIGHT_HOME;
    process.env.WESIGHT_HOME = root;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.WESIGHT_HOME;
    else process.env.WESIGHT_HOME = priorHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('revalidates an exact private installation before reusing it', async () => {
    const runtimePath = runtimeInstallDir(CLAUDE_OBSIDIAN_MANIFEST);
    for (const relative of [
      'claude_obsidian/__main__.py',
      'claude_obsidian/__init__.py',
      'scripts/claude-obsidian.py',
      'scripts/retrieve.py',
      'skills/wiki-ingest/SKILL.md',
      'skills/wiki-query/SKILL.md',
      'skills/save/SKILL.md',
      'LICENSE',
    ]) {
      const target = path.join(runtimePath, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fixture\n');
    }
    const fakePython = path.join(root, 'python3');
    fs.writeFileSync(fakePython, [
      '#!/bin/sh',
      'case "$*" in',
      "  *'--version'*) printf '2.1.0\\n' ;;",
      "  *'package validate'*) printf '{\"ok\":true}' ;;",
      "  *'contracts --check-only'*) printf '{\"valid\":true}' ;;",
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));
    fs.chmodSync(fakePython, 0o755);
    const record: InstallRecord = {
      schema: 'wesight.knowledge-runtime-install.v1',
      id: CLAUDE_OBSIDIAN_MANIFEST.id,
      version: CLAUDE_OBSIDIAN_MANIFEST.version,
      commit: CLAUDE_OBSIDIAN_MANIFEST.commit,
      installedAt: 1,
      pythonPath: '/old/python',
      pythonVersion: '3.11.0',
      runtimePath,
      sha256: CLAUDE_OBSIDIAN_MANIFEST.sha256,
    };
    await writeInstallRecord(record);

    const result = await installKnowledgeRuntime(fakePython, '3.13.0', CLAUDE_OBSIDIAN_MANIFEST);

    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({ pythonPath: fakePython, pythonVersion: '3.13.0', runtimePath });
    expect(await readInstallRecord()).toMatchObject({ pythonPath: fakePython, pythonVersion: '3.13.0' });
    const installFile = path.join(root, 'knowledge-brain', 'install.json');
    expect(fs.statSync(installFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(installFile, 'utf8')).not.toContain('fixture');
  });

  test('ignores records with an unknown schema or missing contract fields', async () => {
    const installFile = path.join(root, 'knowledge-brain', 'install.json');
    fs.mkdirSync(path.dirname(installFile), { recursive: true });
    fs.writeFileSync(installFile, JSON.stringify({ schema: 'legacy', runtimePath: '/tmp/runtime' }));
    expect(await readInstallRecord()).toBeNull();
  });
});
