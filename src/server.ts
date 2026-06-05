// Self-hosted entrypoint (cp1 / any Node host) and the single production path.
// Serves the stateless JSON-RPC MCP endpoint via the shared handleMcp(), plus
// the photo-upload page + local-filesystem storage, so the auth model and tool
// behavior are identical across transports. The legacy SSE server in index.ts
// is dev-only.

import express from 'express';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';
import { resolveUser } from './utils/userContext.js';
import { handleMcp, extractBearerToken } from './mcpApp.js';
import { renderUploadPage } from './uploadPage.js';
import { blobStore, uploadDir, MAX_UPLOAD_BYTES, imageExtFor, imageMimeFromMagic } from './utils/blobStore.js';

dotenv.config();

const PORT = Number(process.env.MCP_SERVER_PORT || 3100);
const UPLOAD_EXPIRY_MS = 10 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{32}$/;

const app = express();
// No global CORS: only /api/mcp needs cross-origin access and sets its own
// headers inline (below). /uploads and /health stay same-origin-only so a
// third-party page cannot fetch uploaded citizen photos cross-origin.

// Health check (used by the Docker healthcheck and uptime monitoring).
app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'mcp-bridge-georeport',
    version: '0.2.0',
    timestamp: new Date().toISOString(),
  });
});

// Serve uploaded photos. The GeoReport backend fetches media_url from here at
// create_request time; afterwards the file is dispensable (10 min TTL).
// nosniff + attachment prevent a browser from inline-rendering/sniffing an
// uploaded file (defense-in-depth against content-confusion; the backend fetch
// reads the bytes regardless of Content-Disposition).
app.use(
  '/uploads',
  (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    next();
  },
  express.static(uploadDir, { index: false, maxAge: '10m' }),
);

// Stateless MCP endpoint. Same contract as api/mcp.ts: JSON-RPC over POST.
app.all('/api/mcp', express.json({ limit: '256kb' }), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const userContext = resolveUser(extractBearerToken(req.headers.authorization));

  try {
    const body = req.body;
    const response = await handleMcp(body.method, body.params, body.id, userContext);
    if (response === null) {
      return res.status(202).end();
    }
    return res.json(response);
  } catch (error) {
    logger.error('Error processing MCP request', error);
    return res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
    });
  }
});

/** Validate a token + its (non-expired) meta marker. Returns 'ok' or an error reason. */
async function checkToken(token: string): Promise<'ok' | 'invalid' | 'expired' | 'taken'> {
  if (!TOKEN_RE.test(token)) return 'invalid';
  const metaText = await blobStore.readText(`${token}/meta.json`);
  if (!metaText) return 'invalid';
  try {
    const meta = JSON.parse(metaText) as { created: number };
    if (Date.now() - meta.created > UPLOAD_EXPIRY_MS) return 'expired';
  } catch {
    /* unreadable meta, treat as still valid */
  }
  const blobs = await blobStore.list(`${token}/`);
  if (blobs.some((b) => !b.key.endsWith('meta.json'))) return 'taken';
  return 'ok';
}

// Photo-upload page.
app.get('/api/upload/:token', async (req, res) => {
  const { token } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const state = await checkToken(token);
  if (state === 'invalid') return res.status(404).send(renderUploadPage(token, 'This upload link is invalid or has expired.'));
  if (state === 'expired') return res.status(410).send(renderUploadPage(token, 'This upload link has expired. Please request a new one.'));
  if (state === 'taken') return res.status(200).send(renderUploadPage(token, 'A photo has already been uploaded for this link.'));
  return res.status(200).send(renderUploadPage(token));
});

// Photo-upload handler. Larger body limit for the base64 image.
app.post(
  '/api/upload/:token',
  // Reject malformed tokens BEFORE the 8 MB body parser allocates anything.
  (req, res, next) => {
    if (!TOKEN_RE.test(req.params.token)) {
      res.status(404).json({ error: 'Upload link invalid or expired' });
      return;
    }
    next();
  },
  express.json({ limit: '8mb' }),
  async (req, res) => {
    const { token } = req.params;
    res.setHeader('Content-Type', 'application/json');

    const state = await checkToken(token);
    if (state === 'invalid') return res.status(404).json({ error: 'Upload link invalid or expired' });
    if (state === 'expired') return res.status(410).json({ error: 'Upload link expired' });
    if (state === 'taken') return res.status(409).json({ error: 'A photo has already been uploaded for this link' });

    try {
      const { image_data } = req.body || {};
      if (!image_data || typeof image_data !== 'string') {
        return res.status(400).json({ error: 'Missing image_data' });
      }
      // Pre-decode guard: base64 inflates by ~33%, reject before allocating.
      if (image_data.length > Math.ceil(MAX_UPLOAD_BYTES * 1.4)) {
        return res.status(413).json({ error: 'Image too large (max 4.5 MB)' });
      }

      const buffer = Buffer.from(image_data, 'base64');
      if (buffer.length === 0) {
        return res.status(400).json({ error: 'Empty image' });
      }
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: 'Image too large (max 4.5 MB)' });
      }

      // Derive the type from the actual bytes, not the client-claimed mime_type,
      // so a non-image payload labelled "image/png" is rejected here.
      const realMime = imageMimeFromMagic(buffer);
      const ext = realMime ? imageExtFor(realMime) : null;
      if (!ext) {
        return res.status(415).json({ error: 'File is not a supported image (jpeg, png, webp, gif)' });
      }

      const stored = await blobStore.put(`${token}/photo.${ext}`, buffer);
      return res.status(200).json({ success: true, url: stored.url });
    } catch (error) {
      logger.error('Upload error', error);
      return res.status(500).json({ error: 'Upload failed' });
    }
  },
);

app.listen(PORT, () => {
  logger.info(`MCP bridge (stateless) listening on port ${PORT}`);
  logger.info(`MCP endpoint:  POST http://localhost:${PORT}/api/mcp`);
  logger.info(`Upload page:   GET  http://localhost:${PORT}/api/upload/:token`);
  logger.info(`Health:        GET  http://localhost:${PORT}/health`);
});
