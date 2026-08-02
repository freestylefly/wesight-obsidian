import { describe, expect, test } from 'vitest';

import { resolveSecretInput, STORED_SECRET_MASK } from '../src/ui/secretInput';

describe('secret input', () => {
  test('keeps the stored secret when the visible value is masked or empty', () => {
    expect(resolveSecretInput(STORED_SECRET_MASK, 'sk-saved')).toBe('sk-saved');
    expect(resolveSecretInput('', 'sk-saved')).toBe('sk-saved');
  });

  test('uses a newly entered secret', () => {
    expect(resolveSecretInput('sk-new', 'sk-saved')).toBe('sk-new');
  });
});
