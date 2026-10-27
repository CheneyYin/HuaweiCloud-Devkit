// The capability catalog: the pack-registry-facing tool handlers, split out
// of tools.ts. Owns the intent router (service_catalog), the pack inventory
// (list_packs / pack_info), session pack configuration (packs_configure),
// the skill→pack ownership inversion (SKILL_OWNER) the boot guard and the
// skill-serving handlers cross-check, and the shared pack-refusal helpers.
// tools.ts dispatches into this module from its core switch; the
// skill-disclosure family (retrieve_skill / list_skills / search_docs)
// imports SKILL_OWNER and the refusal helpers from here.
import { z } from 'zod';

import { TOOL_DEFINITIONS } from './tool-definitions.ts';
import type { CallToolOptions } from './tools.ts';
// PACKS feeds the pack inventory and the SKILL_OWNER inversion; enable.ts
// carries the live enablement set (DEVKIT_PACKS > all packs).
import { PACKS } from './packs/registry.ts';
import { resolveEnabledPacks } from './packs/enable.ts';
import { type PackId } from './lib/pack-types.ts';
import { getToolSchema, SCHEMA_DRIFT_IGNORED_KEYS } from './tool-schemas.ts';

export function serviceCatalog(intent: string = '') {
  const it = String(intent).toLowerCase();
  const routeMap = [
    {
      keywords: [
        'ecs',
        'server',
        'vm',
        'instance',
        'compute',
        'flavor',
        'image',
        '弹性云服务器',
        '云服务器',
        '服务器',
        '虚拟机',
        '镜像',
      ],
      skills: ['huawei-ecs'],
      services: ['ECS'],
    },
    {
      keywords: [
        'vpc',
        'subnet',
        'network',
        'security group',
        'eip',
        'nat',
        'vpn',
        'bandwidth',
        '虚拟私有云',
        '子网',
        '网络',
        '安全组',
        '弹性公网IP',
        'NAT网关',
        'VPN网关',
        '带宽',
      ],
      skills: ['huawei-vpc'],
      services: ['VPC', 'EIP'],
    },
    {
      keywords: [
        'obs',
        'bucket',
        'storage',
        'object',
        'static website',
        'static site',
        'hosting',
        '对象存储',
        '存储桶',
        '桶',
        '存储',
        '对象',
        '静态网站',
        '静态托管',
        'cors',
        'CORS',
        'browser direct upload',
        '直传',
        '预签名上传',
      ],
      skills: ['huawei-obs'],
      services: ['OBS'],
    },
    {
      keywords: [
        'functiongraph',
        'serverless',
        'function',
        'lambda',
        'trigger',
        'faas',
        '函数工作流',
        '函数',
        '触发器',
        '无服务器',
        '函数计算',
      ],
      skills: ['huawei-functiongraph'],
      services: ['FunctionGraph'],
    },
    {
      keywords: ['cce', 'kubernetes', 'k8s', 'container', 'cluster', 'node pool', 'swr', 'docker', 'image registry'],
      skills: ['huawei-cce'],
      services: ['CCE', 'SWR'],
    },
    {
      keywords: ['apig', 'api gateway', 'publish', 'throttle', 'API网关', '限流'],
      skills: ['huawei-cloud-apig-instance-management'],
      services: ['APIG'],
    },
    {
      keywords: ['rds', 'mysql', 'postgresql', 'database', 'db', '关系型数据库', '数据库'],
      skills: ['huawei-rds'],
      services: ['RDS'],
    },
    {
      keywords: ['gaussdb', 'distributed', 'sharding', 'opengauss', '高斯数据库', '分布式数据库'],
      skills: ['huawei-cloud-gaussdb-instance-management'],
      services: ['GaussDB'],
    },
    {
      keywords: [
        'iam',
        'permission',
        'policy',
        'role',
        'user',
        'ak/sk',
        'access key',
        'agency',
        '身份认证',
        '身份管理',
        '权限',
        '策略',
        '角色',
        '用户',
        '访问密钥',
        '委托',
        'primary account',
        'sub-account',
        'account type',
        '主账号',
        '子账号',
      ],
      skills: ['huawei-iam'],
      services: ['IAM'],
    },
    {
      keywords: [
        'dew',
        'secret',
        'kms',
        'encrypt',
        'decrypt',
        'certificate',
        'csms',
        '数据加密服务',
        '密钥管理',
        '密钥',
        '加密',
        '解密',
        '证书',
        '凭据管理',
      ],
      skills: ['huawei-cloud-dew-key-management'],
      services: ['CSMS', 'KMS'],
    },
    {
      keywords: ['modelarts', 'ai', 'model', 'training', 'inference', 'machine learning'],
      skills: ['huawei-modelarts'],
      services: ['ModelArts'],
    },
    {
      keywords: ['billing', 'cost', 'bill', 'budget', 'expense', 'bss', '计费', '费用', '账单', '预算', '开销'],
      skills: ['huawei-billing'],
      services: ['BSS'],
    },
    {
      keywords: ['waf', 'aad', 'ddos', 'firewall', 'web protection'],
      skills: ['huawei-cloud-waf-aad-rule-management'],
      services: ['WAF', 'AAD'],
    },
    {
      keywords: ['smn', 'dms', 'notification', 'message', 'kafka', 'rabbitmq', 'rocketmq'],
      skills: ['huawei-cloud-smn-dms-message'],
      services: ['SMN', 'DMS'],
    },
    {
      keywords: ['ces', 'monitor', 'alarm', 'metric', 'dashboard', 'cloud eye', '监控', '告警', '云监控'],
      skills: ['huawei-cloud-eye'],
      services: ['CES'],
    },
    {
      keywords: ['cts', 'audit', 'trace', 'tracker', '审计', '追踪'],
      skills: ['huawei-cloud-cts-trace-management'],
      services: ['CTS'],
    },
    {
      keywords: ['cbr', 'backup', 'restore', 'vault', 'snapshot', '备份', '恢复', '快照', '存储库'],
      skills: ['huawei-cbr'],
      services: ['CBR'],
    },
    {
      keywords: ['deployment', 'deploy', 'ci/cd', 'pipeline', 'release'],
      skills: ['huawei-cloud-deployment-task-management'],
      services: ['CloudDeploy'],
    },
    {
      keywords: [
        'sandbox',
        'devstation',
        'workspace',
        'terminal',
        'preview',
        'hwlink',
        'website',
        'web app',
        'webapp',
        'hosting',
        '网站',
        '网页',
        '静态',
      ],
      skills: ['huawei-sandbox'],
      services: ['Sandbox', 'DevStation'],
    },
    {
      keywords: [
        'dds',
        'dcs',
        'mongodb',
        'redis',
        'memcached',
        'cache',
        'document db',
        '文档数据库',
        '缓存',
        '内存数据库',
      ],
      skills: ['huawei-cloud-dds-dcs-instance-management'],
      services: ['DDS', 'DCS'],
    },
    {
      keywords: ['elb', 'load balancer', '负载均衡', '弹性负载均衡', '监听器', '证书'],
      skills: ['huawei-vpc'],
      services: ['ELB'],
    },
    {
      keywords: ['openapi', 'api catalog', 'api explorer', 'rest call', 'open api', '全量目录', '接口目录'],
      skills: ['huawei-openapi'],
      services: [],
    },
    {
      keywords: ['voucher', 'coupon', 'incentive', 'credit', '领券', '代金券', '优惠券', '激励金', '领取'],
      skills: ['huawei-voucher'],
      services: ['Incentive Voucher'],
    },
  ];
  const matched = [];
  const tokens = new Set(it.split(/[\s,./-]+/).filter((t) => t.length > 0));
  const cjk = /[\u4e00-\u9fff]/;
  for (const route of routeMap) {
    // Phrase path (space/CJK/slash-bearing keywords like 'ak/sk' and 'ci/cd'):
    // substring match — the tokenizer splits on '/', so those keywords can
    // never be single tokens. Token path: membership, both sides lowercased
    // so a mixed-case keyword ('ModelArts') stays matchable.
    if (
      route.keywords.some((kw) =>
        kw.includes(' ') || kw.includes('/') || cjk.test(kw)
          ? it.includes(kw.toLowerCase())
          : tokens.has(kw.toLowerCase()),
      )
    ) {
      matched.push(route);
    }
  }
  const recommendedSkills = [...new Set(matched.flatMap((r) => r.skills))];
  // Never recommend a skill whose owning pack is disabled — the router must
  // not send the agent to a loader that will refuse (same filter searchDocs
  // applies to its index).
  const enabled = resolveEnabledPacks();
  const gated = recommendedSkills.filter((skill) => {
    const owner = SKILL_OWNER.get(skill);
    return !owner || enabled.has(owner);
  });
  const recommendedServices = [...new Set(matched.flatMap((r) => r.services))].slice(0, 5);

  // Deployment intent (deploy/host/publish a web app or static website) must never
  // default to a storage/other service — recommend the sandbox first.
  const deploymentIntent = /deploy|host|hosting|publish|website|web app|preview|部署|托管|发布|网站|网页/.test(it);
  if (deploymentIntent && gated.includes('huawei-sandbox')) {
    const idx = gated.indexOf('huawei-sandbox');
    gated.splice(idx, 1);
    gated.unshift('huawei-sandbox');
  }

  return {
    intent,
    recommendedSkills: gated.length ? gated : ['Use huaweicloud-core to route intent.'],
    recommendedServices: recommendedServices.length
      ? recommendedServices
      : ['Run hcloud --help to list available services.'],
    capabilityOrder: [
      'Huawei Cloud Skills for task-specific workflows and examples',
      'KooCLI hcloud for local authenticated operations and quick inspection',
      'Huawei Cloud API documentation for exact request and response contracts',
      'Huawei Cloud SDKs for application code integration',
      'Huawei Cloud MCP when an official or approved server is available',
      'Terraform Provider only when IaC reviewability and repeatability are important',
    ],
    ruleOfThumb: {
      skills: 'Start here when the task (already a Huawei Cloud one) is scenario-shaped or needs a guided workflow.',
      cli: 'Use for local diagnostics, read-only inspection, and commands the user can review.',
      api: 'Use for exact service contract, region endpoint, project_id, pagination, and error codes.',
      sdk: 'Use when writing application code that calls Huawei Cloud services.',
      mcp: 'Prefer approved MCP tools when available because tools can carry structured schemas.',
      terraform: 'Keep low priority in V1; suggest it for reviewed infrastructure changes, not quick diagnosis.',
    },
  };
}

