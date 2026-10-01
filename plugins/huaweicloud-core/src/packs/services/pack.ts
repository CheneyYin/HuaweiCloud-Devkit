import type { Pack } from '../../lib/pack-types.ts';

// The services pack manifest. registry.ts references this from PACKS; the
// skill list is the authoritative claim over the twenty service skills whose
// sources live in this pack's skills/ tree (generated into the runtime
// skills/ tree by scripts/sync-skills.mjs). The tool list is empty by design:
// this pack owns knowledge, not callable surface — the meta tools that
// disclose skills (huaweicloud_list_packs / huaweicloud_pack_info /
// huaweicloud_retrieve_skill) live in core so every enabled pack stays
// discoverable. A future tool claimed for this pack in PACK_OF must also be
// listed here by hand (packs cannot import the registry, so the list cannot
// self-derive); the packs-registry union test fails loudly if the two drift.
export const servicesPack: Pack = {
  id: 'services',
  title: 'Service Skills',
  description:
    'Task-shaped Huawei Cloud service knowledge: ECS, VPC, OBS, IAM, and sixteen more service skills with KooCLI workflows, verified operation names, and troubleshooting plays. Retrieve them with huaweicloud_retrieve_skill.',
  skills: [
    'huawei-apig',
    'huawei-billing',
    'huawei-cbr',
    'huawei-cce',
    'huawei-cloud-eye',
    'huawei-cts',
    'huawei-dds-dcs',
    'huawei-deployment',
    'huawei-dew',
    'huawei-ecs',
    'huawei-functiongraph',
    'huawei-gaussdb',
    'huawei-getting-started',
    'huawei-iac',
    'huawei-iam',
    'huawei-modelarts',
    'huawei-rds',
    'huawei-smn-dms',
    'huawei-vpc',
    'huawei-waf-aad',
  ],
  tools: [],
};
