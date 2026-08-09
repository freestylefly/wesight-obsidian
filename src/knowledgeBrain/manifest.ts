/**
 * Built-in manifest for the Knowledge Runtime package.
 * WeSight pins an exact upstream revision, verifies SHA-256 after download,
 * and never auto-updates in the background.
 */
export interface KnowledgeRuntimeManifest {
  id: string;
  version: string;
  commit: string;
  downloadUrl: string;
  sha256: string;
  minPythonVersion: string;
  license: string;
  homepage: string;
}

export const CLAUDE_OBSIDIAN_MANIFEST: KnowledgeRuntimeManifest = {
  id: 'claude-obsidian',
  version: '2.1.0',
  commit: 'a3b3df4539802e150e942266fd310c1b5978a3c0',
  downloadUrl:
    'https://github.com/AgriciDaniel/claude-obsidian/archive/a3b3df4539802e150e942266fd310c1b5978a3c0.tar.gz',
  sha256: '7c52eab5655da9735ef29903de3b1294e9d69c7b9fdb70b28aa7676dc3156870',
  minPythonVersion: '3.11.0',
  license: 'MIT',
  homepage: 'https://github.com/AgriciDaniel/claude-obsidian',
};

export const KNOWLEDGE_BRAIN_MIN_PYTHON_VERSION = '3.11.0';
export const KNOWLEDGE_BRAIN_RUNTIME_DIR = 'knowledge-brain/runtimes';
export const KNOWLEDGE_BRAIN_TMP_DIR = 'knowledge-brain';
export const KNOWLEDGE_BRAIN_INSTALL_RECORD = 'knowledge-brain/install.json';
