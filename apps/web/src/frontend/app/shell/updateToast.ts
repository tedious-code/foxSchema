import type { UpdateInfo } from '@/shared/api/updatesApi';
import { applyUpdate, waitForServerAndReload } from '@/shared/api/updatesApi';
import { toast } from '@/platform/toastStore';

const DISMISSED_KEY = 'foxschema-update-toast-v';
const UPGRADE_CMD = 'npm install -g foxschema@latest';

function dismissedFor(latest: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === latest;
  } catch {
    return false;
  }
}

export function rememberUpdateToastDismissed(latest: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, latest);
  } catch {
    /* ignore quota / private mode */
  }
}

async function copyUpgradeCommand(cmd: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(cmd);
    toast({
      tone: 'success',
      title: 'Command copied',
      body: `Paste in a terminal: ${cmd}`,
    });
  } catch {
    toast({
      tone: 'info',
      title: 'Run this in a terminal',
      body: cmd,
      durationMs: 12_000,
    });
  }
}

/** One-click npm global update + wait for UI relaunch. */
export async function runSelfUpdate(): Promise<void> {
  toast({
    tone: 'info',
    title: 'Updating Fox Schema…',
    body: 'Running npm install -g foxschema@latest. The UI will reload when ready.',
    durationMs: 0,
  });
  const result = await applyUpdate();
  if (!result.ok) {
    toast({
      tone: 'warning',
      title: "Couldn't auto-update",
      body: result.error || `Run manually: ${result.upgradeCommand || UPGRADE_CMD}`,
      actionButtonLabel: 'Copy command',
      onAction: () => void copyUpgradeCommand(result.upgradeCommand || UPGRADE_CMD),
      durationMs: 12_000,
    });
    return;
  }
  toast({
    tone: 'success',
    title: 'Update installed',
    body: 'Restarting UI…',
    durationMs: 0,
  });
  try {
    await waitForServerAndReload();
  } catch (e) {
    toast({
      tone: 'info',
      title: 'Restart the UI',
      body: e instanceof Error ? e.message : 'Run: foxschema open',
      durationMs: 12_000,
    });
  }
}

/**
 * Boot-time toast when a newer version is available.
 * Deduped per `latest` so refresh doesn't re-spam after dismiss / view.
 */
export function maybeToastUpdateAvailable(info: UpdateInfo | null, opts?: { force?: boolean }): void {
  if (!info?.updateAvailable || !info.latest) return;
  if (!opts?.force && dismissedFor(info.latest)) return;

  const cmd = info.upgradeCommand || UPGRADE_CMD;
  if (info.canSelfUpdate) {
    toast({
      tone: 'warning',
      title: `Update available · v${info.latest}`,
      body: `You're on v${info.current}. Update now installs the latest package and restarts the UI — no terminal needed.`,
      actionButtonLabel: 'Update now',
      onAction: () => void runSelfUpdate(),
      actionLabel: info.url ? "What's new" : undefined,
      actionHref: info.url,
      durationMs: 14_000,
    });
  } else {
    toast({
      tone: 'warning',
      title: `Update available · v${info.latest}`,
      body: `You're on v${info.current}. Run in a terminal: ${cmd}`,
      actionButtonLabel: 'Copy command',
      onAction: () => void copyUpgradeCommand(cmd),
      actionLabel: info.url ? "What's new" : undefined,
      actionHref: info.url,
      durationMs: 14_000,
    });
  }
  rememberUpdateToastDismissed(info.latest);
}

/** Result toast after an explicit Settings → Check click. */
export function toastUpdateCheckResult(info: UpdateInfo | null): void {
  if (!info) {
    toast({
      tone: 'info',
      title: "Couldn't check for updates",
      body: 'The update feed is unreachable right now. Try again later.',
    });
    return;
  }
  if (info.updateAvailable) {
    maybeToastUpdateAvailable(info, { force: true });
    return;
  }
  toast({
    tone: 'success',
    title: 'You are up to date',
    body: info.configured
      ? `Fox Schema v${info.current} matches npm latest.`
      : `Fox Schema v${info.current} (update check disabled).`,
  });
}
