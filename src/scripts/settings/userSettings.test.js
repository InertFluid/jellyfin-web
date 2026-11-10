import { describe, expect, it, vi } from 'vitest';

// appSettings pulls in browser detection that doesn't load under jsdom.
vi.mock('./appSettings', () => ({ default: {} }));

describe('userSettings module exports', () => {
    // The playback settings page reads every setting through the module's
    // named exports; a missing one throws while loading the form and leaves
    // the page stuck behind its loading spinner.
    it('exports enableGaplessAudio for the playback settings page', async () => {
        const userSettings = await import('./userSettings');
        expect(typeof userSettings.enableGaplessAudio).toBe('function');
    });
});
