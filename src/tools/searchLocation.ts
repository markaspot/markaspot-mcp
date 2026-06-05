import { z } from 'zod';
import { Tool } from '../types/tool.js';
import { logger } from '../utils/logger.js';

const inputSchema = z.object({
  query: z.string(),
  limit: z.number().optional().default(5),
});

// Using Nominatim for geocoding (can be replaced with other services)
const GEOCODING_URL = 'https://nominatim.openstreetmap.org/search';

export const searchLocationTool: Tool = {
  definition: {
    name: 'search_location',
    description: 'Search for a location and get coordinates',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Address or location to search for' },
        limit: { type: 'number', description: 'Maximum number of results (default: 5)' },
      },
    },
  },
  handler: async (args: unknown) => {
    try {
      const { query, limit } = inputSchema.parse(args);
      
      logger.info('Searching for location', { query });

      const url = new URL(GEOCODING_URL);
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('limit', String(limit));
      url.searchParams.set('addressdetails', '1');

      // Bound the geocoding call so a hung request cannot block the function slot.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': 'MCP-Bridge-GeoReport/1.0',
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error(`Geocoding failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as any[];

      const results = data.map((item: any) => ({
        display_name: item.display_name,
        lat: parseFloat(item.lat),
        lon: parseFloat(item.lon),
        type: item.type,
        importance: item.importance,
      }));
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error searching location', error);
      throw error;
    }
  },
};