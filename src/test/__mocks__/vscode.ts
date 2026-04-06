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
    showOpenDialog: jest.fn(),
    showQuickPick: jest.fn(),
    withProgress: jest.fn(),
    setStatusBarMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
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
  EventEmitter: class EventEmitter {
    private listeners: Array<(...args: any[]) => void> = [];
    event = (listener: (...args: any[]) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (...args: any[]) => { this.listeners.forEach(l => l(...args)); };
    dispose = () => { this.listeners = []; };
  },
  TreeItemCollapsibleState: {
    None: 0,
    Collapsed: 1,
    Expanded: 2
  },
  ThemeIcon: class ThemeIcon {
    constructor(public readonly id: string) {}
  },
  TreeItem: class TreeItem {
    label?: string;
    collapsibleState?: number;
    description?: string;
    iconPath?: any;
    command?: any;
    contextValue?: string;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  Uri: {
    file: jest.fn((path: string) => ({ fsPath: path, toString: () => path })),
    parse: jest.fn(),
    joinPath: jest.fn((base: any, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      toString: () => [base.fsPath, ...parts].join('/')
    })),
  },
  env: {
    clipboard: {
      writeText: jest.fn().mockResolvedValue(undefined),
      readText: jest.fn().mockResolvedValue(''),
    },
  },
  extensions: {
    getExtension: jest.fn(),
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
