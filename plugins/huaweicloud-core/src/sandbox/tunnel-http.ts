// The raw-socket HTTP/1.1 client for the hwlink tunnel's local port,
// extracted from the former upload-transport module during the cx rebalance:
// uploadViaTunnel (POST /upload with hand-rolled response parsing) and
// waitForServerReady (GET /health polling). Both speak minimal HTTP/1.1 over
// netConnect to 127.0.0.1:<local tunnel port>; diagnostics come from
// upload-diagnostics.ts.

import { readFileSync } from 'node:fs';
import { createConnection as netConnect } from 'node:net';

import { asRecord } from '../lib/as-record.ts';
import { UPLOAD_LOG_PATH, errorMessage, uploadLog } from './upload-diagnostics.ts';

// The file server's POST /upload response body (bytes written + md5), as the
// socket client resolves it.
export interface UploadTunnelResponse {
  bytes?: number;
  md5?: string;
  [key: string]: unknown;
}

const SERVER_HEALTH_MAX_RETRIES = 30;
const SERVER_HEALTH_INTERVAL_MS = 1000;

export async function uploadViaTunnel(
  localPort: number,
  archivePath: string,
  archiveSize: number,
  archiveRemotePath: string,
  uploadToken: string,
  timeoutMs: number,
): Promise<UploadTunnelResponse> {
  const archiveBuffer = readFileSync(archivePath);
  const headers = [
    'POST /upload HTTP/1.1',
    'Host: localhost',
    'Content-Type: application/octet-stream',
    `Content-Length: ${archiveSize}`,
    `X-Target-Path: ${archiveRemotePath}`,
    `X-Upload-Token: ${uploadToken}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return new Promise<UploadTunnelResponse>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      }
    };
    const timer = setTimeout(() => done(() => reject(new Error(`upload timeout after ${timeoutMs}ms`))), timeoutMs);
    const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
      sock.write(headers);
      sock.write(archiveBuffer);
    });
    let respBuf = Buffer.alloc(0);
    let contentLength = -1;
    let headerEnd = -1;
    // One settlement path for both completions (full body per Content-Length,
    // or whatever arrived when the socket closed): status check, logging,
    // and JSON parsing live here so the two triggers cannot drift.
    const settleResponse = (resp: string, body: string): void => {
      const statusLine = resp.split('\r\n')[0] || '';
      const statusCode = parseInt(statusLine.split(' ')[1]!, 10);
      if (!statusCode || statusCode < 200 || statusCode >= 300) {
        uploadLog(`uploadViaTunnel: POST failed with HTTP ${statusCode}: ${body.slice(0, 200)}`);
        reject(new Error(`upload HTTP ${statusCode}: ${body}`));
        return;
      }
      try {
        resolve(asRecord(JSON.parse(body)));
      } catch {
        reject(new Error(`invalid JSON response: ${body.slice(0, 200)}`));
      }
    };
    sock.on('data', (chunk) => {
      respBuf = Buffer.concat([respBuf, chunk]);
      if (contentLength < 0) {
        const resp = respBuf.toString();
        headerEnd = resp.indexOf('\r\n\r\n');
        if (headerEnd > 0) {
          const headerBlock = resp.slice(0, headerEnd);
          const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
          if (clMatch) contentLength = parseInt(clMatch[1]!, 10);
        }
      }
      if (contentLength >= 0 && headerEnd > 0) {
        const bodyReceived = respBuf.length - (headerEnd + 4);
        if (bodyReceived >= contentLength) {
          done(() => {
            const resp = respBuf.toString();
            settleResponse(resp, resp.slice(headerEnd + 4, headerEnd + 4 + contentLength));
          });
        }
      }
    });
    sock.on('close', () => {
      done(() => {
        const resp = respBuf.toString();
        const he = resp.indexOf('\r\n\r\n');
        settleResponse(resp, he > 0 ? resp.slice(he + 4) : '');
      });
    });
    sock.on('error', (err) => {
      done(() => {
        uploadLog(`uploadViaTunnel: socket error: ${err.message}`);
        reject(err);
      });
    });
  });
}

export async function waitForServerReady(localPort: number): Promise<void> {
  for (let i = 0; i < SERVER_HEALTH_MAX_RETRIES; i++) {
    try {
      uploadLog(`waitForServerReady: attempt ${i + 1}, checking http://localhost:${localPort}/health`);
      const ok = await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (val: boolean): void => {
          if (!settled) {
            settled = true;
            sock.destroy();
            resolve(val);
          }
        };
        const sock = netConnect({ host: '127.0.0.1', port: localPort }, () => {
          sock.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
        });
        let resp = '';
        sock.on('data', (c) => {
          resp += c.toString();
          if (resp.includes('200 OK')) done(true);
        });
        sock.on('close', () => done(resp.includes('200 OK')));
        sock.on('error', () => done(false));
        setTimeout(() => done(false), 3000);
      });
      if (ok) {
        uploadLog(`waitForServerReady: server ready on port ${localPort} after ${i} retries`);
        return;
      }
      uploadLog(`waitForServerReady: health check returned non-200 (retry ${i + 1})`);
    } catch (error) {
      uploadLog(`waitForServerReady: health check failed: ${errorMessage(error)} (retry ${i + 1})`);
    }
    await new Promise((r) => setTimeout(r, SERVER_HEALTH_INTERVAL_MS));
  }
  throw new Error(
    `sandbox file server not ready after ${SERVER_HEALTH_MAX_RETRIES * SERVER_HEALTH_INTERVAL_MS}ms (log: ${UPLOAD_LOG_PATH})`,
  );
}
