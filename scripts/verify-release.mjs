import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const versions = JSON.parse(fs.readFileSync('versions.json', 'utf8'));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Manifest version must use x.y.z SemVer.');
requireCondition(packageJson.version === manifest.version, 'Package and manifest versions must match.');
requireCondition(versions[manifest.version] === manifest.minAppVersion, 'versions.json must map the current version to minAppVersion.');
requireCondition(typeof manifest.description === 'string' && manifest.description.length <= 250, 'Manifest description must be at most 250 characters.');
requireCondition(manifest.description.endsWith('.'), 'Manifest description must end with a period.');
requireCondition(manifest.isDesktopOnly === true, 'The plugin uses Node.js APIs and must be desktop-only.');

for (const file of ['README.md', 'LICENSE', 'main.js', 'manifest.json', 'styles.css']) {
  requireCondition(fs.statSync(file).size > 0, `${file} must exist and contain data.`);
}

const bundle = fs.readFileSync('main.js', 'utf8');
requireCondition(!/sourceMappingURL=/.test(bundle), 'Production main.js must not include a source map.');
requireCondition(!/npm\s+install|npx\s+skills\s+add/.test(bundle), 'Production main.js contains a dependency installation command.');

process.stdout.write(`Verified WeSight ${manifest.version} release assets.\n`);
