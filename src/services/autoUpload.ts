import * as path from 'path';
import { execFile } from 'child_process';
import { PathResolver } from '../path/PathResolver';
import { UploadOrchestratorV2, UploadSummaryV2 } from './UploadOrchestratorV2';
import { createTransferService } from '../transferServiceFactory';
import { FileDateGuard } from './FileDateGuard';
import { UploadHistoryService } from './UploadHistoryService';
import { summaryToHistoryEntries } from './summaryToHistoryEntries';
import { InteractionRequiredError } from '../ssh/connectErrors';
import { CredentialManager } from '../storage/CredentialManager';
import { ProjectConfigManager } from '../storage/ProjectConfigManager';
import { ProjectConfig } from '../models/ProjectConfig';

interface Dependencies {
  credentialManager: CredentialManager;
  configManager: ProjectConfigManager;
}

export type AutoUploadTrigger = 'save' | 'watch';

export type AutoUploadSkipReason = 'no-server' | 'gitignored' | 'excluded' | 'remote-newer';

export type AutoUploadOutcome =
  | { status: 'skipped'; reason: AutoUploadSkipReason; fileName: string }
  | { status: 'uploaded'; summary: UploadSummaryV2; serverName: string; fileName: string }
  | { status: 'error'; error: string; fileName: string }
  // The background connect was refused because verification would need the
  // user (host not yet trusted, or auth requires prompts). Renderers show the
  // shared non-modal warning with a Test Connection button (18a-1b, Q32/H2).
  | { status: 'verification-required'; error: string; serverId: string; serverName: string; fileName: string };

/**
 * Shared core for trigger-driven single-file auto-upload (on-save and watch).
 * Resolves the file against the default server, optionally applies the gitignore
 * check, honours the file-date guard, uploads, and logs history. Returns a
 * UI-free outcome; each trigger renders its own feedback.
 *
 * The `applyGitIgnore` option is the key difference between triggers: on-save
 * passes `true` (skip git-ignored files); the watcher passes `false`, because
 * build outputs are typically git-ignored and are exactly what it must upload —
 * the watch globs are the explicit allowlist.
 *
 * Callers are expected to have already applied their own entry gates (workspace
 * membership, the uploadOnSave / watch.enabled toggle, dry-run handling).
 */
export async function autoUploadFile(
  localPath: string,
  workspaceRoot: string,
  config: ProjectConfig,
  dependencies: Dependencies,
  trigger: AutoUploadTrigger,
  options: { applyGitIgnore: boolean }
): Promise<AutoUploadOutcome> {
  const fileName = path.basename(localPath);

  const match = await dependencies.configManager.getServerById(config.defaultServerId);
  if (!match || match.server.mappings.length === 0) {
    return { status: 'skipped', reason: 'no-server', fileName };
  }
  const { name: serverName, server } = match;

  if (options.applyGitIgnore && (await isGitIgnored(localPath, workspaceRoot))) {
    return { status: 'skipped', reason: 'gitignored', fileName };
  }

  const pathResolver = new PathResolver();
  let resolved;
  try {
    resolved = pathResolver.resolve(localPath, workspaceRoot, {
      rootPath: server.rootPath,
      mappings: server.mappings,
      excludedPaths: server.excludedPaths,
    });
  } catch {
    return { status: 'skipped', reason: 'excluded', fileName };
  }

  try {
    const credential = await dependencies.credentialManager.getWithSecret(server.credentialId);

    // File date guard — skip if the remote is newer. Non-blocking on errors,
    // EXCEPT a verification refusal: that would hit the orchestrator's
    // connect identically, so silently skipping the guard and then failing
    // the upload would hide the real problem (H2). Both connections here are
    // background triggers, so neither may prompt (interactive: false).
    const fileDateGuardEnabled = config.fileDateGuard !== false;
    try {
      const newerOnRemote = fileDateGuardEnabled
        ? await new FileDateGuard(createTransferService(server.type))
          .check([resolved], credential, server.timeOffsetMs, { interactive: false })
        : [];
      if (newerOnRemote.length > 0) {
        return { status: 'skipped', reason: 'remote-newer', fileName };
      }
    } catch (guardError: unknown) {
      if (guardError instanceof InteractionRequiredError) {
        return {
          status: 'verification-required',
          error: guardError.message,
          serverId: server.id,
          serverName,
          fileName,
        };
      }
      // Any other date-guard failure must not block the upload.
    }

    const orchestrator = new UploadOrchestratorV2(createTransferService(server.type));
    // Auto-triggers (on-save / watch) deliberately run NO deploy hooks (feature 27
    // scope decision #5): a remote reload/migration on every save would hammer the
    // server. Passing no hook context — like the null server — keeps this path
    // hook-free; only deliberate deploys (uploadSelected / uploadToServers / sync)
    // supply a hook context.
    const summary = await orchestrator.upload(
      [resolved], credential, null, [], undefined, undefined, { interactive: false }
    );

    const historyMaxEntries = config.historyMaxEntries ?? 10000;
    if (historyMaxEntries > 0) {
      const historyService = new UploadHistoryService(workspaceRoot, historyMaxEntries);
      const entries = summaryToHistoryEntries(summary, server.id, serverName, Date.now(), trigger);
      await historyService.log(entries);
      await historyService.enforceRetention();
    }

    return { status: 'uploaded', summary, serverName, fileName };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof InteractionRequiredError) {
      return { status: 'verification-required', error: message, serverId: server.id, serverName, fileName };
    }
    return { status: 'error', error: message, fileName };
  }
}

function isGitIgnored(filePath: string, cwd: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile('git', ['check-ignore', '-q', filePath], { cwd }, err => {
      if (!err) {
        resolve(true); // exit 0 = ignored
      } else if ((err as { code?: number }).code === 1) {
        resolve(false); // exit 1 = not ignored
      } else {
        resolve(false); // git missing / other error — don't block
      }
    });
  });
}
