# Integration tests

These tests run against a **real SFTP server**, unlike the unit tests, which mock
`ssh2-sftp-client`. They exist to verify the things a mock cannot: that our assumptions
about the library's actual return shapes are correct. The first test here is the one that
would have caught the `stats.mtime` → `NaN` bug (the unit test mocked the wrong shape and
passed; see the comment block in `sftpService.integration.test.ts`).

They are **opt-in** and excluded from `npm test`.

## Run them

```sh
npm run test:integration
```

This uses [`jest.integration.config.js`](../../../jest.integration.config.js), which matches
only `src/test/integration/**/*.integration.test.ts`.

Suites **skip with a message** when their fixture isn't reachable (they used to throw) —
see `fixtureProbe.ts`.

## Start the SSH fixture (compose: bastion + target)

The SSH suites need the compose fixture in [`dev/ssh-test`](../../../dev/ssh-test) —
a **bastion** published on `127.0.0.1:2222` and a **target** on an internal-only
network, reachable exclusively through the bastion (this is what the jump-host
suite exercises):

```sh
docker compose -f dev/ssh-test/docker-compose.yml up -d --build
```

> **Migrating from the old single container?** Stop `fileferry-ssh` first
> (`docker stop fileferry-ssh`) — the bastion takes over its port. The
> `jumpHost` suite refuses to run against the old container.

The bastion serves `testuser` / `testpass` with `/var/www` pre-populated and `/tmp`
writable — everything the pre-compose suites used — plus:

| User | Auth | Purpose |
| --- | --- | --- |
| `testuser` / `testpass` | password | the six pre-existing suites; bastion hop |
| `mfauser` / `mfapass` | keyboard-interactive only, TWO rounds: password, then a TOTP code (same secret as totpuser, **no** reuse limit) | multi-round KI |
| `mfakeyuser` / `mfakeypass` | `publickey,keyboard-interactive` (key: `dev/ssh-test/bastion/mfakeyuser_ed25519`, test-only) | the C3 case |
| `totpuser` / `totppass` | keyboard-interactive: password, then a real TOTP code (secret `JBSWY3DPEHPK3PXP`, `DISALLOW_REUSE`) | code-reuse rejection |

The **target** serves `deploy` / `deploypass` with a populated `/var/www` including
`target-marker.txt` (exists only there — proves a session really crossed the bastion).
The bastion logs to `/var/log/sshd.log` (world-readable) so tests can count logins.

Defaults can be overridden with environment variables:

| Variable | Default |
| --- | --- |
| `FILEFERRY_IT_HOST` / `FILEFERRY_IT_PORT` | `127.0.0.1` / `2222` (bastion) |
| `FILEFERRY_IT_USER` / `FILEFERRY_IT_PASS` | `testuser` / `testpass` |
| `FILEFERRY_IT_TARGET_HOST` / `FILEFERRY_IT_TARGET_PORT` | `target` / `22` |
| `FILEFERRY_IT_TARGET_USER` / `FILEFERRY_IT_TARGET_PASS` | `deploy` / `deploypass` |

## FTP server (for `ftpService.integration.test.ts`)

The FTP suite needs a real FTP server — see [`dev/ftp-test`](../../../dev/ftp-test):

```sh
docker run -d --name fileferry-ftp -p 21:21 -p 21100-21110:21100-21110 \
  -e USERS="testuser|testpass|/var/www" -e ADDRESS=127.0.0.1 -e MIN_PORT=21100 -e MAX_PORT=21110 \
  delfer/alpine-ftp-server
```

Overrides: `FILEFERRY_FTP_IT_HOST` / `FILEFERRY_FTP_IT_PORT` (default `21`) / `FILEFERRY_FTP_IT_USER` / `FILEFERRY_FTP_IT_PASS`.

## WSL note

On WSL 2 with Docker Desktop, a skip message naming `127.0.0.1:2222` means the published
port isn't reachable from the WSL distro. Enable **Docker Desktop → Settings → Resources →
WSL Integration** for this distro, then confirm the stack is up (`docker compose -f
dev/ssh-test/docker-compose.yml ps`) before re-running.
