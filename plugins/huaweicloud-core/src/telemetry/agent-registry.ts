// Agent registry for the telemetry family: the AGENTS table (path/env/
// client-name matchers per harness), installSegment (the install-path
// segment for unknown-harness attribution), and matchAgent. The per-agent
// version DETECTORS live in agent-versions.ts; this module re-exports
// detectVersion so the family's consumers keep one import path
// (agent-detect.ts imports AGENTS, matchAgent, detectVersion, and
// installSegment from here — the public surface is unchanged).
import { asText } from '../lib/as-text.ts';

export { detectVersion } from './agent-versions.ts';

const selfPath = (() => {
  try {
    return new URL(import.meta.url).pathname.toLowerCase();
  } catch {
    return '';
  }
})();

export function installSegment(): string | null {
  const parts = selfPath.split('/').filter(Boolean);
  // Installs before 2.0.0 ran from a src/ directory; current installs run from
  // dist/. Take whichever segment is rightmost so both layouts resolve.
  const layoutIdx = Math.max(parts.lastIndexOf('src'), parts.lastIndexOf('dist'));
  if (layoutIdx < 1) return null;
  const parentIdx = layoutIdx - 1;
  const firstHidden = parts.findIndex((p, i) => i < parentIdx && p.startsWith('.'));
  if (firstHidden >= 0) return parts.slice(firstHidden, parentIdx).join('/') || null;
  return parts[parentIdx - 1] || null;
}

export interface AgentVersionConfig {
  type: string;
}

export interface AgentDefinition {
  id: string;
  pathPatterns: string[] | null;
  envVars: string[] | null;
  clientNames?: string[];
  version: AgentVersionConfig | null;
}

export const AGENTS: AgentDefinition[] = [
  {
    id: 'codearts',
    pathPatterns: ['/.codeartsdoer/'],
    envVars: ['CODE_ARTS_HARNESS', 'CODEARTS_PROJECT_DIR'],
    version: { type: 'codearts' },
  },
  {
    id: 'opencode',
    // The payload path marker, not ~/.config/opencode: opencode resolves its
    // config root from XDG_CONFIG_HOME, and the installer follows
    // (xdgConfigHome), so under a non-default root the server path has no
    // /.config/ segment — but every layout keeps the opencode plugin dir.
    pathPatterns: ['/opencode/huaweicloud-plugins/'],
    envVars: ['OPENCODE_SESSION_ID', 'OPENCODE_CONFIG_PATH'],
    version: null,
  },
  {
    id: 'codex-desktop',
    pathPatterns: ['/.codex/'],
    envVars: ['CODEX_DESKTOP', 'CODEX_ELECTRON'],
    version: null,
  },
  {
    id: 'codex',
    pathPatterns: null,
    envVars: ['CODEX_SESSION_ID', 'CODEX_CLI_VERSION', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'],
    clientNames: ['codex-mcp-client'],
    version: null,
  },
  {
    id: 'codearts-work',
    pathPatterns: ['/.codeartswork/'],
    envVars: null,
    version: null,
  },
  {
    id: 'workbuddy',
    pathPatterns: ['/.workbuddy/'],
    envVars: ['WORK_BUDDY_SESSION_ID', 'WORKBUDDY_SESSION'],
    version: { type: 'workbuddy' },
  },
  {
    id: 'dsh',
    pathPatterns: ['/.dsh/'],
    envVars: ['DSH_SESSION_ID', 'DSH_HOME'],
    version: { type: 'dsh' },
  },
  {
    id: 'officeace',
    pathPatterns: ['/.office-claw/', '/.officeace/'],
    envVars: ['OFFICEACE_SESSION_ID', 'OFFICE_CLAW_CONFIG_ROOT'],
    clientNames: ['office-claw-mcp-connector-probe', 'officeace-agent'],
    version: { type: 'officeace' },
  },
  {
    id: 'atomcode',
    pathPatterns: ['/.atomcode/'],
    envVars: ['ATOM_CODE_SESSION_ID', 'ATOMCODE_HOME'],
    version: null,
  },
  {
    id: 'hermes',
    pathPatterns: ['/.hermes/', '/hermes/'],
    envVars: ['HERMES_SESSION_ID', 'HERMES_HOME'],
    version: { type: 'hermes' },
  },
  {
    id: 'openclaw',
    pathPatterns: ['/.openclaw/', '/.agents/huaweicloud-plugins/'],
    envVars: ['OPENCLAW_SESSION_ID', 'OPENCLAW_CONFIG_ROOT'],
    clientNames: ['openclaw-bundle-mcp'],
    version: null,
  },
  {
    id: 'cursor',
    pathPatterns: ['/.cursor/', '/cursor/'],
    envVars: ['CURSOR_SESSION_ID', 'CURSOR_GIT_WORKDIR'],
    clientNames: ['cursor-vscode'],
    version: null,
  },
  {
    id: 'claude-code',
    pathPatterns: ['/.claude/'],
    envVars: ['CLAUDE_CODE_SESSION_ID'],
    version: null,
  },
  {
    id: 'cline',
    pathPatterns: ['/.vscode/extensions/saoudrizwan.claude-dev'],
    envVars: ['CLINE_ACTIVE'],
    version: null,
  },
  {
    id: 'github-copilot',
    pathPatterns: null,
    envVars: ['COPILOT_MODEL', 'COPILOT_ALLOW_ALL'],
    version: null,
  },
  {
    id: 'windsurf',
    pathPatterns: ['/.windsurf/', '/windsurf/'],
    envVars: ['WINDSURF_SESSION_ID'],
    version: null,
  },
  {
    id: 'kimi',
    pathPatterns: ['/.kimi/'],
    envVars: ['KIMI_PLUGIN_ROOT'],
    version: null,
  },
  {
    id: 'gemini-cli',
    pathPatterns: ['/.gemini/'],
    envVars: ['GEMINI_CLI'],
    version: null,
  },
  {
    id: 'augment-cli',
    pathPatterns: null,
    envVars: ['AUGMENT_AGENT'],
    version: null,
  },
  {
    id: 'aider',
    pathPatterns: ['/.aider/'],
    envVars: ['AIDER_SESSION'],
    version: null,
  },
  {
    id: 'tongyi-lingma',
    pathPatterns: ['/.lingma/'],
    envVars: ['LINGMA_SESSION_ID', 'LINGMA_PLUGIN_ROOT'],
    version: null,
  },
  {
    id: 'amazon-q',
    pathPatterns: ['/.amazonq/'],
    envVars: ['AMAZON_Q_SESSION_ID', 'AMAZON_Q_ENDPOINT'],
    version: null,
  },
  {
    id: 'continue',
    pathPatterns: ['/.continue/'],
    envVars: ['CONTINUE_SESSION_ID'],
    version: null,
  },
];

export interface AgentMatchClientInfo {
  name?: unknown;
}

export function matchAgent(agent: AgentDefinition, clientInfo: AgentMatchClientInfo = {}): boolean {
  if (agent.pathPatterns && agent.pathPatterns.some((p) => selfPath.includes(p))) return true;
  if (agent.envVars && agent.envVars.some((v) => process.env[v])) return true;
  const name = clientInfo.name;
  if (!name) return false;
  const lower = asText(name).toLowerCase();
  if (agent.id.toLowerCase() === lower) return true;
  if (agent.clientNames && agent.clientNames.some((n) => n.toLowerCase() === lower)) return true;
  return false;
}

export function findAgentById(id: string): AgentDefinition | null {
  return AGENTS.find((a) => a.id === id) || null;
}
