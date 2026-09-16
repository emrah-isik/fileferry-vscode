import * as vscode from 'vscode';
import { UploadConfirmation } from '../uploadConfirmation';

// "FileFerry: Reset Upload Confirmations". Clears every stored "don't ask again"
// flag and says how many servers that covered. (Until feature 36 this command
// only showed the toast; the flags stayed set, so suppression was permanent. #27)
export async function resetConfirmations(globalState: vscode.Memento): Promise<void> {
  const cleared = await new UploadConfirmation(globalState).resetAll();
  if (cleared === 0) {
    vscode.window.showInformationMessage('FileFerry: nothing to reset, no server had "don\'t ask again" set.');
    return;
  }
  const label = cleared === 1 ? '1 server' : `${cleared} servers`;
  vscode.window.showInformationMessage(`FileFerry: upload confirmations reset for ${label}.`);
}
