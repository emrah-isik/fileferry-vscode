import { generateParsableKeyPair } from './testKeys';
import { utils as ssh2Utils } from 'ssh2';

describe('generateParsableKeyPair', () => {
  it('returns the first key that parses, retrying past malformed ones', () => {
    const pairs = [{ private: 'bad-1', public: 'p' }, { private: 'bad-2', public: 'p' }, { private: 'good', public: 'p' }];
    let calls = 0;
    const pair = generateParsableKeyPair({ generate: () => pairs[calls++], parses: (key) => key === 'good' });
    expect(pair.private).toBe('good');
    expect(calls).toBe(3);
  });

  it('gives up with a clear error after maxAttempts', () => {
    expect(() => generateParsableKeyPair({ generate: () => ({ private: 'bad', public: 'p' }), parses: () => false, maxAttempts: 3 }))
      .toThrow(/no parsable key in 3 attempts/);
  });

  it('produces a real ed25519 key that ssh2 parses', () => {
    const pair = generateParsableKeyPair();
    expect(ssh2Utils.parseKey(pair.private)).not.toBeInstanceOf(Error);
    expect(pair.public).toMatch(/^ssh-ed25519 /);
  });
});
