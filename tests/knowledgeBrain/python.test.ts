import { describe, expect, it } from 'vitest';
import { compareVersions, parsePythonVersion } from '../../src/knowledgeBrain/python';

describe('knowledge brain python version comparison', () => {
  it('rejects 3.10 and accepts Python 3.11 through 3.14', () => {
    expect(compareVersions('3.11.0', '3.11.0')).toBe(0);
    expect(compareVersions('3.12.1', '3.11.0')).toBe(1);
    expect(compareVersions('3.13.0', '3.11.0')).toBe(1);
    expect(compareVersions('3.14.0', '3.11.0')).toBe(1);
    expect(compareVersions('3.10.0', '3.11.0')).toBe(-1);
  });

  it('parses stdout and stderr version formats', () => {
    expect(parsePythonVersion('Python 3.11.9\n')).toBe('3.11.9');
    expect(parsePythonVersion('warning\nPython 3.14.0')).toBe('3.14.0');
    expect(parsePythonVersion('python unknown')).toBeNull();
  });
});
