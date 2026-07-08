import { detectSecret, findSecretLiteral } from '../../../utils/detectSecret';

// The extraction behind detectSecret — "Move to keychain" (#27b) stores this
// exact literal and replaces it with a ${secret:NAME} reference in the command.
describe('findSecretLiteral', () => {
  it('extracts the value of an attached password flag, without the -p', () => {
    expect(findSecretLiteral('mysql -u root -psupersecret123 mydb')).toBe('supersecret123');
  });

  it('extracts the value of a --password= assignment', () => {
    expect(findSecretLiteral('deploy --password=hunter2longvalue')).toBe('hunter2longvalue');
  });

  it('extracts a bearer token', () => {
    expect(findSecretLiteral('curl -H "Authorization: Bearer ghp_abc123XYZdef456" https://api'))
      .toBe('ghp_abc123XYZdef456');
  });

  it('extracts a token= assignment value', () => {
    expect(findSecretLiteral('deploy --token=ghp_abcd1234EFGHijkl')).toBe('ghp_abcd1234EFGHijkl');
  });

  it('extracts an AWS access key id', () => {
    expect(findSecretLiteral('aws configure set key AKIAIOSFODNN7EXAMPLE')).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('extracts a high-entropy blob without its surrounding quotes', () => {
    expect(findSecretLiteral('./deploy.sh "AbCd1234EfGh5678IjKl9012MnOpQrSt"'))
      .toBe('AbCd1234EfGh5678IjKl9012MnOpQrSt');
  });

  it('returns null for benign commands', () => {
    expect(findSecretLiteral('npm run build')).toBeNull();
  });

  it('returns null for variable references (the safe path)', () => {
    expect(findSecretLiteral('mysql -u root -p$DB_PASS mydb')).toBeNull();
    expect(findSecretLiteral('deploy --token=${secret:API_TOKEN}')).toBeNull();
  });

  it('returns null for an empty command', () => {
    expect(findSecretLiteral('')).toBeNull();
  });
});

describe('detectSecret', () => {
  describe('flags likely inline secrets', () => {
    it('mysql-style attached password flag (-psecret)', () => {
      expect(detectSecret('mysql -u root -psupersecret123 mydb')).toBe(true);
    });

    it('--password= assignment', () => {
      expect(detectSecret('deploy --password=hunter2longvalue')).toBe(true);
    });

    it('Authorization: Bearer token', () => {
      expect(detectSecret('curl -H "Authorization: Bearer ghp_abc123XYZdef456" https://api')).toBe(true);
    });

    it('token= query/env assignment', () => {
      expect(detectSecret('deploy --token=ghp_abcd1234EFGHijkl')).toBe(true);
    });

    it('AWS access key id (AKIA…)', () => {
      expect(detectSecret('aws configure set key AKIAIOSFODNN7EXAMPLE')).toBe(true);
    });

    it('a standalone high-entropy blob', () => {
      expect(detectSecret('./deploy.sh AbCd1234EfGh5678IjKl9012MnOpQrSt')).toBe(true);
    });
  });

  describe('does not flag the safe path (variable references)', () => {
    it('env-var password reference', () => {
      expect(detectSecret('mysql -p"$DB_PASS" < dump.sql')).toBe(false);
    });

    it('env-var bearer token reference', () => {
      expect(detectSecret('curl -H "Authorization: Bearer $TOKEN" https://api')).toBe(false);
    });

    it('${secret:NAME} keychain reference in a token assignment', () => {
      expect(detectSecret('deploy --token=${secret:DEPLOY_TOKEN}')).toBe(false);
    });

    it('braced env-var reference', () => {
      expect(detectSecret('deploy --password=${DB_PASS}')).toBe(false);
    });
  });

  describe('does not flag benign commands', () => {
    it('npm build', () => {
      expect(detectSecret('npm run build')).toBe(false);
    });

    it('systemctl reload', () => {
      expect(detectSecret('sudo systemctl reload nginx')).toBe(false);
    });

    it('artisan migrate', () => {
      expect(detectSecret('php artisan migrate --force')).toBe(false);
    });

    it('chmod on a path', () => {
      expect(detectSecret('chmod 644 /var/www/html/index.php')).toBe(false);
    });

    it('a lowercase git SHA is not treated as a secret', () => {
      expect(detectSecret('git checkout a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(false);
    });

    it('does not flag combined short flags that happen to start with p (cp -pr)', () => {
      expect(detectSecret('cp -pr dist/ /var/www/html')).toBe(false);
    });

    it('does not flag tar-style combined flags (tar -pcf)', () => {
      expect(detectSecret('tar -pcf backup.tar /var/www')).toBe(false);
    });

    it('does not flag rsync archive flags (-prtv)', () => {
      expect(detectSecret('rsync -prtv ./build/ server:/var/www')).toBe(false);
    });

    it('empty / whitespace command', () => {
      expect(detectSecret('')).toBe(false);
      expect(detectSecret('   ')).toBe(false);
    });
  });
});
