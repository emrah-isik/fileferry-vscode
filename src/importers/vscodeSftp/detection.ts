/**
 * Detection (feature 35b, Q3): when a workspace has `.vscode/sftp.json` but
 * no `fileferry.json`, offer the import once — a non-modal toast with
 * Import / Not now. "Not now" is remembered in workspaceState and the toast
 * never repeats for that workspace. The Servers welcome view shows an import
 * hint (context key) whenever sftp.json is present.
 */

export const VSCODE_SFTP_DISMISSED_KEY = 'fileferry.vscodeSftpImport.dismissed';
export const VSCODE_SFTP_DETECTED_CONTEXT = 'fileferry.vscodeSftpDetected';

export interface DetectionState {
  sftpJsonExists: boolean;
  fileferryJsonExists: boolean;
  dismissed: boolean;
}

export interface DetectionDecision {
  showToast: boolean;
  showHint: boolean;
}

export function decideDetection(state: DetectionState): DetectionDecision {
  return {
    showHint: state.sftpJsonExists,
    showToast: state.sftpJsonExists && !state.fileferryJsonExists && !state.dismissed,
  };
}

export type ToastAnswer = 'Import' | 'Not now' | undefined;

export interface DetectionDependencies {
  workspaceRoot: string | undefined;
  fileExists: (absolutePath: string) => Promise<boolean>;
  workspaceState: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> };
  setContext: (key: string, value: boolean) => Promise<void>;
  showToast: () => Promise<ToastAnswer>;
  runImport: () => Promise<void>;
  joinPath: (...segments: string[]) => string;
  /** Output-channel line; says what was decided and how the offer was answered. */
  log?: (line: string) => void;
}

export async function detectVscodeSftp(dependencies: DetectionDependencies): Promise<DetectionDecision> {
  if (!dependencies.workspaceRoot) {
    return { showToast: false, showHint: false };
  }
  const vscodeFolder = dependencies.joinPath(dependencies.workspaceRoot, '.vscode');
  const state: DetectionState = {
    sftpJsonExists: await dependencies.fileExists(dependencies.joinPath(vscodeFolder, 'sftp.json')),
    fileferryJsonExists: await dependencies.fileExists(dependencies.joinPath(vscodeFolder, 'fileferry.json')),
    dismissed: dependencies.workspaceState.get<boolean>(VSCODE_SFTP_DISMISSED_KEY) === true,
  };
  const decision = decideDetection(state);
  await dependencies.setContext(VSCODE_SFTP_DETECTED_CONTEXT, decision.showHint);
  const log = dependencies.log ?? (() => undefined);
  if (!decision.showToast) {
    if (decision.showHint) {
      log(state.fileferryJsonExists
        ? 'vscode-sftp: .vscode/sftp.json found; fileferry.json already exists, so the import is not offered (run FileFerry: Import from vscode-sftp when you want it)'
        : 'vscode-sftp: .vscode/sftp.json found; the import was already offered for this workspace (Not now), so the toast is not repeated');
    }
    return decision;
  }
  log('vscode-sftp: .vscode/sftp.json found and no fileferry.json; offering the import (toast)');
  const answer = await dependencies.showToast();
  log(answer ? `vscode-sftp: import offer answered "${answer}"` : 'vscode-sftp: import offer closed without an answer; it will be offered again next time');
  if (answer === 'Not now') {
    await dependencies.workspaceState.update(VSCODE_SFTP_DISMISSED_KEY, true);
  } else if (answer === 'Import') {
    await dependencies.workspaceState.update(VSCODE_SFTP_DISMISSED_KEY, true);
    await dependencies.runImport();
  }
  return decision;
}
