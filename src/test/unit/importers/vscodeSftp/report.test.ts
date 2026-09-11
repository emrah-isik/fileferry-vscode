import { formatImportReport, summariseImportReport } from '../../../../importers/vscodeSftp/report';
import { ImportReport } from '../../../../importers/vscodeSftp/mapper';

// Feature 35b, Q6: output channel + one summary notification (DryRunReporter
// house pattern). Sections: imported servers (+credentials), skipped
// duplicates, prompts skipped, untranslatable ignore patterns, notes,
// skipped options, the plaintext-password warning, next steps.

function report(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    imported: [],
    skippedDuplicates: [],
    skippedEntries: [],
    promptsSkipped: [],
    untranslatableIgnore: [],
    notes: [],
    unsupportedOptions: [],
    plaintextPasswordsInSftpJson: false,
    ...overrides,
  };
}

const full = report({
  imported: [
    { serverName: 'prod', type: 'sftp', host: 'prod.example.com', credentialName: 'prod', hopCredentialNames: ['prod hop 1'], isDefault: true },
    { serverName: 'legacy', type: 'ftps', host: 'ftp.example.com', credentialName: 'legacy', hopCredentialNames: [], isDefault: false },
  ],
  skippedDuplicates: [{ entry: 'dev', reason: 'already configured as "dev"' }],
  skippedEntries: [{ entry: 'broken', reason: 'no "host" and was skipped' }],
  promptsSkipped: [{ entry: 'legacy', message: 'no password stored for credential "legacy"' }],
  untranslatableIgnore: [{ entry: 'prod', pattern: '!keep', reason: 'negations are not supported' }],
  notes: [{ entry: 'prod', message: 'ignoreFile ".sftpignore" was inlined' }, { message: 'a global note' }],
  unsupportedOptions: [{ entry: 'prod', options: ['concurrency', 'syncOption'] }],
  plaintextPasswordsInSftpJson: true,
});

describe('formatImportReport', () => {
  const lines = formatImportReport(full, '/work/.vscode/sftp.json');
  const text = lines.join('\n');

  it('lists imported servers with type, host, credential, hops, and the default marker', () => {
    expect(text).toMatch(/Imported servers \(2\)/);
    expect(text).toMatch(/prod \(sftp, prod\.example\.com\) .*credential "prod".*via "prod hop 1".*default/);
    expect(text).toMatch(/legacy \(ftps, ftp\.example\.com\) .*credential "legacy"/);
  });

  it('has one section per report bucket, each naming the entry', () => {
    expect(text).toMatch(/Skipped duplicates \(1\)\n\s+dev: already configured as "dev"/);
    expect(text).toMatch(/Skipped entries \(1\)\n\s+broken: no "host"/);
    expect(text).toMatch(/Prompts skipped \(1\)\n\s+legacy: no password stored/);
    expect(text).toMatch(/Ignore patterns not translated \(1\)\n\s+prod: !keep .*negations/);
    expect(text).toMatch(/Notes \(2\)\n\s+prod: ignoreFile.*\n\s+a global note/);
    expect(text).toMatch(/Options not supported by FileFerry, skipped \(1\)\n\s+prod: concurrency, syncOption/);
  });

  it('warns about the plaintext password left in sftp.json and names the file', () => {
    expect(text).toMatch(/WARNING: .*password.*still stored in plain text in \/work\/\.vscode\/sftp\.json/i);
    expect(text).toMatch(/keychain/);
  });

  it('ends with next steps: Test Connection, disable the old extension', () => {
    expect(text).toMatch(/\nNext steps\n/);
    expect(text).toMatch(/Test Connection/);
    expect(text).toMatch(/disable.*vscode-sftp/i);
  });

  it('omits empty sections and the password warning when nothing applies', () => {
    const minimal = formatImportReport(report({ imported: [full.imported[1]] }), '/w/.vscode/sftp.json').join('\n');
    expect(minimal).not.toMatch(/Skipped duplicates|Skipped entries|Prompts skipped|not translated|Notes|not supported|WARNING/);
    expect(minimal).toMatch(/Imported servers \(1\)/);
  });

  it('says so when nothing was imported', () => {
    const empty = formatImportReport(report(), '/w/.vscode/sftp.json').join('\n');
    expect(empty).toMatch(/No servers were imported/);
  });
});

describe('summariseImportReport', () => {
  it('counts servers, then the buckets that need attention', () => {
    expect(summariseImportReport(full)).toBe(
      'FileFerry: imported 2 servers from sftp.json (1 duplicate skipped, 1 entry skipped, 1 prompt skipped, 1 ignore pattern not translated). See the FileFerry output channel for the full report.'
    );
  });

  it('uses singular forms and drops empty buckets', () => {
    expect(summariseImportReport(report({ imported: [full.imported[0]] }))).toBe(
      'FileFerry: imported 1 server from sftp.json. See the FileFerry output channel for the full report.'
    );
  });

  it('reports zero imports honestly', () => {
    expect(summariseImportReport(report({ skippedDuplicates: full.skippedDuplicates }))).toBe(
      'FileFerry: no servers imported from sftp.json (1 duplicate skipped). See the FileFerry output channel for the full report.'
    );
  });
});
