// Mock of the VSCode API for unit tests.
// VSCode itself is not available outside the extension host,
// so tests need this stand-in to import anything that uses `vscode`.

const vscode = {
  workspace: {
    getConfiguration: jest.fn().mockReturnValue({
      get: jest.fn(),
      update: jest.fn()
    }),
    workspaceFolders: [{ uri: { fsPath: '/tmp/workspace' } }],
    onDidSaveTextDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  },
  window: {
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showInputBox: jest.fn(),
    showQuickPick: jest.fn(),
    withProgress: jest.fn(),
    createWebviewPanel: jest.fn(),
    createStatusBarItem: jest.fn().mockReturnValue({
      text: '',
      tooltip: '',
      command: '',
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    }),
  },
  commands: {
    registerCommand: jest.fn(),
    executeCommand: jest.fn()
  },
  EventEmitter: jest.fn().mockImplementation(() => ({
    event: jest.fn(),
    fire: jest.fn(),
    dispose: jest.fn()
  })),
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  TreeItem: jest.fn(),
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path, toString: () => path })),
    parse: jest.fn(),
    joinPath: jest.fn((base: any, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      toString: () => [base.fsPath, ...parts].join('/')
    })),
  },
  SecretStorage: jest.fn(),
  ConfigurationTarget: {
    Global: 1,
    Workspace: 2,
    WorkspaceFolder: 3
  },
  ProgressLocation: {
    Notification: 15,
    SourceControl: 1,
    Window: 10,
  },
  ViewColumn: {
    One: 1,
    Two: 2,
    Three: 3,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
};

module.exports = vscode;
