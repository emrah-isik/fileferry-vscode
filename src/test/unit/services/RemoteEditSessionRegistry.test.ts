import {
  RemoteEditSessionRegistry,
  RemoteEditSession,
} from '../../../services/RemoteEditSessionRegistry';

const session = (overrides: Partial<RemoteEditSession> = {}): RemoteEditSession => ({
  serverId: 'server-1',
  remotePath: '/var/www/index.php',
  downloadedMtimeMs: 1780000000000,
  sha256: 'a'.repeat(64),
  ...overrides,
});

describe('RemoteEditSessionRegistry', () => {
  let registry: RemoteEditSessionRegistry;

  beforeEach(() => {
    registry = new RemoteEditSessionRegistry();
  });

  it('returns undefined for a path that was never registered', () => {
    expect(registry.get('/tmp/fileferry-browse/unknown.remote.abc123.php')).toBeUndefined();
  });

  it('returns the registered session for a known path', () => {
    const tempPath = '/tmp/fileferry-browse/index.remote.abc123.php';
    registry.register(tempPath, session());

    expect(registry.get(tempPath)).toEqual(session());
  });

  it('overwrites the session when the same path is registered again', () => {
    const tempPath = '/tmp/fileferry-browse/index.remote.abc123.php';
    registry.register(tempPath, session({ downloadedMtimeMs: 1780000000000 }));
    registry.register(tempPath, session({ downloadedMtimeMs: 1780000099000, sha256: 'b'.repeat(64) }));

    expect(registry.get(tempPath)).toEqual(
      session({ downloadedMtimeMs: 1780000099000, sha256: 'b'.repeat(64) })
    );
  });

  it('keeps sessions for different paths independent', () => {
    registry.register('/tmp/fileferry-browse/one.remote.abc123.php', session({ remotePath: '/var/www/one.php' }));
    registry.register('/tmp/fileferry-browse/two.remote.def456.php', session({ remotePath: '/var/www/two.php' }));

    expect(registry.get('/tmp/fileferry-browse/one.remote.abc123.php')?.remotePath).toBe('/var/www/one.php');
    expect(registry.get('/tmp/fileferry-browse/two.remote.def456.php')?.remotePath).toBe('/var/www/two.php');
  });

  it('unregister removes the session', () => {
    const tempPath = '/tmp/fileferry-browse/index.remote.abc123.php';
    registry.register(tempPath, session());
    registry.unregister(tempPath);

    expect(registry.get(tempPath)).toBeUndefined();
  });

  it('unregister of an unknown path is a no-op', () => {
    expect(() => registry.unregister('/tmp/fileferry-browse/unknown.remote.abc123.php')).not.toThrow();
  });
});
