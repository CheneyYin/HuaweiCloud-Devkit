// The #935 A1 deploy_nginx write-verification family, extracted from the
// former deploy-nginx module during the cx rebalance: the config-name basename
// sanitation, the DB_NGINX_* marker parser, and the deploy verdict — pure
// functions so the verdict is unit-testable. deploy-nginx.ts folds them into
// its deploy script; session-manager.ts re-exports them as the public face.

// A1 (#935): normalize configName to a bare filename — a path-shaped value
// (e.g. a local path echoed back by a caller) must never splice into a broken
// target like `/etc/nginx/conf.d//root/hc-activity.conf` (nginx never serves
// it, the tunnel answers 502). Only the basename is kept and the `.conf`
// suffix stripped before the path is rebuilt; a pure filename (no separators)
// keeps the previous behavior unchanged.
export function resolveNginxConfigPath(configName: string | undefined, project: string): string {
  const raw = String(configName || project || '');
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const name = base.replace(/\.conf$/i, '') || 'default';
  return `/etc/nginx/conf.d/${name}.conf`;
}

export interface ParsedDeployNginxVerify {
  configMissing: boolean;
  nginxTest: string;
  nginxTestOutput: string;
}

// A1 (#935): parse the write-verification block appended to the deploy_nginx
// script. The old flow returned ok:true whenever the deploy script exited 0,
// even when the tee write silently failed — the config file never existed and
// the tunnel answered 502. The verification block emits explicit markers:
//   DB_NGINX_CONFIG_MISSING=1  — the target config file does not exist
//   DB_NGINX_T=PASS|FAIL       — nginx -t verdict, with failure output echoed
//                                as `DB_NGINX_T_OUTPUT: ...` lines
export function parseDeployNginxVerifyOutput(stdout: string | undefined): ParsedDeployNginxVerify {
  const text = String(stdout || '');
  const configMissing = /DB_NGINX_CONFIG_MISSING=1/.test(text);
  const nginxTest = text.match(/^DB_NGINX_T=(\w+)$/m)?.[1] ?? '';
  const nginxTestOutput = (text.match(/^DB_NGINX_T_OUTPUT: .*$/gm) ?? [])
    .map((line) => line.replace(/^DB_NGINX_T_OUTPUT: /, ''))
    .join('\n');
  return { configMissing, nginxTest, nginxTestOutput };
}

export interface DeployNginxVerdict {
  ok: boolean;
  error?: string;
}

// A1 (#935): the deploy verdict. A deploy script exit of 0 alone is NOT proof
// of success — the tee write can fail silently (broken pipe) and nginx -t can
// reject the config. Returns ok:false with an explicit, actionable error for
// any verification failure; a pure function so the verdict is unit-testable.
export function evaluateDeployNginxVerify(
  result: { exitCode: number },
  verify: ParsedDeployNginxVerify,
  configPath: string,
): DeployNginxVerdict {
  const writeVerified = result.exitCode === 0 && !verify.configMissing && verify.nginxTest === 'PASS';
  if (writeVerified) return { ok: true };
  const problems: string[] = [];
  if (result.exitCode !== 0) problems.push(`deploy script exited with code ${result.exitCode}`);
  if (verify.configMissing) problems.push(`nginx config file ${configPath} was not created (tee write failed)`);
  if (verify.nginxTest !== 'PASS')
    problems.push(`nginx -t did not pass${verify.nginxTestOutput ? ` — ${verify.nginxTestOutput}` : ''}`);
  return {
    ok: false,
    error: `sandbox deploy nginx: configuration write verification failed — ${problems.join('; ')}.`,
  };
}
