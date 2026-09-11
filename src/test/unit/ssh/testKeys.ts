import { utils as ssh2Utils } from 'ssh2';

/**
 * ssh2 1.17's `generateKeyPairSync('ed25519')` occasionally (about 0.45% of
 * keys, measured over 20,000) produces a private key that ssh2's own
 * `parseKey` rejects as "Malformed OpenSSH private key". A wire test that
 * rolls such a key fails every attempt in that run (CI run #80 on main).
 * This helper keeps generating until the key parses, so tests never depend
 * on that dice roll.
 */
export interface GeneratedKeyPair {
  private: string;
  public: string;
}

export interface KeyGeneration {
  generate: () => GeneratedKeyPair;
  parses: (privateKey: string) => boolean;
  maxAttempts?: number;
}

const defaultGeneration: KeyGeneration = {
  generate: () => ssh2Utils.generateKeyPairSync('ed25519'),
  parses: (privateKey) => !(ssh2Utils.parseKey(privateKey) instanceof Error),
};

export function generateParsableKeyPair(generation: Partial<KeyGeneration> = {}): GeneratedKeyPair {
  const { generate, parses, maxAttempts = 20 } = { ...defaultGeneration, ...generation };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pair = generate();
    if (parses(pair.private)) { return pair; }
  }
  throw new Error(`generateParsableKeyPair: no parsable key in ${maxAttempts} attempts`);
}
