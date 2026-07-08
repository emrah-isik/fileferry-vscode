import { SecretMaskingOutputChannel } from '../../../services/SecretMaskingOutputChannel';

function makeInnerChannel() {
  return {
    name: 'FileFerry',
    append: jest.fn(),
    appendLine: jest.fn(),
    replace: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  };
}

describe('SecretMaskingOutputChannel', () => {
  let inner: ReturnType<typeof makeInnerChannel>;
  let channel: SecretMaskingOutputChannel;

  beforeEach(() => {
    inner = makeInnerChannel();
    channel = new SecretMaskingOutputChannel(inner as any);
  });

  it('passes text through untouched before any value is registered', () => {
    channel.appendLine('deploy done, token was tok-secret-123');
    expect(inner.appendLine).toHaveBeenCalledWith('deploy done, token was tok-secret-123');
  });

  it('replaces a registered value with •••• in appendLine', () => {
    channel.registerSecretValues(['tok-secret-123']);
    channel.appendLine('Authorization: Bearer tok-secret-123');
    expect(inner.appendLine).toHaveBeenCalledWith('Authorization: Bearer ••••');
  });

  it('masks every occurrence, and in append and replace too', () => {
    channel.registerSecretValues(['hunter2']);
    channel.append('hunter2 and hunter2');
    channel.replace('again hunter2');
    expect(inner.append).toHaveBeenCalledWith('•••• and ••••');
    expect(inner.replace).toHaveBeenCalledWith('again ••••');
  });

  it('masks all registered values, also across separate register calls', () => {
    channel.registerSecretValues(['tok-secret-123']);
    channel.registerSecretValues(['hunter2']);
    channel.appendLine('token tok-secret-123 pass hunter2');
    expect(inner.appendLine).toHaveBeenCalledWith('token •••• pass ••••');
  });

  it('masks a longer value before a shorter overlapping one — no partial leak', () => {
    channel.registerSecretValues(['abc', 'abcdef']);
    channel.appendLine('value is abcdef');
    expect(inner.appendLine).toHaveBeenCalledWith('value is ••••');
  });

  it('treats the value as a literal string, not a regular expression', () => {
    channel.registerSecretValues(['p@$$(w.rd)+']);
    channel.appendLine('secret: p@$$(w.rd)+ end');
    expect(inner.appendLine).toHaveBeenCalledWith('secret: •••• end');
  });

  it('ignores an empty value instead of corrupting all output', () => {
    channel.registerSecretValues(['']);
    channel.appendLine('nothing to mask here');
    expect(inner.appendLine).toHaveBeenCalledWith('nothing to mask here');
  });

  // The under-promise, pinned as behaviour: we mask values FileFerry resolved,
  // nothing else. A secret we never handled goes through verbatim.
  it('does NOT mask a value that was never registered', () => {
    channel.registerSecretValues(['tok-secret-123']);
    channel.appendLine('some other credential: super-secret-999');
    expect(inner.appendLine).toHaveBeenCalledWith('some other credential: super-secret-999');
  });

  it('delegates the non-text members to the wrapped channel', () => {
    expect(channel.name).toBe('FileFerry');
    channel.clear();
    channel.show();
    channel.hide();
    channel.dispose();
    expect(inner.clear).toHaveBeenCalled();
    expect(inner.show).toHaveBeenCalled();
    expect(inner.hide).toHaveBeenCalled();
    expect(inner.dispose).toHaveBeenCalled();
  });
});
