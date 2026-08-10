// Headless load-check harness for generated trackers: runs the page's inline
// script inside a node:vm context with a minimal DOM stub, so the suite can
// prove a generated tracker boots, renders every case, and reads its saved
// state — without a browser or any new dependency. Rendered strings are
// captured via innerHTML/textContent assignments.
import * as vm from 'node:vm';

export interface HeadlessTrackerOptions {
  /** Pre-seeded localStorage contents, e.g. a results blob under the state key. */
  storage?: Record<string, string>;
}

export interface HeadlessTracker {
  /** Every string assigned to some element's innerHTML or textContent, in order. */
  renderLog: string[];
  /** The localStorage contents after the page initialized. */
  storage: Map<string, string>;
  /** Look up an element the page addressed by id (lazily created stubs). */
  elementById(id: string): StubElement;
  /** The document.title the page set. */
  title: string;
}

// Test-harness stubs are structurally dynamic by design.
export type StubElement = any;

export async function runTrackerHeadless(
  html: string,
  options: HeadlessTrackerOptions = {}
): Promise<HeadlessTracker> {
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!scriptMatch) {
    throw new Error('no <script> block found in the tracker html');
  }

  const renderLog: string[] = [];
  const storage = new Map(Object.entries(options.storage ?? {}));
  const registry = new Map<string, StubElement>();

  function createStubElement(): StubElement {
    const element: StubElement = {
      children: [],
      style: {},
      dataset: {},
      type: '',
      value: '',
      placeholder: '',
      href: '',
      className: '',
      classList: { add: () => undefined, remove: () => undefined, contains: () => false },
      appendChild(child: StubElement) {
        element.children.push(child);
        return child;
      },
      addEventListener: () => undefined,
      querySelectorAll: () => [],
      querySelector: () => null,
      focus: () => undefined,
      select: () => undefined,
      remove: () => undefined,
      click: () => undefined,
    };
    let innerHtmlValue = '';
    let textContentValue = '';
    let idValue = '';
    Object.defineProperty(element, 'innerHTML', {
      get: () => innerHtmlValue,
      set: (value: unknown) => {
        innerHtmlValue = String(value);
        renderLog.push(innerHtmlValue);
      },
    });
    Object.defineProperty(element, 'textContent', {
      get: () => textContentValue,
      set: (value: unknown) => {
        textContentValue = String(value);
        renderLog.push(textContentValue);
      },
    });
    Object.defineProperty(element, 'id', {
      get: () => idValue,
      set: (value: unknown) => {
        idValue = String(value);
        registry.set(idValue, element);
      },
    });
    return element;
  }

  function elementById(id: string): StubElement {
    let element = registry.get(id);
    if (!element) {
      element = createStubElement();
      element.id = id;
    }
    return element;
  }

  const documentStub: StubElement = {
    title: '',
    body: createStubElement(),
    getElementById: elementById,
    createElement: () => createStubElement(),
    querySelector: () => null,
    execCommand: () => true,
  };

  const sandbox: StubElement = {
    document: documentStub,
    localStorage: {
      getItem: (key: string) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key: string, value: string) => {
        storage.set(key, String(value));
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    location: { protocol: 'file:' },
    navigator: {},
    console,
    setTimeout,
    clearTimeout,
    confirm: () => false,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  // The page boots via an async IIFE; a failure inside it surfaces as an
  // unhandled rejection, which we capture and rethrow as the test failure.
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    vm.runInContext(scriptMatch[1], sandbox, { filename: 'tracker-inline-script.js' });
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  if (rejections.length > 0) {
    throw rejections[0] instanceof Error ? rejections[0] : new Error(String(rejections[0]));
  }

  return {
    renderLog,
    storage,
    elementById,
    get title() {
      return documentStub.title;
    },
  };
}
