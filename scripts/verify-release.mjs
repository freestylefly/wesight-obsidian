import fs from 'node:fs';
import crypto from 'node:crypto';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Manifest version must use x.y.z SemVer.');
requireCondition(packageJson.version === manifest.version, 'Package and manifest versions must match.');
requireCondition(packageJson.license === 'AGPL-3.0-or-later', 'Package license must be AGPL-3.0-or-later.');
requireCondition(versions[manifest.version] === manifest.minAppVersion, 'versions.json must map the current version to minAppVersion.');
requireCondition(typeof manifest.description === 'string' && manifest.description.length <= 250, 'Manifest description must be at most 250 characters.');
requireCondition(manifest.description.endsWith('.'), 'Manifest description must end with a period.');
requireCondition(manifest.isDesktopOnly === true, 'The plugin uses Node.js APIs and must be desktop-only.');

for (const file of [
  'README.md',
  'LICENSE',
  'LICENSES/MIT.txt',
  'THIRD_PARTY_NOTICES.md',
  'main.js',
  'manifest.json',
  'styles.css',
  'vendor/gzh-design-skill/LICENSE.txt',
  'vendor/gzh-design-skill/UPSTREAM.md',
]) {
  requireCondition(fs.statSync(file).size > 0, `${file} must exist and contain data.`);
}

const upstreamFiles = {
  'vendor/gzh-design-skill/SKILL.md': 'c6f77f9ee5d351ef519b4e4c5238614a77427ff7bb442d251bbff29347af3580',
  'vendor/gzh-design-skill/LICENSE.txt': '50a026dd82963794599f540477cd913345a42eb1028c53c1b53f772abec4c191',
  'vendor/gzh-design-skill/references/theme-index.md': 'b865d0abd50c346d11b643f749ef2b4292d907913a6c7ad899b74c59e2e2c0e8',
  'vendor/gzh-design-skill/references/common-components.md': '6daf8125af6d11ad955df4090f58f6f0c2518b8d745c28093429ab1b8d5b322c',
  'vendor/gzh-design-skill/references/theme-generator.md': 'a42f0d9e5aab15346ce7c12d160c6fd903d8ac1ff2f501a01b86b10b5befb39a',
  'vendor/gzh-design-skill/references/theme-moyu-green.md': '88c3661d8b42d83126793ee693b20e1946d38a23da568accedd8a4aea83186f8',
  'vendor/gzh-design-skill/references/theme-red-white.md': '109107819c450de517d6ddc91bb00335fd249f0b8befddb54fded1cdf9c19837',
  'vendor/gzh-design-skill/references/theme-graphite-minimal.md': '8c0a7a99961d9a9cba62d5fe9da29309c515540b1eeed88584da2e3dbf15de96',
  'vendor/gzh-design-skill/references/theme-zen-whitespace.md': 'e186e9ba6843871d7ff9921a8d3d03531cf6284eb16bdc86fbf06d777de98929',
  'vendor/gzh-design-skill/references/theme-moyu-ticket.md': '1272ca6739d26110d56e6909eed46f498b0132daa3b35354f908986776866da4',
  'vendor/gzh-design-skill/references/theme-olive-journal.md': 'aa7effb32d595b0768a05734c541f1059703860cec00ac699fa4d2bde43b0ee3',
  'vendor/gzh-design-skill/scripts/validate_gzh_html.py': 'de21aa3decac10c6ef89040bdc4e19930dbed33d6ccf7bc963b744c53da01185',
};
for (const [file, expectedHash] of Object.entries(upstreamFiles)) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  requireCondition(hash === expectedHash, `${file} must match the pinned upstream source.`);
}

const license = fs.readFileSync('LICENSE', 'utf8');
requireCondition(license.includes('GNU AFFERO GENERAL PUBLIC LICENSE'), 'Root license must contain AGPL-3.0.');

const bundle = fs.readFileSync('main.js', 'utf8');
requireCondition(!/sourceMappingURL=/.test(bundle), 'Production main.js must not include a source map.');
for (const relativePath of fs.readdirSync('src', { recursive: true })) {
  if (!relativePath.endsWith('.ts')) continue;
  const source = fs.readFileSync(`src/${relativePath}`, 'utf8');
  requireCondition(
    !/npm\s+install|npx\s+skills\s+add/.test(source),
    `Plugin source ${relativePath} contains a dependency installation command.`,
  );
}
requireCondition(bundle.includes('ba1f4175519b481cb3566616c9e5178705067904'), 'Production main.js must include the pinned gzh-design bundle.');
requireCondition(
  bundle.includes('Copyright (C) 2026')
    && bundle.includes('(Jiamu)')
    && bundle.includes('(Moyu Xiaoli)'),
  'Production main.js must retain the upstream copyright notice.',
);

process.stdout.write(`Verified WeSight ${manifest.version} release assets.\n`);
