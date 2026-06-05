import { Tool } from '../types/tool.js';
import { blobStore } from '../utils/blobStore.js';
import { logger } from '../utils/logger.js';
import { randomBytes } from 'crypto';

const EXPIRY_MS = 10 * 60 * 1000;

export const prepareUploadTool: Tool = {
  definition: {
    name: 'prepare_upload',
    description:
      'Generate a browser upload link for attaching a photo to a report. ' +
      'Use this when a user has shared a photo in the chat or mentions wanting to attach one. ' +
      'You can analyze the image in chat (describe it, suggest a category), but to attach it to the report ' +
      'the user must re-upload it via this browser link. Do NOT use upload_image (base64), it fails in chat. ' +
      'Workflow: 1) Analyze the photo if shared in chat, 2) Call this tool, ' +
      '3) Ask the user to open the upload_url and upload the same photo there, ' +
      '4) Call check_upload with the token to get media_url, 5) Use media_url in create_request.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  handler: async () => {
    // 128-bit token: large enough that the upload link cannot be guessed.
    const token = randomBytes(16).toString('hex');
    const created = Date.now();

    logger.info('Preparing upload token', { token });

    // Pending marker; the upload page and check_upload validate against it.
    await blobStore.put(`${token}/meta.json`, JSON.stringify({ status: 'pending', created }));

    const baseUrl = (process.env.PUBLIC_URL || 'http://localhost:3100').replace(/\/+$/, '');
    const uploadUrl = `${baseUrl}/api/upload/${token}`;

    // Cleanup after expiry. In the long-running server this setTimeout fires
    // reliably (unlike a serverless function that has already exited).
    setTimeout(async () => {
      try {
        await blobStore.del(token);
        logger.info('Cleaned up expired upload', { token });
      } catch (e) {
        logger.error('Failed to clean up upload', e);
      }
    }, EXPIRY_MS);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: true,
              token,
              upload_url: uploadUrl,
              expires_in: '10 minutes',
              message: `Share this link with the user so they can upload a photo: ${uploadUrl}`,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
