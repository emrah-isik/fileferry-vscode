import {
  ConnectProviderRegistry,
  ConnectTarget,
  KeyboardInteractiveProvider,
  KeyboardInteractiveRequest,
  PromptContext,
  PrePromptTimer,
  PRE_PROMPT_TIMEOUT_MS,
  createKeyboardInteractiveListener,
  KeyboardInteractiveCoordinator,
} from '../../../ssh/connectProviders';

const target: ConnectTarget = { username: 'deploy', host: 'bastion.example.com', port: 22 };
const otpPrompts = [{ prompt: 'Verification code: ', echo: false }];
const passwordPrompts = [{ prompt: 'Password: ', echo: false }];

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A provider whose prompts resolve only when the test says so. */
function deferredProvider() {
  const pending: Array<{ request: KeyboardInteractiveRequest; resolve: (answers: string[] | null) => void }> = [];
  const provider: KeyboardInteractiveProvider = {
    prompt: jest.fn((request: KeyboardInteractiveRequest, context: PromptContext) => {
      context.promptOpened();
      return new Promise<string[] | null>((resolve) => { pending.push({ request, resolve }); });
    }),
  };
  return { provider, pending };
}

function makeListener(
  coordinator: KeyboardInteractiveCoordinator,
  provider: KeyboardInteractiveProvider,
  overrides: Partial<Parameters<typeof createKeyboardInteractiveListener>[1]> = {}
) {
  const abort = jest.fn();
  const log = jest.fn();
  const context: PromptContext = { promptOpened: jest.fn() };
  const listener = createKeyboardInteractiveListener(coordinator, {
    target,
    authMethod: 'keyboard-interactive',
    provider,
    context,
    log,
    abort,
    ...overrides,
  });
  return { listener, abort, log, context };
}

describe('ConnectProviderRegistry', () => {
  it('starts empty: no providers, but a coordinator and a no-op log', () => {
    const registry = new ConnectProviderRegistry();
    const providers = registry.get();
    expect(providers.keyboardInteractive).toBeUndefined();
    expect(providers.hostKey).toBeUndefined();
    expect(() => providers.log('anything')).not.toThrow();
    expect(registry.coordinator).toBeInstanceOf(KeyboardInteractiveCoordinator);
  });

  it('is set once — a second set() throws', () => {
    const registry = new ConnectProviderRegistry();
    const keyboardInteractive: KeyboardInteractiveProvider = { prompt: jest.fn() };
    registry.set({ keyboardInteractive });
    expect(registry.get().keyboardInteractive).toBe(keyboardInteractive);
    expect(() => registry.set({ keyboardInteractive })).toThrow(/already/i);
  });

  it('clear() empties the providers and the in-flight prompt map', () => {
    const registry = new ConnectProviderRegistry();
    registry.set({ log: jest.fn() });
    registry.coordinator.inFlight.set('k', Promise.resolve(null));
    registry.clear();
    expect(registry.get().keyboardInteractive).toBeUndefined();
    expect(registry.coordinator.inFlight.size).toBe(0);
    expect(() => registry.set({})).not.toThrow();
  });
});

