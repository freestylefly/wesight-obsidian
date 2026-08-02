export const STORED_SECRET_MASK = '••••••••••••••••';

export function resolveSecretInput(value: string, existingSecret: string): string {
  return value && value !== STORED_SECRET_MASK ? value : existingSecret;
}

export function initializeStoredSecretInput(input: HTMLInputElement, hasStoredSecret: boolean): void {
  if (!hasStoredSecret) return;

  input.value = STORED_SECRET_MASK;
  input.addEventListener('focus', () => {
    if (input.value === STORED_SECRET_MASK) input.value = '';
  });
  input.addEventListener('blur', () => {
    if (!input.value) input.value = STORED_SECRET_MASK;
  });
}
