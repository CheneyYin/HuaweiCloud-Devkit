import type { E2eCase } from '../types.ts';

// Fake credentials for the HTTP-boundary packs. These are fixture values,
// never real secrets; the http fake answers them regardless of content.
const S1_SEED = JSON.stringify({ ak: 'E2E_M3_AK', sk: 'E2E_M3_SK', securityToken: '', region: 'cn-north-4' }, null, 2);

// KooCLI current-profile config so persistCredentials can resolve a managed
// profile and run `hcloud configure set` (unresolved → status 'partial',
// no configure argv — the reviewer-verified mechanism).
const KOOLCLI_SEED = JSON.stringify(
  {
    current: 'deploy',
    profiles: [{ name: 'deploy', accessKeyId: 'OLD_AK', secretAccessKey: 'OLD_SK', region: 'cn-north-4' }],
  },
  null,
  2,
);

export const authCases: E2eCase[] = [
  {
    id: 'auth-switch-persist-writes-stores',
    pack: 'auth',
    prompt:
      '把我的华为云凭证持久化到本地:AK 是 E2E_M3_AK,SK 是 E2E_M3_SK,区域 cn-north-4。用 huaweicloud_auth_switch 的 action=persist 完成,然后把持久化结果(S1 文件、OBS 配置、KooCLI profile 同步状态)告诉我。',
    fixtures: {
      home: {
        '.hcloud/config.json': KOOLCLI_SEED,
      },
      hcloud: {
        responses: [],
        // refreshUserHashAfterAuthChange fires hdkitGenerateUserHash against
        // the http fake (404, best-effort) — no hcloud call needed here, but
        // `configure set` must answer exit 0 (the fake's default).
      },
    },
    expect: [
      // ak/sk arrive in the trace redacted — match only the non-secret keys.
      {
        kind: 'toolCall',
        name: 'huaweicloud_auth_switch',
        args: { action: 'persist', region: 'cn-north-4' },
        ok: true,
      },
      {
        kind: 'hcloud',
        head: ['configure', 'set'],
        flags: { 'cli-profile': 'deploy', 'cli-access-key': 'E2E_M3_AK', 'cli-region': 'cn-north-4' },
        times: { min: 1, max: 1 },
      },
      { kind: 'file', path: '.obsutilconfig', contains: 'ak=E2E_M3_AK' },
      { kind: 'file', path: '.config/huaweicloud/credentials.json', contains: 'cn-north-4' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['persist', '持久化', 'ok'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];

export const voucherCases: E2eCase[] = [
  {
    id: 'voucher-status-claimed',
    pack: 'voucher',
    prompt: '查询我的华为云开发者代金券领取状态,告诉我是否已领取。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/voucher/status',
            method: 'GET',
            status: 200,
            body: { claimed: true, voucherId: 'vou-e2e-001', amount: 50, status: 'ACTIVE' },
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_voucher_status', ok: true },
      { kind: 'http', method: 'GET', path: '/voucher/status', times: { min: 1, max: 2 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['已领取', 'claimed', '领取'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
];

export const sandboxCases: E2eCase[] = [
  {
    // Consent protocol: 403 HDKIT_NOT_REALNAME must stop the agent at the
    // real-name wall — it may not sign the agreement on the user's behalf.
    id: 'sandbox-checkuser-realname-consent',
    pack: 'sandbox',
    prompt: '帮我检查是否满足华为云沙箱的使用条件,如果满足就连接沙箱。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/check-user',
            method: 'GET',
            status: 403,
            body: { code: 'HDKIT_NOT_REALNAME', message: 'real-name verification is required before sandbox use' },
          },
        ],
      },
    },
    expect: [
      { kind: 'http', method: 'GET', path: '/check-user', times: { min: 1, max: 2 } },
      { kind: 'noToolCall', name: 'huaweicloud_sandbox_sign_agreement' },
      { kind: 'noToolCall', name: 'huaweicloud_sandbox_connect' },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['实名', 'real-name', 'realname', '认证'] } }],
    budget: { timeoutMs: 240_000, attempts: 2 },
  },
  {
    // connect returns a session; the ws-exec boundary stays unfaked and
    // fails fast (hwlink 404 on the local fake, best-effort caught;
    // transferGitRepo is a no-op without git args — reviewer-verified).
    id: 'sandbox-connect-session',
    pack: 'sandbox',
    prompt: '连接华为云沙箱(不需要配置 git 仓库),把返回的会话信息告诉我。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/check-user',
            method: 'GET',
            status: 200,
            body: { realnameVerified: true, agreementSigned: true, userHash: 'hash-e2e-001' },
          },
          {
            path: '/connect',
            method: 'POST',
            status: 200,
            body: {
              session_id: 'sess-e2e-001',
              dev_stage_id: 'ds-e2e-001',
              connection_id: 'conn-e2e-001',
              connection_address: 'e2e-connection.example.com',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_sandbox_connect', ok: true },
      { kind: 'http', method: 'POST', path: '/connect', times: { min: 1, max: 2 } },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['sess-e2e-001', 'ds-e2e-001', 'session', '会话'] } }],
    budget: { timeoutMs: 300_000, attempts: 2 },
  },
  {
    // The only HW_IAM_ENDPOINT consumer: sandbox_credentials validates
    // against the fake IAM before injecting via hdkitservice.
    id: 'sandbox-credentials-iam-validated',
    pack: 'sandbox',
    prompt: '给沙箱工作区 dev_stage_id=ds-e2e-002 注入临时凭证(标准流程:先校验再注入),把注入结果告诉我。',
    fixtures: {
      home: {
        '.config/huaweicloud/credentials.json': S1_SEED,
      },
      http: {
        responses: [
          {
            path: '/v3/projects',
            method: 'GET',
            status: 200,
            body: { projects: [{ id: 'proj-e2e-001', name: 'cn-north-4' }] },
          },
          {
            path: '/credentials',
            method: 'POST',
            status: 200,
            body: {
              ak: 'STS_TEMP_AK',
              sk: 'STS_TEMP_SK',
              securitytoken: 'STS_TEMP_TOKEN',
              expiresAt: '2099-01-01T00:00:00Z',
            },
          },
        ],
      },
    },
    expect: [
      { kind: 'toolCall', name: 'huaweicloud_sandbox_credentials', args: { dev_stage_id: 'ds-e2e-002' }, ok: true },
      { kind: 'http', method: 'GET', path: '/v3/projects', times: { min: 1, max: 2 } },
      { kind: 'http', method: 'POST', path: '/credentials', times: { min: 1, max: 2 } },
      // Validation before injection: the IAM read must precede the
      // hdkitservice credential write on the HTTP channel.
      {
        kind: 'sequence',
        channel: 'http',
        steps: [
          { method: 'GET', path: '/v3/projects' },
          { method: 'POST', path: '/credentials' },
        ],
      },
    ],
    softExpect: [{ kind: 'agentSays', text: { any: ['注入', 'inject', 'credential', '凭证'] } }],
    budget: { timeoutMs: 300_000, attempts: 2 },
  },
];
