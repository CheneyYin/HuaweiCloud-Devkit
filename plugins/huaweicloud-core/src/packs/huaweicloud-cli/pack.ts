import type { Pack } from '../../lib/pack-types.ts';
import { HUAWEICLOUD_CLI_TOOLS } from './tools.ts';

// The huaweicloud-cli pack manifest: a mixed knowledge+tools pack. The skill
// list is the authoritative claim over the twenty service skills whose
// sources live in this pack's skills/ tree (generated into the runtime
// skills/ tree by scripts/sync-skills.mjs); the seven KooCLI execution tools
// (src/packs/huaweicloud-cli/tools.ts) include the approval chain
// (huaweicloud_run_approved_command), so trimming this pack removes the CLI
// execution face and its approval tools together — fail-closed. The tool
// list derives from the pack's own definitions (the obs self-derivation
// pattern), and PACK_OF stays the tool-ownership source of truth
// (structure.test.ts asserts the lockstep).
export const huaweicloudCliPack: Pack = {
  id: 'huaweicloud-cli',
  title: 'CLI Service Skills',
  description:
    'Task-shaped Huawei Cloud CLI knowledge: ECS, VPC, OBS, IAM, and sixteen more service skills with per-service KooCLI workflows, verified operation names, and troubleshooting plays. Complements the huaweicloud-cli-and-auth meta-skill, which covers KooCLI installation and credentials; this pack carries what to run per service. Load a skill with the attempt-first direct read under skillRoot when known, or with huaweicloud_retrieve_skill.',
  skills: [
    'huawei-cloud-apig-instance-management',
    'huawei-billing',
    'huawei-cbr',
    'huawei-cce',
    'huawei-cloud-eye',
    'huawei-cloud-cts-trace-management',
    'huawei-cloud-dds-dcs-instance-management',
    'huawei-cloud-deployment-task-management',
    'huawei-cloud-dew-key-management',
    'huawei-ecs',
    'huawei-functiongraph',
    'huawei-cloud-gaussdb-instance-management',
    'huawei-getting-started',
    'huawei-iac',
    'huawei-iam',
    'huawei-modelarts',
    'huawei-rds',
    'huawei-cloud-smn-dms-message',
    'huawei-vpc',
    'huawei-cloud-waf-aad-rule-management',
  ],
  tools: HUAWEICLOUD_CLI_TOOLS.map((tool) => tool.name),
};
