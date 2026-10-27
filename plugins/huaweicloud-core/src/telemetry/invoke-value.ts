// The telemetry invoke-value derivation (what trackToolInvoke records as
// the auditable fact for a tool call: the hcloud service/operation pair,
// the skill or pack a disclosure call names, the packs_configure delta, or
// the vault ref), split out of tools.ts. The telemetry family owns the
// naming policy; callTool computes the value and passes it to
// trackToolInvoke.
import type { ToolName } from '../tool-definitions.ts';
import type { ToolArgs } from '../tools.ts';

export function toolInvokeValue(name: ToolName, args: ToolArgs): string {
  if (name === 'huaweicloud_run_readonly_command' || name === 'huaweicloud_run_approved_command') {
    const cmdArgs = args.args || [];
    const filtered = cmdArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-') && !a.includes('='));
    if (filtered.length >= 2) return `hcloud ${filtered.slice(0, 2).join(' ')}`;
  }
  if (name === 'huaweicloud_list_operations' && args.service) {
    return args.service;
  }
  if (name === 'huaweicloud_list_skills' && args.pack) {
    return args.pack;
  }
  if (name === 'huaweicloud_retrieve_skill' && args.name) {
    return args.name;
  }
  if (name === 'huaweicloud_packs_configure') {
    // The delta is the telemetry value: which packs crossed the operator
    // posture line in this session is the auditable fact.
    const parts: string[] = [];
    const enabled = (args.enable ?? []).map((id) => String(id));
    const disabled = (args.disable ?? []).map((id) => String(id));
    if (enabled.length > 0) parts.push('+' + enabled.join(','));
    if (disabled.length > 0) parts.push('-' + disabled.join(','));
    if (args.reset === true) parts.push('reset');
    if (parts.length > 0) return parts.join(' ');
  }
  if (name === 'huaweicloud_hook_check_command' && args.command) {
    const parts = args.command.split(/\s+/).filter((p) => !p.startsWith('--'));
    if (parts[0] === 'hcloud' && parts[1]) return `hcloud ${parts.slice(1, 3).join(' ')}`;
    return parts.slice(0, 2).join(' ');
  }
  // The auditable fact for vault mutations is the ref (and scope), never the
  // value or any channel payload.
  if (name === 'huaweicloud_secret_set' && args.ref) return args.ref;
  if (name === 'huaweicloud_secret_list' && args.scope) return args.scope;
  if (name === 'huaweicloud_secret_delete' && args.ref) return args.ref;
  return '1';
}
