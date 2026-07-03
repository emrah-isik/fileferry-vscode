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

## Start the test server

The tests need an SFTP server. The repo ships one in [`dev/ssh-test`](../../../dev/ssh-test):

```sh
docker build -t fileferry-ssh dev/ssh-test
docker run -d --rm -p 2222:22 --name fileferry-ssh fileferry-ssh
```

This serves `testuser` / `testpass` on port `2222`, with `/var/www` pre-populated and
`/tmp` writable (the tests upload their probe file under `/tmp`).

Defaults can be overridden with environment variables, so the same suite can point at any
SFTP server:

| Variable | Default |
| --- | --- |
| `FILEFERRY_IT_HOST` | `127.0.0.1` |
| `FILEFERRY_IT_PORT` | `2222` |
| `FILEFERRY_IT_USER` | `testuser` |
| `FILEFERRY_IT_PASS` | `testpass` |

## FTP server (for `ftpService.integration.test.ts`)

The FTP suite needs a real FTP server — see [`dev/ftp-test`](../../../dev/ftp-test):

```sh
docker run -d --name fileferry-ftp -p 21:21 -p 21100-21110:21100-21110 \
  -e USERS="testuser|testpass|/var/www" -e ADDRESS=127.0.0.1 -e MIN_PORT=21100 -e MAX_PORT=21110 \
  delfer/alpine-ftp-server
```

Overrides: `FILEFERRY_FTP_IT_HOST` / `FILEFERRY_FTP_IT_PORT` (default `21`) / `FILEFERRY_FTP_IT_USER` / `FILEFERRY_FTP_IT_PASS`.

## WSL note

On WSL 2 with Docker Desktop, a `connect ECONNREFUSED 127.0.0.1:2222` means the published
port isn't reachable from the WSL distro. Enable **Docker Desktop → Settings → Resources →
WSL Integration** for this distro, then confirm the container is up (`docker ps`) before
re-running. The test's `beforeAll` prints these same start commands if the connection fails.