// ── Pack meta tools ──
// Both tools read the pack registry (PACK_OF inversion in packs/registry.ts),
// the tool definitions (name/description), the zod schemas, and the live
// enablement set (packs/enable.ts, DEVKIT_PACKS > all packs), so their output
// can never disagree with tools/list: a disabled pack is listed with
// enabled:false, and pack_info refuses to detail it.

// Skill directory → owning pack, inverted from the PACKS claims. The tree is
// server data, so an unclaimed directory is a retired skill name that
// survived a copy: copyServerPayload prunes those on update, and treating
// stragglers as unowned (outside pack gating) is defense in depth — the
// enablement filter in searchDocs/retrieveSkill never crashes on them.
export const SKILL_OWNER = new Map<string, PackId>(
  PACKS.flatMap((pack) => pack.skills.map((skill) => [skill, pack.id] as const)),
);

export function listPacks(opts: CallToolOptions = {}) {
  const enabled = resolveEnabledPacks();
  // packs_configure is core-owned but registered only on surfaces that carry
  // session state (stdio). The meta tools must not advertise a tool where
  // tools/list will never carry it, so core's tool list is filtered by the
  // same seam the registration factory uses.
  const runtimeToggling = Boolean(opts.onPacksChanged);
  return {
    ok: true,
    count: PACKS.length,
    packs: PACKS.map((pack) => ({
      id: pack.id,
      title: pack.title,
      description: pack.description,
      skills: pack.skills,
      tools:
        pack.id === 'core' && !runtimeToggling
          ? pack.tools.filter((name) => name !== 'huaweicloud_packs_configure')
          : pack.tools,
      enabled: enabled.has(pack.id),
    })),
  };
}

