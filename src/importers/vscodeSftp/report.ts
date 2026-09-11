import { ImportReport } from './mapper';

/**
 * Import report rendering (feature 35b, Q6): the full report goes to the
 * FileFerry output channel (DryRunReporter house pattern), one summary line
 * goes to a notification. No webview.
 */

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function section(lines: string[], title: string, items: string[]): void {
  if (items.length === 0) { return; }
  lines.push('', `${title} (${items.length})`);
  for (const item of items) { lines.push(`  ${item}`); }
}

export function formatImportReport(report: ImportReport, sftpJsonPath: string): string[] {
  const lines: string[] = ['──── IMPORT FROM VSCODE-SFTP ────────────', `Source: ${sftpJsonPath}`];

  if (report.imported.length === 0) {
    lines.push('', 'No servers were imported.');
  } else {
    section(lines, 'Imported servers', report.imported.map((server) => {
      const via = server.hopCredentialNames.length > 0 ? ` via ${server.hopCredentialNames.map((name) => `"${name}"`).join(' → ')}` : '';
      const marker = server.isDefault ? ' [default server]' : '';
      return `${server.serverName} (${server.type}, ${server.host}) — credential "${server.credentialName}"${via}${marker}`;
    }));
  }

  section(lines, 'Skipped duplicates', report.skippedDuplicates.map((item) => `${item.entry}: ${item.reason}`));
  section(lines, 'Skipped entries', report.skippedEntries.map((item) => `${item.entry}: ${item.reason}`));
  section(lines, 'Prompts skipped', report.promptsSkipped.map((item) => `${item.entry}: ${item.message}`));
  section(lines, 'Ignore patterns not translated', report.untranslatableIgnore.map((item) => `${item.entry}: ${item.pattern} — ${item.reason}`));
  section(lines, 'Notes', report.notes.map((item) => item.entry ? `${item.entry}: ${item.message}` : item.message));
  section(lines, 'Options not supported by FileFerry, skipped', report.unsupportedOptions.map((item) => `${item.entry}: ${item.options.join(', ')}`));

  if (report.plaintextPasswordsInSftpJson) {
    lines.push(
      '',
      `WARNING: imported passwords are now in your OS keychain, but they are still stored in plain text in ${sftpJsonPath}.`,
      '  sftp.json was left untouched so the vscode-sftp extension keeps working while you switch. Once you are settled,',
      '  remove the "password" fields from it (or delete the file) so the plaintext copy is gone.'
    );
  }

  lines.push(
    '',
    'Next steps',
    '  1. Servers panel → right-click each imported server → Test Connection (first connects show the host key prompt).',
    '  2. Review mappings and excluded paths in Deployment Settings, especially the ignore patterns listed above.',
    '  3. Disable or uninstall the vscode-sftp extension so both do not react to the same saves.',
    '──────────────────────────────────────────'
  );
  return lines;
}

export function summariseImportReport(report: ImportReport): string {
  const head = report.imported.length === 0
    ? 'no servers imported from sftp.json'
    : `imported ${plural(report.imported.length, 'server')} from sftp.json`;
  const attention: string[] = [];
  if (report.skippedDuplicates.length > 0) { attention.push(`${plural(report.skippedDuplicates.length, 'duplicate')} skipped`); }
  if (report.skippedEntries.length > 0) { attention.push(`${plural(report.skippedEntries.length, 'entry', 'entries')} skipped`); }
  if (report.promptsSkipped.length > 0) { attention.push(`${plural(report.promptsSkipped.length, 'prompt')} skipped`); }
  if (report.untranslatableIgnore.length > 0) { attention.push(`${plural(report.untranslatableIgnore.length, 'ignore pattern')} not translated`); }
  const detail = attention.length > 0 ? ` (${attention.join(', ')})` : '';
  return `FileFerry: ${head}${detail}. See the FileFerry output channel for the full report.`;
}
