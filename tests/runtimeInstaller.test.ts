import { buildRuntimeInstallPlan } from '../src/runtime/installer';

describe('RuntimeInstaller', () => {
  test('builds npm install command for managed runtimes', () => {
    const plan = buildRuntimeInstallPlan('codex', { WESIGHT_HOME: '/tmp/wesight' } as NodeJS.ProcessEnv);
    expect(plan.packageName).toBe('@openai/codex');
    expect(plan.managedDir).toBe('/tmp/wesight/runtimes/codex');
    expect(plan.args).toEqual(['install', '--prefix', '/tmp/wesight/runtimes/codex', '@openai/codex']);
  });
});
