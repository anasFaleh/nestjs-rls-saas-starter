import { validateName } from './tenant-admin.js';

describe('validateName', () => {
  it('trims and collapses whitespace', () => {
    expect(validateName('  Acme   Inc ', 'name')).toBe('Acme Inc');
  });

  it.each([undefined, '', '   ', 'x'.repeat(101), 'bad\u0000name'])('rejects %j', (v) => {
    expect(() => validateName(v, 'name')).toThrow(/name: 1-100 characters/);
  });
});