describe('PrePromptTimer', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('fires onExpire after the timeout when no prompt opened', () => {
    const onExpire = jest.fn();
    new PrePromptTimer(PRE_PROMPT_TIMEOUT_MS, onExpire);
    jest.advanceTimersByTime(PRE_PROMPT_TIMEOUT_MS - 1);
    expect(onExpire).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never fires once a prompt has opened', () => {
    const onExpire = jest.fn();
    const timer = new PrePromptTimer(PRE_PROMPT_TIMEOUT_MS, onExpire);
    jest.advanceTimersByTime(PRE_PROMPT_TIMEOUT_MS - 1);
    timer.promptOpened();
    jest.advanceTimersByTime(PRE_PROMPT_TIMEOUT_MS * 10);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('dispose() cancels it', () => {
    const onExpire = jest.fn();
    const timer = new PrePromptTimer(PRE_PROMPT_TIMEOUT_MS, onExpire);
    timer.dispose();
    jest.advanceTimersByTime(PRE_PROMPT_TIMEOUT_MS * 2);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('the default timeout is 20 s', () => {
    expect(PRE_PROMPT_TIMEOUT_MS).toBe(20_000);
  });
});

describe('createKeyboardInteractiveListener', () => {
  let coordinator: KeyboardInteractiveCoordinator;

  beforeEach(() => {
    coordinator = new KeyboardInteractiveCoordinator();
  });

  it('forwards the prompts to the provider with the target and a 1-based round, then finishes with the answers', async () => {
    const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['123456']) };
    const { listener, context } = makeListener(coordinator, provider);
    const finish = jest.fn();

    await listener('', 'Server says hi', '', otpPrompts, finish);

    expect(provider.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ target, round: 1, instructions: 'Server says hi', prompts: otpPrompts }),
      context
    );
    expect(finish).toHaveBeenCalledWith(['123456']);
  });

  it('counts rounds per session — a second USERAUTH_INFO_REQUEST is round 2', async () => {
    const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['x']) };
    const { listener } = makeListener(coordinator, provider);

    await listener('', '', '', passwordPrompts, jest.fn());
    await listener('', '', '', otpPrompts, jest.fn());

    expect(provider.prompt).toHaveBeenNthCalledWith(1, expect.objectContaining({ round: 1 }), expect.anything());
    expect(provider.prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({ round: 2 }), expect.anything());
  });

  it('normalises ssh2 prompts whose echo is undefined to echo: false', async () => {
    const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['x']) };
    const { listener } = makeListener(coordinator, provider);

    await listener('', '', '', [{ prompt: 'Code: ' }], jest.fn());

    expect(provider.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ prompts: [{ prompt: 'Code: ', echo: false }] }),
      expect.anything()
    );
  });

  describe('per-round coalescing', () => {
    it('two sessions hitting the same (target, round, prompts) share one prompt and both get the answer', async () => {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);
      const finishA = jest.fn();
      const finishB = jest.fn();

      const doneA = sessionA.listener('', '', '', otpPrompts, finishA);
      const doneB = sessionB.listener('', '', '', otpPrompts, finishB);
      await flushMicrotasks();

      expect(provider.prompt).toHaveBeenCalledTimes(1);
      expect(sessionB.log).toHaveBeenCalledWith(expect.stringMatching(/coalesc/i));

      pending[0].resolve(['654321']);
      await Promise.all([doneA, doneB]);

      expect(finishA).toHaveBeenCalledWith(['654321']);
      expect(finishB).toHaveBeenCalledWith(['654321']);
      expect(coordinator.inFlight.size).toBe(0);
    });

    it('does NOT coalesce across rounds — a round-2 prompt never receives a round-1 answer (H1)', async () => {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);

      // A is already past round 1 …
      const doneA1 = sessionA.listener('', '', '', passwordPrompts, jest.fn());
      pending[0].resolve(['pw']);
      await doneA1;
      // … and now asks the OTP prompt as its round 2, while B asks the very same prompt texts as its round 1.
      const finishA = jest.fn();
      const finishB = jest.fn();
      const doneA2 = sessionA.listener('', '', '', otpPrompts, finishA);
      const doneB = sessionB.listener('', '', '', otpPrompts, finishB);
      await flushMicrotasks();

      expect(provider.prompt).toHaveBeenCalledTimes(3);
      pending[1].resolve(['111111']);
      pending[2].resolve(['222222']);
      await Promise.all([doneA2, doneB]);
      expect(finishA).toHaveBeenCalledWith(['111111']);
      expect(finishB).toHaveBeenCalledWith(['222222']);
    });

    it('does NOT coalesce different prompt texts in the same round', async () => {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);

      const doneA = sessionA.listener('', '', '', otpPrompts, jest.fn());
      const doneB = sessionB.listener('', '', '', passwordPrompts, jest.fn());
      await flushMicrotasks();

      expect(provider.prompt).toHaveBeenCalledTimes(2);
      pending.forEach((p) => p.resolve(['x']));
      await Promise.all([doneA, doneB]);
    });

    it('does NOT coalesce different targets', async () => {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider, { target: { ...target, port: 2222 } });

      const doneA = sessionA.listener('', '', '', otpPrompts, jest.fn());
      const doneB = sessionB.listener('', '', '', otpPrompts, jest.fn());
      await flushMicrotasks();

      expect(provider.prompt).toHaveBeenCalledTimes(2);
      pending.forEach((p) => p.resolve(['x']));
      await Promise.all([doneA, doneB]);
    });

    it('a later session asks afresh once the shared prompt has settled', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['1']) };
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);

      await sessionA.listener('', '', '', otpPrompts, jest.fn());
      await sessionB.listener('', '', '', otpPrompts, jest.fn());

      expect(provider.prompt).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancel', () => {
    it('cancelling the shared prompt aborts every waiting session and never calls finish', async () => {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);
      const finishA = jest.fn();
      const finishB = jest.fn();

      const doneA = sessionA.listener('', '', '', otpPrompts, finishA);
      const doneB = sessionB.listener('', '', '', otpPrompts, finishB);
      await flushMicrotasks();
      pending[0].resolve(null);
      await Promise.all([doneA, doneB]);

      expect(finishA).not.toHaveBeenCalled();
      expect(finishB).not.toHaveBeenCalled();
      expect(sessionA.abort).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i));
      expect(sessionB.abort).toHaveBeenCalledWith(expect.stringMatching(/cancelled/i));
    });

    it('a provider that throws aborts the session with the error message (fail closed)', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockRejectedValue(new Error('UI exploded')) };
      const { listener, abort } = makeListener(coordinator, provider);
      const finish = jest.fn();

      await listener('', '', '', otpPrompts, finish);

      expect(finish).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledWith(expect.stringContaining('UI exploded'));
      expect(coordinator.inFlight.size).toBe(0);
    });
  });

  describe('auth failure after a replayed answer (H1 / R8-8)', () => {
    async function replayedSessionB() {
      const { provider, pending } = deferredProvider();
      const sessionA = makeListener(coordinator, provider);
      const sessionB = makeListener(coordinator, provider);
      const doneA = sessionA.listener('', '', '', otpPrompts, jest.fn());
      const doneB = sessionB.listener('', '', '', otpPrompts, jest.fn());
      await flushMicrotasks();
      pending[0].resolve(['replayed']);
      await Promise.all([doneA, doneB]);
      expect(provider.prompt).toHaveBeenCalledTimes(1);
      return { provider, pending, sessionB };
    }

    it('re-prompts that session once, directly (not coalesced), when the server repeats the prompt', async () => {
      const { provider, pending, sessionB } = await replayedSessionB();
      const finishB = jest.fn();

      const doneB2 = sessionB.listener('', '', '', otpPrompts, finishB);
      await flushMicrotasks();

      expect(provider.prompt).toHaveBeenCalledTimes(2);
      expect(coordinator.inFlight.size).toBe(0); // not offered for coalescing
      expect(sessionB.log).toHaveBeenCalledWith(expect.stringMatching(/replayed.*rejected|asking again/i));
      pending[1].resolve(['fresh']);
      await doneB2;
      expect(finishB).toHaveBeenCalledWith(['fresh']);
    });

    it('gives up after the one re-prompt: a third identical prompt is answered empty', async () => {
      const { provider, pending, sessionB } = await replayedSessionB();
      const doneB2 = sessionB.listener('', '', '', otpPrompts, jest.fn());
      await flushMicrotasks();
      pending[1].resolve(['fresh']);
      await doneB2;

      const finishB3 = jest.fn();
      await sessionB.listener('', '', '', otpPrompts, finishB3);

      expect(provider.prompt).toHaveBeenCalledTimes(2);
      expect(finishB3).toHaveBeenCalledWith(['']);
    });
  });

  describe('keychain auto-answer (R5 / C3)', () => {
    it('answers a /password/i prompt from the keychain once for password credentials, without prompting', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['typed']) };
      const { listener, log } = makeListener(coordinator, provider, { authMethod: 'password', password: 's3cret' });
      const finish = jest.fn();

      await listener('', '', '', passwordPrompts, finish);

      expect(finish).toHaveBeenCalledWith(['s3cret']);
      expect(provider.prompt).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/keychain/i));
    });

    it('asks the user when the server asks for the password again (wrong keychain password)', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['typed']) };
      const { listener } = makeListener(coordinator, provider, { authMethod: 'password', password: 's3cret' });
      const finish = jest.fn();

      await listener('', '', '', passwordPrompts, jest.fn());
      await listener('', '', '', passwordPrompts, finish);

      expect(provider.prompt).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith(['typed']);
    });

    it('never auto-answers for other auth methods', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['typed']) };
      const { listener } = makeListener(coordinator, provider, { authMethod: 'key', password: 'ignored' });
      const finish = jest.fn();

      await listener('', '', '', passwordPrompts, finish);

      expect(provider.prompt).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith(['typed']);
    });

    it('never auto-answers a non-password prompt (an OTP prompt goes to the user)', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['typed']) };
      const { listener } = makeListener(coordinator, provider, { authMethod: 'password', password: 's3cret' });

      await listener('', '', '', otpPrompts, jest.fn());

      expect(provider.prompt).toHaveBeenCalledTimes(1);
    });

    it('never auto-answers when no password is stored', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['typed']) };
      const { listener } = makeListener(coordinator, provider, { authMethod: 'password', password: undefined });

      await listener('', '', '', passwordPrompts, jest.fn());

      expect(provider.prompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('logging (L4 — plain channel, no secrets)', () => {
    it('logs the route and round but never the password or an answer', async () => {
      const provider: KeyboardInteractiveProvider = { prompt: jest.fn().mockResolvedValue(['otp-answer-987']) };
      const { listener, log } = makeListener(coordinator, provider, { authMethod: 'password', password: 'hunter2' });

      await listener('', '', '', passwordPrompts, jest.fn());
      await listener('', '', '', otpPrompts, jest.fn());

      const lines = log.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('deploy@bastion.example.com:22') && /round 1/.test(line))).toBe(true);
      expect(lines.some((line) => /round 2/.test(line))).toBe(true);
      for (const line of lines) {
        expect(line).not.toContain('hunter2');
        expect(line).not.toContain('otp-answer-987');
      }
    });
  });
});
