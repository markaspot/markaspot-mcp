import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  expandToolsets,
  unknownToolsets,
  toolsetForTool,
  enabledToolsets,
  resetToolsetCache,
  ALL_TOOLSETS,
} from '../src/toolsets.js';

describe('toolsets', () => {
  const savedEnv = process.env.ENABLED_TOOLSETS;

  beforeEach(() => {
    resetToolsetCache();
    delete process.env.ENABLED_TOOLSETS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ENABLED_TOOLSETS;
    else process.env.ENABLED_TOOLSETS = savedEnv;
    resetToolsetCache();
  });

  describe('expandToolsets (backward-compat persona aliases)', () => {
    it('expands citizen -> read + intake', () => {
      expect(expandToolsets(['citizen'])).toEqual(new Set(['read', 'intake']));
    });

    it('expands staff -> all four canonical toolsets', () => {
      expect(expandToolsets(['staff'])).toEqual(new Set(ALL_TOOLSETS));
    });

    it('passes canonical IDs through unchanged', () => {
      expect(expandToolsets(['read', 'manage'])).toEqual(new Set(['read', 'manage']));
    });

    it('drops unknown entries', () => {
      expect(expandToolsets(['read', 'bogus'])).toEqual(new Set(['read']));
    });

    it('drops the removed ayunis-core alias (now unknown) to empty', () => {
      expect(expandToolsets(['ayunis-core'])).toEqual(new Set());
      expect(unknownToolsets(['ayunis-core'])).toEqual(['ayunis-core']);
    });

    it('treats inherited Object.prototype keys as unknown without crashing', () => {
      expect(expandToolsets(['toString', 'constructor', 'read'])).toEqual(new Set(['read']));
      expect(unknownToolsets(['toString'])).toEqual(['toString']);
    });

    it('tolerates whitespace around entries', () => {
      expect(expandToolsets([' citizen ', ' reporting '])).toEqual(
        new Set(['read', 'intake', 'reporting']),
      );
    });
  });

  describe('toolsetForTool', () => {
    it('maps create_request -> intake', () => {
      expect(toolsetForTool('create_request')).toBe('intake');
    });
    it('maps get_stats -> reporting', () => {
      expect(toolsetForTool('get_stats')).toBe('reporting');
    });
    it('maps list_tenants -> manage', () => {
      expect(toolsetForTool('list_tenants')).toBe('manage');
    });
    it('maps list_requests -> read', () => {
      expect(toolsetForTool('list_requests')).toBe('read');
    });
    it('defaults unknown tools to read', () => {
      expect(toolsetForTool('something_new')).toBe('read');
    });
  });

  describe('enabledToolsets', () => {
    it('accepts a persona alias mixed with a canonical id (citizen,reporting)', () => {
      process.env.ENABLED_TOOLSETS = 'citizen,reporting';
      resetToolsetCache();
      const enabled = enabledToolsets();
      expect(enabled.has('read')).toBe(true);
      expect(enabled.has('intake')).toBe(true);
      expect(enabled.has('reporting')).toBe(true);
      expect(enabled.has('manage')).toBe(false);
    });

    it('defaults to the read+intake baseline when unset', () => {
      delete process.env.ENABLED_TOOLSETS;
      resetToolsetCache();
      expect(enabledToolsets()).toEqual(new Set(['read', 'intake']));
    });

    it('accepts canonical IDs directly', () => {
      process.env.ENABLED_TOOLSETS = 'read,intake,manage,reporting';
      resetToolsetCache();
      expect(enabledToolsets()).toEqual(new Set(ALL_TOOLSETS));
    });

    it('falls back to the read+intake baseline when only unknown ids are given', () => {
      process.env.ENABLED_TOOLSETS = 'ayunis-core';
      resetToolsetCache();
      expect(enabledToolsets()).toEqual(new Set(['read', 'intake']));
    });
  });
});
