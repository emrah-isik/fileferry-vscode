import * as vscode from 'vscode';
import { withErrorHandling } from '../../../utils/withErrorHandling';

function makeOutputChannel(): { channel: vscode.OutputChannel; appendLine: jest.Mock } {
  const appendLine = jest.fn();
  const channel = { appendLine } as unknown as vscode.OutputChannel;
  return { channel, appendLine };
}

describe('withErrorHandling', () => {
  let showErrorMessage: jest.Mock;

  beforeEach(() => {
    showErrorMessage = vscode.window.showErrorMessage as jest.Mock;
    showErrorMessage.mockReset();
  });

  describe('happy path — wrapped fn resolves', () => {
    it('forwards all args to the wrapped fn unchanged', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped('a', 1, { x: true });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('a', 1, { x: true });
    });

    it('preserves variadic arg order including undefined slots', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped('a', undefined, 'c');

      expect(fn).toHaveBeenCalledWith('a', undefined, 'c');
    });

    it('forwards a call with no args', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(fn).toHaveBeenCalledWith();
    });

    it('does not log to the output channel when fn resolves', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).not.toHaveBeenCalled();
    });

    it('does not show an error popup when fn resolves', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(showErrorMessage).not.toHaveBeenCalled();
    });
  });

  describe('error path — wrapped fn throws', () => {
    it('logs [error] {label}: {message} to the output channel for Error instances', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).toHaveBeenCalledTimes(1);
      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: boom');
    });

    it('shows "FileFerry: {message}" popup for Error instances', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(showErrorMessage).toHaveBeenCalledTimes(1);
      expect(showErrorMessage).toHaveBeenCalledWith('FileFerry: boom');
    });

    it('catches synchronous throws before any await', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn(() => {
        throw new Error('sync boom');
      }) as unknown as (...args: any[]) => Promise<void>;
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await expect(wrapped()).resolves.toBeUndefined();
      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: sync boom');
      expect(showErrorMessage).toHaveBeenCalledWith('FileFerry: sync boom');
    });

    it('does not rethrow — caller sees a resolved promise', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue(new Error('boom'));
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await expect(wrapped()).resolves.toBeUndefined();
    });

    it('uses String(err) for plain string rejections', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue('plain string error');
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: plain string error');
      expect(showErrorMessage).toHaveBeenCalledWith('FileFerry: plain string error');
    });

    it('uses String(err) for undefined rejections', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: undefined');
      expect(showErrorMessage).toHaveBeenCalledWith('FileFerry: undefined');
    });

    it('uses String(err) for object rejections without message property', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue({ code: 'ENOENT' });
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: [object Object]');
    });

    it('uses err.message for Error subclasses', async () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'CustomError';
        }
      }
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest.fn().mockRejectedValue(new CustomError('subclass message'));
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();

      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: subclass message');
    });
  });

  describe('isolation between invocations', () => {
    it('does not leak error state across successive calls', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fn = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('second call fails'))
        .mockResolvedValueOnce(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      await wrapped();
      await wrapped();
      await wrapped();

      expect(fn).toHaveBeenCalledTimes(3);
      expect(appendLine).toHaveBeenCalledTimes(1);
      expect(appendLine).toHaveBeenCalledWith('[error] myLabel: second call fails');
      expect(showErrorMessage).toHaveBeenCalledTimes(1);
      expect(showErrorMessage).toHaveBeenCalledWith('FileFerry: second call fails');
    });

    it('different labels produce different log prefixes when both wrappers fail', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fnA = jest.fn().mockRejectedValue(new Error('A failed'));
      const fnB = jest.fn().mockRejectedValue(new Error('B failed'));
      const wrappedA = withErrorHandling('opA', channel, fnA);
      const wrappedB = withErrorHandling('opB', channel, fnB);

      await wrappedA();
      await wrappedB();

      expect(appendLine).toHaveBeenCalledWith('[error] opA: A failed');
      expect(appendLine).toHaveBeenCalledWith('[error] opB: B failed');
    });

    it('two wrappers sharing one channel both write to it', async () => {
      const { channel, appendLine } = makeOutputChannel();
      const fnA = jest.fn().mockRejectedValue(new Error('A'));
      const fnB = jest.fn().mockRejectedValue(new Error('B'));
      const wrappedA = withErrorHandling('opA', channel, fnA);
      const wrappedB = withErrorHandling('opB', channel, fnB);

      await wrappedA();
      await wrappedB();

      expect(appendLine).toHaveBeenCalledTimes(2);
    });
  });

  describe('signature', () => {
    it('returns a function with the same call signature as the input', async () => {
      const { channel } = makeOutputChannel();
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = withErrorHandling('myLabel', channel, fn);

      expect(typeof wrapped).toBe('function');
      const result = wrapped();
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
