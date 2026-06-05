// Local-filesystem storage for the photo-upload flow (the bridge is self-hosted
// on cp1). Files are written under UPLOAD_DIR and served publicly via the
// Express static route at `${PUBLIC_URL}/uploads/...`.
//
// The photo storage is SHORT-LIVED by design: at create_request time the
// GeoReport backend downloads media_url into its own storage (verified:
// GeoreportProcessorService::handleMediaUrls does httpClient->get + saveData),
// so the bridge only needs to host the file until then (10 min TTL, no backup).

import { promises as fs } from 'fs';
import path from 'path';

export interface StoredBlob {
  /** Logical key relative to UPLOAD_DIR, e.g. "<token>/photo.jpg". */
  key: string;
  /** Public URL: `${PUBLIC_URL}/uploads/<key>`. */
  url: string;
  /** Size in bytes. */
  size: number;
}

export interface BlobStore {
  put(key: string, data: Buffer | string): Promise<StoredBlob>;
  list(prefix: string): Promise<StoredBlob[]>;
  readText(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

// Upload security policy (shared by the upload route and upload_image tool).
export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_UPLOAD_BYTES = Math.floor(4.5 * 1024 * 1024);

/** Safe file extension for an allowed image MIME type, or null if not allowed. */
export function imageExtFor(mime: string): string | null {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return null;
  }
}

/**
 * Detect the real image type from the file's magic bytes. Returns an allowed
 * MIME type or null. We derive the stored extension from THIS, not from the
 * client-supplied mime_type, so a non-image (HTML/SVG/polyglot) payload labelled
 * "image/png" is rejected instead of written to disk.
 */
export function imageMimeFromMagic(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || '/data/uploads');
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3100').replace(/\/+$/, '');

/** Map a logical key to an absolute path under UPLOAD_DIR, blocking traversal. */
function keyToFsPath(key: string): string {
  const resolved = path.resolve(UPLOAD_DIR, key);
  if (resolved !== UPLOAD_DIR && !resolved.startsWith(UPLOAD_DIR + path.sep)) {
    throw new Error('Invalid upload path');
  }
  return resolved;
}

function keyToUrl(key: string): string {
  return `${PUBLIC_URL}/uploads/${key.replace(/^\/+/, '')}`;
}

async function collectFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let items: import('fs').Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...(await collectFiles(p)));
    else out.push(p);
  }
  return out;
}

export const fsBlobStore: BlobStore = {
  async put(key, data) {
    const fsPath = keyToFsPath(key);
    await fs.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.writeFile(fsPath, data);
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
    return { key, url: keyToUrl(key), size };
  },

  async list(prefix) {
    const base = keyToFsPath(prefix);
    const files = await collectFiles(base);
    const out: StoredBlob[] = [];
    for (const abs of files) {
      const rel = path.relative(UPLOAD_DIR, abs).split(path.sep).join('/');
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        /* ignore */
      }
      out.push({ key: rel, url: keyToUrl(rel), size });
    }
    return out;
  },

  async readText(key) {
    try {
      return await fs.readFile(keyToFsPath(key), 'utf8');
    } catch {
      return null;
    }
  },

  async del(key) {
    await fs.rm(keyToFsPath(key), { recursive: true, force: true });
  },
};

export const blobStore: BlobStore = fsBlobStore;

/** Absolute upload directory, for the Express static route. */
export const uploadDir = UPLOAD_DIR;
