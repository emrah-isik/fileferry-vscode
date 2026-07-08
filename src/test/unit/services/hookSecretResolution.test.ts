import {
  findSecretReferences,
  shellVariableReference,
  resolveLocalCommand,
  resolveRemoteCommand,
} from '../../../services/hookSecretResolution';

describe('findSecretReferences', () => {
  it('returns no names for a command without tokens', () => {
    expect(findSecretReferences('npm run build')).toEqual({ names: [], invalidNames: [] });
  });

  it('finds a single token', () => {
    expect(findSecretReferences('deploy --token ${secret:API_TOKEN}')).toEqual({
      names: ['API_TOKEN'],
      invalidNames: [],
    });
  });

  it('finds multiple distinct tokens in order of first appearance', () => {
    const scan = findSecretReferences('run ${secret:SECOND_ONE} then ${secret:FIRST_ONE} again');
    expect(scan.names).toEqual(['SECOND_ONE', 'FIRST_ONE']);
  });

  it('reports a repeated token once', () => {
    const scan = findSecretReferences('echo ${secret:API_TOKEN} ${secret:API_TOKEN}');
    expect(scan.names).toEqual(['API_TOKEN']);
  });

  it('flags a token whose name is not a valid environment variable name', () => {
    const scan = findSecretReferences('echo ${secret:BAD-NAME} ${secret:GOOD_NAME} ${secret:}');
    expect(scan.names).toEqual(['GOOD_NAME']);
    expect(scan.invalidNames).toEqual(['BAD-NAME', '']);
  });

  it('does not treat plain shell variables or other ${...} forms as secret tokens', () => {
    const scan = findSecretReferences('echo $HOME ${PATH} ${env:USER}');
    expect(scan).toEqual({ names: [], invalidNames: [] });
  });
});

describe('shellVariableReference', () => {
  it.each([
    ['/bin/bash', '$API_TOKEN'],
    ['/usr/bin/zsh', '$API_TOKEN'],
    ['/bin/sh', '$API_TOKEN'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', '$API_TOKEN'],
  ])('POSIX-style for %s', (shell, expected) => {
    expect(shellVariableReference('API_TOKEN', shell)).toBe(expected);
  });

  it.each([
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
    ['/usr/local/bin/pwsh'],
  ])('PowerShell-style for %s', (shell) => {
    expect(shellVariableReference('API_TOKEN', shell)).toBe('$env:API_TOKEN');
  });

  it('cmd-style for cmd.exe', () => {
    expect(shellVariableReference('API_TOKEN', 'C:\\Windows\\System32\\cmd.exe')).toBe('%API_TOKEN%');
  });

  it('falls back to the platform default when shell is true: cmd on Windows', () => {
    expect(shellVariableReference('API_TOKEN', true, 'win32')).toBe('%API_TOKEN%');
  });

  it('falls back to the platform default when shell is true: POSIX elsewhere', () => {
    expect(shellVariableReference('API_TOKEN', true, 'linux')).toBe('$API_TOKEN');
    expect(shellVariableReference('API_TOKEN', true, 'darwin')).toBe('$API_TOKEN');
  });
});

describe('resolveLocalCommand', () => {
  const values = new Map([['API_TOKEN', 'tok-secret-123']]);

  it('rewrites the token to a shell variable reference — the value never enters the command string', () => {
    const resolved = resolveLocalCommand(
      'curl -H "Authorization: Bearer ${secret:API_TOKEN}" https://api.example.com',
      values,
      '/bin/bash'
    );
    expect(resolved.command).toBe('curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com');
    expect(resolved.command).not.toContain('tok-secret-123');
    expect(resolved.environmentOverlay).toEqual({ API_TOKEN: 'tok-secret-123' });
  });

  it('rewrites every occurrence of a repeated token', () => {
    const resolved = resolveLocalCommand(
      'echo ${secret:API_TOKEN} && echo ${secret:API_TOKEN}',
      values,
      '/bin/bash'
    );
    expect(resolved.command).toBe('echo $API_TOKEN && echo $API_TOKEN');
  });

  it('handles multiple secrets in one command', () => {
    const twoValues = new Map([['DB_USER', 'app'], ['DB_PASS', 'hunter2']]);
    const resolved = resolveLocalCommand(
      'mysql -u ${secret:DB_USER} -p${secret:DB_PASS}',
      twoValues,
      '/usr/bin/zsh'
    );
    expect(resolved.command).toBe('mysql -u $DB_USER -p$DB_PASS');
    expect(resolved.environmentOverlay).toEqual({ DB_USER: 'app', DB_PASS: 'hunter2' });
  });

  it('uses the shell-appropriate reference form (PowerShell)', () => {
    const resolved = resolveLocalCommand('deploy ${secret:API_TOKEN}', values, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(resolved.command).toBe('deploy $env:API_TOKEN');
  });

  it('leaves a command without tokens untouched, with an empty overlay', () => {
    const resolved = resolveLocalCommand('npm run build', new Map(), '/bin/bash');
    expect(resolved.command).toBe('npm run build');
    expect(resolved.environmentOverlay).toEqual({});
  });
});

describe('resolveRemoteCommand', () => {
  it('substitutes the value inline', () => {
    const resolved = resolveRemoteCommand(
      'mysqldump -u root -p${secret:DB_PASS} app',
      new Map([['DB_PASS', 'hunter2']])
    );
    expect(resolved).toBe('mysqldump -u root -phunter2 app');
  });

  it('substitutes every occurrence and multiple names', () => {
    const resolved = resolveRemoteCommand(
      'echo ${secret:FIRST_ONE} ${secret:SECOND_ONE} ${secret:FIRST_ONE}',
      new Map([['FIRST_ONE', 'one'], ['SECOND_ONE', 'two']])
    );
    expect(resolved).toBe('echo one two one');
  });

  it('leaves a command without tokens untouched', () => {
    expect(resolveRemoteCommand('systemctl reload nginx', new Map())).toBe('systemctl reload nginx');
  });
});
