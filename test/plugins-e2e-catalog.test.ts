import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import { callTool, invokeMcpSequence, makeEnv, runCli } from './plugins-e2e-harness.ts';

test('huaweicloud_search_docs returns relevant skill results', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-search-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-search-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');

    // Search for ECS skills — should return results containing ECS-related content
    const responses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_search_docs', {
        query: 'ECS',
      }),
    );

    assert.ok(responses[0].result, 'initialize returned result');
    assert.ok(responses[1].result, 'tools/call returned result');
    assert.ok(!responses[1].error, `tools/call should not error: ${JSON.stringify(responses[1].error)}`);

    const content = responses[1].result.content;
    assert.ok(Array.isArray(content), 'content should be an array');
    assert.ok(content.length > 0, 'content array should not be empty');

    const text = content.map((c) => c.text || '').join('');
    assert.ok(text.length > 0, 'search results text should not be empty');

    // Verify response is valid JSON with results (relaxed: check structure, not specific skill text)
    const parsed = JSON.parse(text) as { query?: string; results?: unknown[]; length?: number };
    assert.ok(parsed, 'search response should be valid JSON');
    // Query echo: the response should reflect what was searched
    if (parsed.query !== undefined) {
      assert.match(String(parsed.query), /ECS/i, 'response should echo the query');
    }
    // Results count: should have at least one result
    const resultCount = parsed.results?.length ?? parsed.length ?? (Array.isArray(parsed) ? parsed.length : 0);
    assert.ok(resultCount > 0, `search for ECS should return > 0 results, got ${resultCount}`);

    // Search for OBS — verify different query also returns results
    const obsResponses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_search_docs', {
        query: 'OBS',
      }),
    );
    assert.ok(!obsResponses[1].error, `OBS search should not error: ${JSON.stringify(obsResponses[1].error)}`);
    const obsText = obsResponses[1].result.content.map((c) => c.text || '').join('');
    const obsParsed = JSON.parse(obsText) as { query?: string; results?: unknown[]; length?: number };
    const obsCount = obsParsed.results?.length ?? obsParsed.length ?? (Array.isArray(obsParsed) ? obsParsed.length : 0);
    assert.ok(obsCount > 0, `search for OBS should return > 0 results, got ${obsCount}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('huaweicloud_service_catalog returns capability recommendations', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-catalog-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-catalog-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');

    // Verify English intent: deploy a static website recommends sandbox first
    const enResponses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_service_catalog', {
        vendorConfirmed: 'test: vendor established by the harness',
        intent: 'deploy a static website',
      }),
    );
    assert.ok(!enResponses[1].error, `English intent should not error: ${JSON.stringify(enResponses[1].error)}`);
    const enText = enResponses[1].result.content.map((c) => c.text || '').join('');
    const enResult = JSON.parse(enText) as { recommendedSkills: string[] };
    assert.ok(enResult.recommendedSkills, 'result should have recommendedSkills');
    assert.ok(
      enResult.recommendedSkills.includes('huawei-sandbox'),
      'static website deployment should recommend sandbox',
    );
    assert.ok(
      enResult.recommendedSkills.includes('huawei-obs'),
      'static website deployment should include OBS as an option',
    );

    // Verify Chinese intent: 部署静态网站到华为云
    const zhResponses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_service_catalog', {
        vendorConfirmed: 'test: vendor established by the harness',
        intent: '部署静态网站到华为云',
      }),
    );
    assert.ok(!zhResponses[1].error, `Chinese intent should not error: ${JSON.stringify(zhResponses[1].error)}`);
    const zhText = zhResponses[1].result.content.map((c) => c.text || '').join('');
    const zhResult = JSON.parse(zhText) as { recommendedSkills: string[] };
    assert.ok(
      zhResult.recommendedSkills.includes('huawei-sandbox'),
      'Chinese static website intent should also recommend sandbox',
    );

    // Verify storage routing for pure storage intent (aligned with tools.test.mjs)
    const storageResponses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_service_catalog', {
        vendorConfirmed: 'test: vendor established by the harness',
        intent: 'store files in an obs bucket',
      }),
    );
    assert.ok(
      !storageResponses[1].error,
      `Storage intent should not error: ${JSON.stringify(storageResponses[1].error)}`,
    );
    const storageText = storageResponses[1].result.content.map((c) => c.text || '').join('');
    const storageResult = JSON.parse(storageText) as { recommendedSkills: string[] };
    assert.ok(storageResult.recommendedSkills.includes('huawei-obs'), 'storage intent should include OBS');
    assert.notEqual(
      storageResult.recommendedSkills[0],
      'huawei-sandbox',
      'storage intent should not recommend sandbox first',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MCP tools/call with unknown tool name returns error', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-error-'));
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-error-proj-'));
  try {
    const install = runCli(home, cwd, ['install', '--target', 'opencode']);
    assert.equal(install.status, 0, install.stderr);

    const mcpServerPath = join(home, '.config', 'opencode', 'huaweicloud-plugins', 'dist', 'mcp-server.js');
    const responses = await invokeMcpSequence(
      mcpServerPath,
      makeEnv(home, cwd),
      callTool('huaweicloud_nonexistent_tool', {}),
    );

    assert.ok(responses[0].result, 'initialize returned result');
    // Unknown tool returns an isError CallToolResult (SDK high-level server
    // semantics since the migration), not a JSON-RPC error envelope.
    assert.ok(responses[1].result, 'unknown tool name should return a tool result');
    assert.equal(responses[1].result.isError, true, 'unknown tool must set isError');
    assert.match(
      responses[1].result.content.map((c) => c.text || '').join(' '),
      /not found/i,
      'error message should mention the tool was not found',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
