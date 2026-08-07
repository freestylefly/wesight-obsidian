import fs from 'fs';
import path from 'path';

import { wesightHome } from '../paths';
import { ensureDir, fileExists } from '../utils/fs';

const materializedRootCache = new Map<string, string>();

import skillRules from '../../vendor/gzh-design-skill/SKILL.md?raw';
import license from '../../vendor/gzh-design-skill/LICENSE.txt?raw';
import upstream from '../../vendor/gzh-design-skill/UPSTREAM.md?raw';
import commonComponents from '../../vendor/gzh-design-skill/references/common-components.md?raw';
import themeGenerator from '../../vendor/gzh-design-skill/references/theme-generator.md?raw';
import themeGraphiteMinimal from '../../vendor/gzh-design-skill/references/theme-graphite-minimal.md?raw';
import themeIndex from '../../vendor/gzh-design-skill/references/theme-index.md?raw';
import themeMoyuGreen from '../../vendor/gzh-design-skill/references/theme-moyu-green.md?raw';
import themeMoyuTicket from '../../vendor/gzh-design-skill/references/theme-moyu-ticket.md?raw';
import themeOliveJournal from '../../vendor/gzh-design-skill/references/theme-olive-journal.md?raw';
import themeRedWhite from '../../vendor/gzh-design-skill/references/theme-red-white.md?raw';
import themeZenWhitespace from '../../vendor/gzh-design-skill/references/theme-zen-whitespace.md?raw';
import validateGzhHtml from '../../vendor/gzh-design-skill/scripts/validate_gzh_html.py?raw';

export const BUNDLED_GZH_DESIGN_COMMIT = 'ba1f4175519b481cb3566616c9e5178705067904';
export const BUNDLED_GZH_DESIGN_SOURCE = 'https://github.com/isjiamu/gzh-design-skill';

const BUNDLED_FILES: Readonly<Record<string, string>> = Object.freeze({
  'SKILL.md': skillRules,
  'LICENSE.txt': license,
  'UPSTREAM.md': upstream,
  'references/common-components.md': commonComponents,
  'references/theme-generator.md': themeGenerator,
  'references/theme-graphite-minimal.md': themeGraphiteMinimal,
  'references/theme-index.md': themeIndex,
  'references/theme-moyu-green.md': themeMoyuGreen,
  'references/theme-moyu-ticket.md': themeMoyuTicket,
  'references/theme-olive-journal.md': themeOliveJournal,
  'references/theme-red-white.md': themeRedWhite,
  'references/theme-zen-whitespace.md': themeZenWhitespace,
  'scripts/validate_gzh_html.py': validateGzhHtml,
});

function writeBundledFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  ensureDir(path.dirname(target));
  if (fileExists(target) && fs.readFileSync(target, 'utf8') === content) return;
  fs.writeFileSync(target, content, 'utf8');
}

export function materializeBundledGzhDesign(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = path.join(
    wesightHome(env),
    'bundled-skills',
    'gzh-design',
    BUNDLED_GZH_DESIGN_COMMIT,
  );
  const cached = materializedRootCache.get(root);
  if (cached && fileExists(path.join(cached, 'SKILL.md'))) {
    return cached;
  }
  for (const [relativePath, content] of Object.entries(BUNDLED_FILES)) {
    writeBundledFile(root, relativePath, content);
  }
  materializedRootCache.set(root, root);
  return root;
}

export function bundledGzhDesignFiles(): Readonly<Record<string, string>> {
  return BUNDLED_FILES;
}
