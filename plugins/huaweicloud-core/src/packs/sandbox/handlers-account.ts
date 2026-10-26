import { execOneShot, execWithSession, setWorkspaceId } from '../../sandbox/session-manager.ts';
import { hdkitCheckUser, hdkitSignAgreement, hdkitConnect } from '../../lib/hdkit/hdkitservice-api.ts';
import type { CallToolOptions, ToolArgs } from '../../tools.ts';
import { transferGitRepo } from './git-transfer.ts';

// Account/session-gate handlers (check_user, sign_agreement, connect) for
// the sandbox pack, extracted verbatim from tools.ts in the within-pack
// split for the jscpd complex-file bar; the tools.ts face imports them for
// SANDBOX_TOOL_HANDLERS. handleConnect owns the git repo transfer chain
// invocation (git-transfer.ts).

export async function handleCheckUser(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitCheckUser();
}

export async function handleSignAgreement(_args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  return await hdkitSignAgreement();
}

export async function handleConnect(args: ToolArgs = {}, _opts: CallToolOptions = {}) {
  const connectResult = await hdkitConnect(args);
  const rawDevStageId = connectResult?.dev_stage_id || connectResult?.devStageId;
  const devStageId = typeof rawDevStageId === 'string' ? rawDevStageId : undefined;
  if (devStageId) {
    setWorkspaceId(devStageId);
    try {
      await execOneShot(devStageId, 'devbridge delete-all 2>/dev/null || true', 'root', 15000);
    } catch {
      // best-effort: a fresh sandbox may have no tunnels (or no devbridge) to delete
    }
    try {
      // #999: /workspace/.local/bin first — the data-disk install survives
      // sandbox reboots; ~/.huawei/bin is wiped back to the image state.
      await execWithSession(
        devStageId,
        'export PATH=/workspace/.local/bin:$HOME/.huawei/bin${PATH:+:$PATH}',
        'root',
        10000,
      );
    } catch {
      // best-effort: the PATH export only aids later devbridge calls in this session
    }
    await transferGitRepo(args, devStageId, connectResult);
  }
  return connectResult;
}
