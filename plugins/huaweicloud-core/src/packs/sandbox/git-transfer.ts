import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { execOneShot, uploadProjectWithSession } from '../../sandbox/session-manager.ts';
import type { ToolArgs } from '../../tools.ts';

// The sandbox pack's git repo transfer chain, extracted verbatim from
// tools.ts in the within-pack split for the jscpd complex-file bar. Handlers
// migrated verbatim from src/tools.ts; the chain
// (isGitAvailable/gitCloneToLocal/transferGitRepo) is sandbox-specific and
// moved with the connect handler (handlers-account.ts imports it here).

const execFilePromise = promisify(execFile);

async function isGitAvailable() {
  try {
    await execFilePromise('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function gitCloneToLocal(repoUrl: string, branch: string | undefined, targetBasename: string) {
  const tempRoot = join(tmpdir(), `hw-sandbox-git-${Date.now()}`);
  const cloneDir = join(tempRoot, targetBasename);
  mkdirSync(tempRoot, { recursive: true });
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('-b', branch);
  args.push(repoUrl, cloneDir);
  await execFilePromise('git', args, { timeout: 120000 });
  return { cloneDir, tempRoot };
}

export async function transferGitRepo(args: ToolArgs, devStageId: string, connectResult: Record<string, unknown>) {
  const git = args.git;
  if (!git?.repo_url || !git?.target_path) return;

  const { repo_url, repo_branch, target_path } = git;

  try {
    const existsCheck = await execOneShot(
      devStageId,
      `test -d "${target_path}/.git" && echo "EXISTS" || echo "NOT_EXISTS"`,
      'root',
      10000,
    );
    if (String(existsCheck.stdout || '').includes('EXISTS')) {
      connectResult._repoStatus = 'already_exists';
      return;
    }
  } catch {
    /* 检查失败继续 */
  }

  const hasGit = await isGitAvailable();
  if (hasGit) {
    let tempRoot = null;
    try {
      const targetName = basename(target_path);
      const { cloneDir, tempRoot: root } = await gitCloneToLocal(repo_url, repo_branch, targetName);
      tempRoot = root;
      await uploadProjectWithSession(devStageId, cloneDir, dirname(target_path), 'root', 300000, {
        extract: true,
        exclude: ['.git', 'node_modules'],
      });
      connectResult._repoStatus = 'uploaded_from_local';
      return;
    } catch {
      /* 本地方式失败，进入兜底 */
    } finally {
      if (tempRoot) {
        try {
          rmSync(tempRoot, { recursive: true, force: true });
        } catch {
          /* 清理失败忽略 */
        }
      }
    }
  }

  const branchFlag = repo_branch ? `-b ${repo_branch}` : '';
  await execOneShot(
    devStageId,
    `mkdir -p $(dirname "${target_path}") && git clone --depth 1 ${branchFlag} "${repo_url}" "${target_path}"`,
    'root',
    120000,
  );
  connectResult._repoStatus = 'cloned_in_sandbox';
}
