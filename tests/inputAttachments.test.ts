import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  DEFAULT_DIRECTORY_IGNORE_PATTERNS,
  createExternalInputAttachment,
  deriveSelectedDirectoryPath,
  getDomFileAbsolutePath,
  inputAttachmentPathKey,
  validateInputAttachment,
} from '../src/attachments/inputAttachments';
import { appendAttachmentContext } from '../src/runtime/attachmentContext';

describe('input attachments', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-input-attachment-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('resolves Electron File.path and derives macOS and Windows directory roots', () => {
    const fakeFile = { path: path.join(tempDir, '中文 file.txt'), webkitRelativePath: '' } as unknown as File;
    expect(getDomFileAbsolutePath(fakeFile)).toBe(path.join(tempDir, '中文 file.txt'));
    expect(deriveSelectedDirectoryPath('/Users/me/Documents/demo/sub/file.txt', 'demo/sub/file.txt'))
      .toBe('/Users/me/Documents/demo');
    expect(deriveSelectedDirectoryPath('C:\\Users\\me\\demo\\sub\\file.txt', 'demo/sub/file.txt'))
      .toBe('C:\\Users\\me\\demo');
    expect(inputAttachmentPathKey('C:\\Users\\Me\\FILE.txt'))
      .toBe('c:\\users\\me\\file.txt');
    expect(inputAttachmentPathKey(path.join(tempDir, 'nested', '..', '中文 file.txt')))
      .toBe(inputAttachmentPathKey(path.join(tempDir, '中文 file.txt')));
  });

  test('accepts ordinary files and directories while classifying supported images', async () => {
    const textPath = path.join(tempDir, '说明 file.txt');
    const pngPath = path.join(tempDir, 'image.data');
    const folderPath = path.join(tempDir, 'project');
    fs.writeFileSync(textPath, 'hello');
    fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    fs.mkdirSync(folderPath);

    await expect(createExternalInputAttachment(textPath)).resolves.toMatchObject({
      kind: 'file',
      source: 'external',
      displayName: '说明 file.txt',
      mimeType: 'text/plain',
    });
    await expect(createExternalInputAttachment(pngPath)).resolves.toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
    const folder = await createExternalInputAttachment(folderPath);
    expect(folder).toMatchObject({
      kind: 'directory',
      ignoredPatterns: [...DEFAULT_DIRECTORY_IGNORE_PATTERNS],
    });
  });

  test('rejects empty files, symbolic links, and reports missing referenced paths without deleting sources', async () => {
    const emptyPath = path.join(tempDir, 'empty.txt');
    const sourcePath = path.join(tempDir, 'source.txt');
    const linkPath = path.join(tempDir, 'source-link.txt');
    fs.writeFileSync(emptyPath, '');
    fs.writeFileSync(sourcePath, 'keep me');

    await expect(createExternalInputAttachment(emptyPath)).rejects.toThrow('空文件');
    if (process.platform !== 'win32') {
      await expect(createExternalInputAttachment('/dev/null')).rejects.toThrow('仅支持普通文件或文件夹');
    }
    try {
      fs.symlinkSync(sourcePath, linkPath);
      await expect(createExternalInputAttachment(linkPath)).rejects.toThrow('符号链接');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM') throw error;
    }
    const attachment = await createExternalInputAttachment(sourcePath);
    expect(await validateInputAttachment(attachment)).toBeNull();
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('keep me');
    fs.renameSync(sourcePath, `${sourcePath}.moved`);
    expect(await validateInputAttachment(attachment)).toBe('源文件不存在');
  });

  test('builds read-only path context, folder ignores, and the env example exception', () => {
    const prompt = appendAttachmentContext('Inspect these inputs.', [{
      absolutePath: '/outside/report.pdf',
      displayName: 'report.pdf',
      kind: 'file',
      source: 'external',
    }, {
      absolutePath: '/outside/project',
      displayName: 'project',
      kind: 'directory',
      source: 'external',
      ignoredPatterns: [...DEFAULT_DIRECTORY_IGNORE_PATTERNS],
    }]);

    expect(prompt).toContain('File "report.pdf": /outside/report.pdf');
    expect(prompt).toContain('Directory "project": /outside/project');
    expect(prompt).toContain('node_modules');
    expect(prompt).toContain('Keep .env.example');
    expect(prompt).toContain('read-only context');
  });
});
