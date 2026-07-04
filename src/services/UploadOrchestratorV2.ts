import type { CancellationToken, OutputChannel } from 'vscode';
import { TransferService, canExec } from '../transferService';
import { SshCredentialWithSecret } from '../models/SshCredential';
import { ResolvedUploadItem } from '../path/PathResolver';
import { ProjectServer } from '../models/ProjectConfig';
import { runHooks } from './HookRunner';

export interface UploadSummaryV2 {
  succeeded: ResolvedUploadItem[];
  failed: Array<{ localPath: string; error: string }>;
  deleted: string[];
  deleteFailed: Array<{ remotePath: string; error: string }>;
  cancelled?: ResolvedUploadItem[];
  // Set when a pre-deploy hook failed and aborted the deploy — nothing was
  // transferred. Callers surface this as an error rather than a success.
  hookAborted?: boolean;
}

// Everything the orchestrator needs to run deploy hooks. When absent — or when
// runHooks is false — no hooks run, which is how auto-triggers (on-save/watch)
// stay hook-free per the feature 27 scope decision.
export interface HookExecutionContext {
  workspaceRoot: string;       // cwd for local commands
  dryRun: boolean;
  isTrusted: boolean;          // vscode.workspace.isTrusted — hooks never run when false
  output: OutputChannel;
  runHooks?: boolean;          // default true
}

type ServerWithHooks = {
  filePermissions?: number;
  directoryPermissions?: number;
  hooks?: ProjectServer['hooks'];
};

export class UploadOrchestratorV2 {
  // Transport is REQUIRED (no SftpService default) so every deploy path injects
  // the type-correct transport for its server — see FileDateGuard for the bug
  // this prevents.
  constructor(private readonly sftp: TransferService) {}

  async upload(
    items: ResolvedUploadItem[],
    credential: SshCredentialWithSecret,
    server: ServerWithHooks | null,
    deleteRemotePaths: string[] = [],
    token?: CancellationToken,
    hookContext?: HookExecutionContext
  ): Promise<UploadSummaryV2> {
    const result: UploadSummaryV2 = { succeeded: [], failed: [], deleted: [], deleteFailed: [] };

    // hookContext narrowed to non-null only when hooks should actually run.
    const activeHookContext =
      hookContext && hookContext.runHooks !== false && server?.hooks ? hookContext : null;
    const preDeployHooks = server?.hooks?.preDeploy ?? [];
    const postDeployHooks = server?.hooks?.postDeploy ?? [];

    // Local pre-hooks run BEFORE opening the connection (Decision #6): a build
    // can take minutes, and holding an SSH session idle through it invites
    // timeouts and socket hangs. A failure here aborts before we even connect.
    if (activeHookContext) {
      const localPreHooks = preDeployHooks.filter(hook => hook.location === 'local');
      if (localPreHooks.length > 0) {
        const outcome = await runHooks({
          phase: 'pre',
          hooks: localPreHooks,
          workspaceRoot: activeHookContext.workspaceRoot,
          remote: null,
          dryRun: activeHookContext.dryRun,
          isTrusted: activeHookContext.isTrusted,
          output: activeHookContext.output,
          token,
        });
        if (!outcome.ok) {
          result.hookAborted = true;
          return result;
        }
      }
    }

    await this.sftp.connect(credential, {
      password: credential.password,
      passphrase: credential.passphrase,
    });

    // Remote hooks run over the deploy's own connection — SFTP only. On FTP/FTPS
    // the transfer can't exec, so the runner gets null and skips them with a warning.
    const remote = canExec(this.sftp) ? this.sftp : null;

    try {
      // Remote pre-hooks on the just-opened session; a failure aborts the deploy.
      if (activeHookContext) {
        const remotePreHooks = preDeployHooks.filter(hook => hook.location === 'remote');
        if (remotePreHooks.length > 0) {
          const outcome = await runHooks({
            phase: 'pre',
            hooks: remotePreHooks,
            workspaceRoot: activeHookContext.workspaceRoot,
            remote,
            dryRun: activeHookContext.dryRun,
            isTrusted: activeHookContext.isTrusted,
            output: activeHookContext.output,
            token,
          });
          if (!outcome.ok) {
            result.hookAborted = true;
            return result;
          }
        }
      }

      for (let i = 0; i < items.length; i++) {
        if (token?.isCancellationRequested) {
          result.cancelled = items.slice(i);
          break;
        }
        try {
          await this.sftp.uploadFile(items[i].localPath, items[i].remotePath);
          if (server?.filePermissions !== undefined) {
            try {
              await this.sftp.chmod(items[i].remotePath, server.filePermissions);
            } catch {
              // chmod is best-effort — don't fail the upload
            }
          }
          result.succeeded.push(items[i]);
        } catch (err: unknown) {
          result.failed.push({
            localPath: items[i].localPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!token?.isCancellationRequested) {
        for (const remotePath of deleteRemotePaths) {
          try {
            await this.sftp.deleteFile(remotePath);
            result.deleted.push(remotePath);
          } catch (err: unknown) {
            result.deleteFailed.push({
              remotePath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        result.cancelled = result.cancelled ?? [];
      }

      // Post-hooks (remote + local, in config order) run on the same connection,
      // before teardown. A failed post-hook is reported by the runner but does
      // NOT roll back the already-uploaded files, so the summary is unchanged.
      // Only run them when the deploy actually transferred something: post-hooks
      // mean "after a successful deploy" (per the schema), so a deploy where
      // every upload failed must not fire `migrate`/`reload` against a server
      // that received nothing. A successful delete (e.g. a deletes-only sync)
      // still counts as a transfer.
      const transferredSomething = result.succeeded.length > 0 || result.deleted.length > 0;
      if (
        activeHookContext &&
        postDeployHooks.length > 0 &&
        transferredSomething &&
        !token?.isCancellationRequested
      ) {
        await runHooks({
          phase: 'post',
          hooks: postDeployHooks,
          workspaceRoot: activeHookContext.workspaceRoot,
          remote,
          dryRun: activeHookContext.dryRun,
          isTrusted: activeHookContext.isTrusted,
          output: activeHookContext.output,
          token,
        });
      }
    } finally {
      await this.sftp.disconnect();
    }

    return result;
  }
}
