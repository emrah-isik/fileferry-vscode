import * as vscode from 'vscode';

// VSCode passes different argument types to the same command depending on which
// panel triggered it:
//   - SCM panel (scm/resourceState/context): SourceControlResourceState
//   - Explorer panel (explorer/context): vscode.Uri
//
// This helper normalises both into the SourceControlResourceState shape that
// the command handlers (uploadSelected, showRemoteDiff) expect.

function isUri(arg: unknown): arg is vscode.Uri {
  return !!arg && typeof (arg as vscode.Uri).fsPath === 'string' && !(arg as any).resourceUri;
}

function uriToResource(uri: vscode.Uri): vscode.SourceControlResourceState {
  return { resourceUri: uri } as vscode.SourceControlResourceState;
}

export function normalizeCommandArgs(
  arg1: vscode.Uri | vscode.SourceControlResourceState | undefined,
  arg2: vscode.Uri[] | vscode.SourceControlResourceState[] | undefined
): {
  resource: vscode.SourceControlResourceState | undefined;
  allResources: vscode.SourceControlResourceState[] | undefined;
} {
  if (!arg1) {
    return { resource: undefined, allResources: undefined };
  }

  if (isUri(arg1)) {
    const uris = (arg2 as vscode.Uri[] | undefined) ?? [arg1];
    return {
      resource: uriToResource(arg1),
      allResources: uris.map(uriToResource),
    };
  }

  return {
    resource: arg1 as vscode.SourceControlResourceState,
    allResources: arg2 as vscode.SourceControlResourceState[] | undefined,
  };
}
