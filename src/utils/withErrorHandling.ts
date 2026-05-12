import * as vscode from 'vscode';

// Wraps an async command handler so that any thrown error is logged to the
// FileFerry output channel and surfaced as an error popup, instead of being
// silently swallowed by VSCode's command runtime.
export function withErrorHandling(
  label: string,
  output: vscode.OutputChannel,
  fn: (...args: any[]) => Promise<void>
): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`[error] ${label}: ${message}`);
      vscode.window.showErrorMessage(`FileFerry: ${message}`);
    }
  };
}
