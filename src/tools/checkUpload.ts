import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { blobStore } from '../utils/blobStore.js';
import { logger } from '../utils/logger.js';

const EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

const inputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/, 'invalid token'),
});

export const checkUploadTool: Tool = {
  definition: {
    name: 'check_upload',
    description:
      'Check whether the user has uploaded an image for the given token. ' +
      'Returns the media_url when ready, or "pending" if still waiting.',
    inputSchema: {
      type: 'object',
      required: ['token'],
      properties: {
        token: {
          type: 'string',
          description: 'The upload token from prepare_upload',
        },
      },
    },
  },
  handler: async (args: unknown) => {
    const { token } = inputSchema.parse(args);

    logger.info('Checking upload status', { token });

    const blobs = await blobStore.list(`${token}/`);

    // Token not found at all (never created or already cleaned up).
    if (blobs.length === 0) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ status: 'invalid', message: 'Token not found or expired.' }) },
        ],
      };
    }

    // Expiry check via the meta marker.
    const metaText = await blobStore.readText(`${token}/meta.json`);
    if (metaText) {
      try {
        const meta = JSON.parse(metaText) as { created: number };
        if (Date.now() - meta.created > EXPIRY_MS) {
          return {
            content: [
              { type: 'text', text: JSON.stringify({ status: 'expired', message: 'Upload token has expired.' }) },
            ],
          };
        }
      } catch {
        // meta unreadable, continue anyway
      }
    }

    // The uploaded image is any object that is not the meta marker.
    const imageBlob = blobs.find((b) => !b.key.endsWith('meta.json'));

    if (!imageBlob) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'pending',
              message: 'User has not uploaded an image yet. Try again in a few seconds.',
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              status: 'ready',
              media_url: imageBlob.url,
              size_bytes: imageBlob.size,
              message: 'Image uploaded. Use this media_url in create_request.',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
