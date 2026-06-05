import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { blobStore, ALLOWED_IMAGE_TYPES, MAX_UPLOAD_BYTES, imageExtFor, imageMimeFromMagic } from '../utils/blobStore.js';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'crypto';

const inputSchema = z.object({
  image_data: z.string().describe('Base64 encoded image data'),
  filename: z.string().optional().describe('Optional filename'),
  mime_type: z.string().optional().describe('MIME type (default: image/jpeg)'),
});

// blobId -> stored key, for cleanup after a successful request.
const pendingBlobs = new Map<string, string>();

export const uploadImageTool: Tool = {
  definition: {
    name: 'upload_image',
    description:
      'Upload a base64-encoded image for use in a service request. FOR PROGRAMMATIC USE ONLY. ' +
      'Do NOT use this in chat-based MCP clients that cannot send raw image data. ' +
      'Instead, use prepare_upload to generate a browser upload link for the user. ' +
      'Images are automatically deleted after 10 minutes.',
    inputSchema: {
      type: 'object',
      required: ['image_data'],
      properties: {
        image_data: { type: 'string', description: 'Base64 encoded image data (with or without data URL prefix)' },
        filename: { type: 'string', description: 'Optional filename (ignored; a safe name is derived from the MIME type)' },
        mime_type: { type: 'string', description: 'MIME type (default: image/jpeg)' },
      },
    },
  },
  handler: async (args: unknown) => {
    const data = inputSchema.parse(args);

    let base64Data = data.image_data;
    // Accept data URLs: data:image/jpeg;base64,/9j/4AAQ...
    const dataUrlMatch = base64Data.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) {
      base64Data = dataUrlMatch[1];
    }

    // Pre-decode guard (mirrors the upload route): reject before allocating.
    if (base64Data.length > Math.ceil(MAX_UPLOAD_BYTES * 1.4)) {
      throw new Error('Image too large (max 4.5MB)');
    }

    const imageBuffer = Buffer.from(base64Data, 'base64');
    if (imageBuffer.length === 0) {
      throw new Error('Empty image data.');
    }
    if (imageBuffer.length > MAX_UPLOAD_BYTES) {
      throw new Error(`Image too large: ${(imageBuffer.length / 1024 / 1024).toFixed(2)}MB (max 4.5MB)`);
    }

    // Trust the actual bytes, not the client-claimed mime_type.
    const realMime = imageMimeFromMagic(imageBuffer);
    const ext = realMime ? imageExtFor(realMime) : null;
    if (!ext) {
      throw new Error(`File is not a supported image (${[...ALLOWED_IMAGE_TYPES].join(', ')}).`);
    }

    // Safe, derived key (never trust a client-supplied filename in a path).
    const token = randomBytes(16).toString('hex');
    const key = `temp/${token}.${ext}`;

    logger.info('Storing uploaded image', { key, size: imageBuffer.length, mime: realMime });
    const stored = await blobStore.put(key, imageBuffer);

    const blobId = randomBytes(8).toString('hex');
    pendingBlobs.set(blobId, key);

    setTimeout(async () => {
      try {
        if (pendingBlobs.has(blobId)) {
          await blobStore.del(key);
          pendingBlobs.delete(blobId);
          logger.info('Auto-cleaned expired image', { key });
        }
      } catch (error) {
        logger.error('Failed to auto-clean image', error);
      }
    }, 10 * 60 * 1000);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              media_url: stored.url,
              blob_id: blobId,
              size_bytes: imageBuffer.length,
              expires_in: '10 minutes',
              message:
                'Image stored. Use this media_url in create_request. It is automatically deleted after 10 minutes.',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};

/** Delete a stored image after a successful create_request. */
export async function cleanupBlob(blobId: string): Promise<boolean> {
  const key = pendingBlobs.get(blobId);
  if (key) {
    try {
      await blobStore.del(key);
      pendingBlobs.delete(blobId);
      logger.info('Cleaned up image after successful request', { blobId });
      return true;
    } catch (error) {
      logger.error('Failed to cleanup image', error);
      return false;
    }
  }
  return false;
}
