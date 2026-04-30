import * as vscode from 'vscode';

// VSCode passes different argument shapes depending on which panel triggered
// the command:
//   - Explorer (explorer/context):              (uri: Uri, allUris: Uri[])
//   - SCM (scm/resourceState/context):          (...resourceStates: SourceControlResourceState[])
//   - Keybinding with no selection:             ()
//
// Why: VSCode's git extension uses the variadic signature for SCM context
// commands (see vscode/extensions/git/src/commands.ts). Treating arg2 as an
// array there silently dropped extra selections — a single right-click with
// 4 files selected only uploaded the right-clicked one.

function isUri(arg: unknown): arg is vscode.Uri {
  return !!arg && typeof (arg as vscode.Uri).fsPath === 'string' && !(arg as any).resourceUri;
}

function isResourceState(arg: unknown): arg is vscode.SourceControlResourceState {
  return !!arg && typeof arg === 'object' && !!(arg as vscode.SourceControlResourceState).resourceUri
    && typeof ((arg as vscode.SourceControlResourceState).resourceUri as vscode.Uri).fsPath === 'string';
}

function uriToResource(uri: vscode.Uri): vscode.SourceControlResourceState {
  return { resourceUri: uri } as vscode.SourceControlResourceState;
}

export function normalizeCommandArgs(
  ...args: unknown[]
): {
  resource: vscode.SourceControlResourceState | undefined;
  allResources: vscode.SourceControlResourceState[] | undefined;
} {
  const [arg1, arg2] = args;

  if (arg1 === undefined) {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && activeUri.scheme === 'file') {
      return {
        resource: uriToResource(activeUri),
        allResources: [uriToResource(activeUri)],
      };
    }
    return { resource: undefined, allResources: undefined };
  }

  // Explorer pattern: (Uri, Uri[])
  if (isUri(arg1)) {
    const uris = (arg2 as vscode.Uri[] | undefined) ?? [arg1];
    return {
      resource: uriToResource(arg1),
      allResources: uris.map(uriToResource),
    };
  }

  // SCM pattern: variadic SourceControlResourceState
  const resources = args.filter(isResourceState);
  return {
    resource: resources[0],
    allResources: resources.length > 0 ? resources : undefined,
  };
}
