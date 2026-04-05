import * as vscode from 'vscode';
import { HostKeyStatus } from './HostKeyManager';

export async function showHostKeyPrompt(
  host: string,
  port: number,
  fingerprint: string,
  status: HostKeyStatus
): Promise<boolean> {
  if (status === 'changed') {
    const choice = await vscode.window.showWarningMessage(
      `WARNING: HOST KEY FOR ${host}:${port} HAS CHANGED!\n\n` +
      `This could indicate a man-in-the-middle attack.\n\n` +
      `New fingerprint: ${fingerprint}`,
      { modal: true },
      'Trust Anyway'
    );
    return choice === 'Trust Anyway';
  }

  // status === 'unknown'
  const choice = await vscode.window.showWarningMessage(
    `The authenticity of host '${host}:${port}' can't be established.\n\n` +
    `Fingerprint: ${fingerprint}\n\n` +
    `Are you sure you want to continue connecting?`,
    { modal: true },
    'Trust'
  );
  return choice === 'Trust';
}
