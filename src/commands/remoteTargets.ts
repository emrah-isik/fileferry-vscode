import { RemoteFileItem } from '../remoteBrowser/RemoteFileItem';

/**
 * Normalize the (clickedItem, selectedItems) pair VS Code passes to
 * view/item/context commands on a multi-select tree into the list of items the
 * command should act on: the full selection when there is one, otherwise just
 * the clicked item. The provider's connection-error placeholder (empty
 * remotePath) is never a valid target and is filtered out.
 */
export function normalizeRemoteTargets(
  clickedItem: RemoteFileItem | undefined,
  selectedItems: readonly RemoteFileItem[] | undefined
): RemoteFileItem[] {
  const candidates = selectedItems && selectedItems.length > 0 ? [...selectedItems] : [clickedItem];
  return candidates.filter(
    (candidate): candidate is RemoteFileItem =>
      candidate !== undefined && candidate.entry.remotePath !== ''
  );
}

/**
 * Drop any target whose path sits under another selected directory's path.
 * Deleting the ancestor removes its descendants with it, so acting on a
 * descendant afterwards would fail — and counting it would make the
 * confirmation dialog overstate the work. Symlinks to directories count as
 * parents too: deleting one removes the link, leaving descendant paths
 * dangling.
 */
export function dropDescendantTargets(targets: RemoteFileItem[]): RemoteFileItem[] {
  const directoryPaths = targets
    .filter(target =>
      target.entry.type === 'd' ||
      (target.entry.type === 'l' && target.entry.symlinkTarget === 'd')
    )
    .map(target => target.entry.remotePath);

  return targets.filter(target => {
    const targetPath = target.entry.remotePath;
    return !directoryPaths.some(directoryPath =>
      directoryPath !== targetPath &&
      targetPath.startsWith(directoryPath.endsWith('/') ? directoryPath : directoryPath + '/')
    );
  });
}