// Shared enablement remediation: pack_info, list_skills, and retrieve_skill
// serve the same instructions for the same condition, so a wording fix lands
// once. The stdio qualifier keeps the message honest on the stateless
// remote, which never registers the session-toggle tool.
export function packEnablementRemediation(packId: string): string {
  return (
    'Enable it for this session with huaweicloud_packs_configure (stdio agent sessions; confirm with the user when the operator trimmed the pack on purpose), or ask the operator to persist it with npx huaweicloud-devkit packs enable ' +
    packId +
    ' --target <agent>, then restart the agent (that command rewrites DEVKIT_PACKS in the agent MCP config).'
  );
}

// Shared refusal for an unknown pack id: names every valid id so the caller
// can retry without a second discovery call.
export function packNotFound(packId: string): { ok: false; error: string } {
  const available = PACKS.map((entry) => entry.id).join(', ');
  return { ok: false, error: 'Pack "' + packId + '" not found. Available: ' + available };
}

export function packNotEnabled(packId: string): { ok: false; error: string } {
  return { ok: false, error: 'Pack "' + packId + '" is not enabled. ' + packEnablementRemediation(packId) };
}

export function packInfo(pack: string, opts: CallToolOptions = {}) {
  const packId = String(pack || '').trim();
  if (!packId) return { ok: false, error: 'Pack id is required.' };
  const found = PACKS.find((entry) => entry.id === packId);
  if (!found) return packNotFound(packId);
  const enabled = resolveEnabledPacks();
  if (!enabled.has(found.id)) return packNotEnabled(found.id);
  // Same surface filter as listPacks: core owns packs_configure, but only
  // session-carrying surfaces register it, and pack_info must not advertise
  // a tool tools/list will never carry.
  const toolNames =
    found.id === 'core' && !opts.onPacksChanged
      ? found.tools.filter((name) => name !== 'huaweicloud_packs_configure')
      : found.tools;
  const tools = toolNames.map((name) => {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    const schema = z.toJSONSchema(getToolSchema(name)) as Record<string, unknown>;
    for (const key of SCHEMA_DRIFT_IGNORED_KEYS) delete schema[key];
    return { name, description: definition?.description ?? '', schema };
  });
  return {
    ok: true,
    pack: found.id,
    title: found.title,
    description: found.description,
    skills: found.skills,
    tools,
    enabled: true,
  };
}
