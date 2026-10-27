// The proxy CLI family, extracted from setup-cli.ts: the `proxy` command
// dispatch and its init/show/clear subcommands over the config module
// (proxy/proxy-config.ts owns the file IO).

import {
  getProxySettings,
  proxyConfigPath,
  readProxyConfig,
  clearProxyConfig,
  writeProxyConfig,
  type ProxyConfigFile,
} from './proxy-config.ts';
import { readLineQuestion } from '../lib/cli-io.ts';
import { BANNER } from '../lib/banner.ts';

async function cmdProxyInit(): Promise<void> {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Proxy Configuration\n');
  console.log('Configure HTTP/HTTPS proxy for connections to Huawei Cloud services.');
  console.log('Proxy settings are saved to ~/.config/huaweicloud/proxy.json\n');

  const existing: ProxyConfigFile = readProxyConfig() || {};
  const interactive = process.stdin.isTTY && process.stdout.isTTY;

  if (!interactive) {
    console.error('\x1b[31mNon-interactive session. Set proxy via environment variables:\x1b[0m');
    console.error('  HTTPS_PROXY=http://proxy:port');
    console.error('  HTTP_PROXY=http://proxy:port');
    console.error('  NO_PROXY=localhost,127.0.0.1');
    console.error('\nOr run "npx huaweicloud-devkit proxy init" in a real terminal.');
    process.exitCode = 1;
    return;
  }

  const httpsProxy = await readLineQuestion(`HTTPS proxy [${existing.https_proxy || 'none'}]: `);
  const httpProxy = await readLineQuestion(`HTTP proxy [${existing.http_proxy || 'none'}]: `);
  const noProxy = await readLineQuestion(
    `NO_PROXY hosts [${existing.no_proxy || '127.0.0.1,localhost,.huawei.com'}]: `,
  );

  const config = {
    https_proxy: httpsProxy || existing.https_proxy || '',
    http_proxy: httpProxy || existing.http_proxy || '',
    no_proxy: noProxy || existing.no_proxy || '127.0.0.1,localhost,.huawei.com',
  };

  const path = writeProxyConfig(config);
  console.log(`\nProxy configuration saved to ${path}`);
  console.log('\nEffective settings:');
  console.log(`  HTTPS_PROXY: ${config.https_proxy || '(none)'}`);
  console.log(`  HTTP_PROXY:  ${config.http_proxy || '(none)'}`);
  console.log(`  NO_PROXY:    ${config.no_proxy || '(none)'}`);
  console.log('\nEnvironment variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) override file settings.');
}

async function cmdProxyShow(): Promise<void> {
  console.log(BANNER);
  console.log('HuaweiCloud DevKit Proxy Configuration\n');

  const config = readProxyConfig();
  const configPath = proxyConfigPath();

  console.log(`Config file: ${configPath}`);
  console.log(`File exists: ${config ? 'yes' : 'no'}\n`);

  if (config) {
    console.log('File settings:');
    console.log(`  https_proxy: ${config.https_proxy || '(empty)'}`);
    console.log(`  http_proxy:  ${config.http_proxy || '(empty)'}`);
    console.log(`  no_proxy:    ${config.no_proxy || '(empty)'}`);
  }

  console.log('\nEnvironment variables:');
  console.log(`  HTTPS_PROXY: ${process.env.HTTPS_PROXY || process.env.https_proxy || '(not set)'}`);
  console.log(`  HTTP_PROXY:  ${process.env.HTTP_PROXY || process.env.http_proxy || '(not set)'}`);
  console.log(`  NO_PROXY:    ${process.env.NO_PROXY || process.env.no_proxy || '(not set)'}`);

  const effective = getProxySettings();
  console.log('\nEffective (env > file):');
  if (effective) {
    console.log(`  https_proxy: ${effective.https_proxy || '(none)'}`);
    console.log(`  http_proxy:  ${effective.http_proxy || '(none)'}`);
    console.log(`  no_proxy:    ${effective.no_proxy || '(none)'}`);
  } else {
    console.log('  (no proxy configured)');
  }
}

async function cmdProxyClear(): Promise<void> {
  const removed = clearProxyConfig();
  if (removed) {
    console.log('Proxy configuration removed.');
  } else {
    console.log('No proxy configuration file found.');
  }
}

export async function cmdProxy(): Promise<void> {
  const sub = (process.argv[3] || 'show').toLowerCase();
  if (sub === 'init' || sub === 'setup') return cmdProxyInit();
  if (sub === 'clear' || sub === 'remove' || sub === 'reset') return cmdProxyClear();
  return cmdProxyShow();
}
