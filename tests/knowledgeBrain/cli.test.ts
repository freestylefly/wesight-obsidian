import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  commandAdoptApply,
  commandContracts,
  loadRuntimeSkill,
} from '../../src/knowledgeBrain/cli';

describe('knowledge core CLI arguments', () => {
  test('pins adopt apply to the reviewed timestamp, operation ID, and plan hash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-cli-'));
    const executable = path.join(root, 'fake-python');
    const argsPath = path.join(root, 'args.txt');
    fs.writeFileSync(executable, [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
      "printf '{}'",
    ].join('\n'));
    fs.chmodSync(executable, 0o755);
    const options = { pythonPath: executable, runtimePath: '/runtime', vaultPath: root };
    try {
      await commandAdoptApply(options, 'plan-sha', '2026-08-09T01:02:03Z', 'adopt-fixed');
      expect(fs.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
        '-m', 'claude_obsidian', 'adopt', root, '--apply',
        '--generated-at', '2026-08-09T01:02:03Z',
        '--operation-id', 'adopt-fixed',
        '--approved-plan-sha256', 'plan-sha',
      ]);

      await commandContracts(options, 'wiki-retrieve', true);
      expect(fs.readFileSync(argsPath, 'utf8').trim().split('\n')).toEqual([
        '-m', 'claude_obsidian', 'contracts', '--vault', root,
        '--verify', '--capability', 'wiki-retrieve',
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads a runtime skill through the bundled Node filesystem API', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-kb-skill-'));
    const skillDir = path.join(root, 'skills', 'wiki-ingest');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Wiki ingest\n');
    try {
      await expect(loadRuntimeSkill(root, 'wiki-ingest')).resolves.toBe('# Wiki ingest\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
