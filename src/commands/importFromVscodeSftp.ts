import * as vscode from 'vscode';
import * as path from 'path';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { parseSftpJson, SftpJsonParseError } from '../importers/vscodeSftp/parser';
import { ImportPrompts, mapEntries } from '../importers/vscodeSftp/mapper';
import { formatImportReport, summariseImportReport } from '../importers/vscodeSftp/report';

/**
 * FileFerry: Import from vscode-sftp (sftp.json) — feature 35b. Thin glue
 * over the pure parser/mapper/report modules: read the file, resolve any
 * `ignoreFile`s, map (prompting per item for Q13/Q14 with Esc-to-skip),
 * write credentials then config, refresh, report. Batch aspects (collisions,
 * duplicates) never prompt. The user's sftp.json is never modified (Q5).
 */

export type ImportOutcome = 'no-workspace' | 'no-sftp-json' | 'invalid' | 'nothing-imported' | 'imported';

export interface ImportFromVscodeSftpDependencies {
  workspaceRoot: string | undefined;
  /** Returns the file's text, or null when it cannot be read. */
  readFile: (absolutePath: string) => Promise<string | null>;
  configManager: Pick<ProjectConfigManager, 'getConfig' | 'saveConfig'>;
  credentialManager: Pick<CredentialManager, 'getAll' | 'save'>;
  output: Pick<vscode.OutputChannel, 'appendLine' | 'show'>;
  /** Defaults to VS Code input boxes; tests inject fakes. */
  prompts?: ImportPrompts;
  /** Runs after a successful write: status bar, servers tree, context keys. */
  afterWrite?: () => void | Promise<void>;
}

const PROMPT_TITLE = 'FileFerry: Import from vscode-sftp';

export const vscodePrompts: ImportPrompts = {
  async askRootPath(target) {
    return vscode.window.showInputBox({
      title: PROMPT_TITLE,
      prompt: `"${target.name}" uses the relative remotePath "${target.relativePath}". FileFerry needs an absolute remote path. Esc skips this server.`,
      value: '/',
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().startsWith('/') ? undefined : 'The remote path must start with /',
    });
  },
  async askPassword(target) {
    return vscode.window.showInputBox({
      title: PROMPT_TITLE,
      prompt: `Password for ${target.username}@${target.host}:${target.port} (credential "${target.credentialName}"). Stored in your OS keychain, never in a file. Esc saves the credential without a password.`,
      password: true,
      ignoreFocusOut: true,
    });
  },
};

export async function importFromVscodeSftp(dependencies: ImportFromVscodeSftpDependencies): Promise<ImportOutcome> {
  const { workspaceRoot, output } = dependencies;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('FileFerry: Open a folder first. sftp.json lives in the workspace\'s .vscode folder.');
    return 'no-workspace';
  }
  const sftpJsonPath = path.join(workspaceRoot, '.vscode', 'sftp.json');
  const text = await dependencies.readFile(sftpJsonPath);
  if (text === null) {
    vscode.window.showErrorMessage('FileFerry: No .vscode/sftp.json found in this workspace. Nothing to import.');
    return 'no-sftp-json';
  }

  let parsed;
  try {
    parsed = parseSftpJson(text);
  } catch (error) {
    const message = error instanceof SftpJsonParseError ? error.message : (error instanceof Error ? error.message : String(error));
    output.appendLine(`[error] Import from vscode-sftp: ${message}`);
    vscode.window.showErrorMessage(`FileFerry: ${message}`);
    return 'invalid';
  }

  // Q10: ignoreFile is inlined at import time — read each referenced file once, workspace-relative.
  const ignoreFiles: Record<string, string | null> = {};
  for (const entry of parsed.entries) {
    const ignoreFile = entry.raw.ignoreFile;
    if (typeof ignoreFile === 'string' && ignoreFile.trim() !== '' && !(ignoreFile in ignoreFiles)) {
      ignoreFiles[ignoreFile] = await dependencies.readFile(path.resolve(workspaceRoot, ignoreFile));
    }
  }

  const result = await mapEntries(
    {
      entries: parsed.entries,
      parseNotices: parsed.notices,
      existingConfig: await dependencies.configManager.getConfig(),
      existingCredentials: await dependencies.credentialManager.getAll(),
      ignoreFiles,
    },
    dependencies.prompts ?? vscodePrompts
  );

  const imported = result.report.imported.length > 0;
  if (imported) {
    // Credentials first, so the config never references an id that is not stored yet.
    for (const { credential, password, passphrase } of result.credentials) {
      await dependencies.credentialManager.save(credential, password, passphrase);
    }
    await dependencies.configManager.saveConfig(result.config);
    await dependencies.afterWrite?.();
  }

  for (const line of formatImportReport(result.report, sftpJsonPath)) {
    output.appendLine(line);
  }
  output.show(true);
  const summary = summariseImportReport(result.report);
  if (imported) {
    vscode.window.showInformationMessage(summary);
  } else {
    vscode.window.showWarningMessage(summary);
  }
  return imported ? 'imported' : 'nothing-imported';
}
