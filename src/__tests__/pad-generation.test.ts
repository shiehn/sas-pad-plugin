/**
 * The brain, end to end against a stubbed host: schema-forced request shape,
 * rotation routing to the right patch tracks, the deterministic fallback for
 * omitted slots, the guided retry, config precedence, budget refusal, the
 * chordless-scene gate, and LIFO rollback.
 */

import type {
  GenerationServices,
  GeneratorTrackState,
  LLMToolUseRequest,
  MidiClipData,
} from '@signalsandsorcery/plugin-sdk';
import { generatePads, PAD_MAX_TRACKS } from '../pad-generation';
import { SUBMIT_PADS_TOOL_NAME } from '../pad-schema';
import { PAD_VOICE_META_KEY } from '../pad-voice-meta';

type SlotsArg = { slots: Array<{ slotIndex: number; pitches: number[] }> };

function llmResponse(args: SlotsArg): unknown {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name: SUBMIT_PADS_TOOL_NAME, args } }] } },
    ],
  };
}

/**
 * The harness scene: 2 bars, Am (bar 1) → F (bar 2). The default prompt asks
 * for 2 patches with whole notes → 2 voicing slots, slot 0 on patch A and
 * slot 1 on patch B.
 */
const CLEAN_SLOTS: SlotsArg = {
  slots: [
    { slotIndex: 0, pitches: [57, 60, 64] }, // Am
    { slotIndex: 1, pitches: [57, 60, 65] }, // F (smooth: one voice moves 1 st)
  ],
};

interface Harness {
  services: GenerationServices;
  track: GeneratorTrackState;
  calls: string[];
  llmRequests: LLMToolUseRequest[];
  sceneData: Map<string, unknown>;
  clips: Map<string, MidiClipData>;
  host: Record<string, jest.Mock>;
}

function makeHarness(opts: {
  llmResults?: unknown[];
  trackCount?: number;
  failClipWrite?: boolean;
  chordless?: boolean;
  prompt?: string;
} = {}): Harness {
  const calls: string[] = [];
  const llmRequests: LLMToolUseRequest[] = [];
  const sceneData = new Map<string, unknown>();
  const clips = new Map<string, MidiClipData>();
  const llmResults = [...(opts.llmResults ?? [llmResponse(CLEAN_SLOTS)])];

  const host: Record<string, jest.Mock> = {
    getSceneData: jest.fn(async (_scene: string, key: string) => sceneData.get(key) ?? null),
    setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
      calls.push(`setSceneData:${key}`);
      sceneData.set(key, value);
    }),
    deleteSceneData: jest.fn(async (_scene: string, key: string) => {
      calls.push(`deleteSceneData:${key}`);
    }),
    getMusicalContext: jest.fn(async () => ({
      key: 'A', mode: 'minor', bpm: 120, bars: 2, genre: 'ambient',
      timeSignature: '4/4',
      chordProgression: opts.chordless
        ? []
        : [
            { symbol: 'Am', startQn: 0, endQn: 4 },
            { symbol: 'F', startQn: 4, endQn: 8 },
          ],
      contractPrompt: 'weightless dawn',
    })),
    getGenerationContext: jest.fn(async () => ({
      chordProgression: { key: { tonic: 'A', mode: 'minor' }, chordsWithTiming: [], genre: null },
      concurrentTracks: [{
        trackId: 'eng-drums', dbId: 'db-drums', name: 'Drums', role: 'kicks',
        presetCategory: null,
        notesByChord: [{ chord: 'Am', chordRangeQn: [0, 4] as [number, number], notes: [
          { pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 120 },
        ] }],
      }],
    })),
    generateWithLLMTools: jest.fn(async (request: LLMToolUseRequest) => {
      llmRequests.push(request);
      const next = llmResults.length > 1 ? llmResults.shift() : llmResults[0];
      return next;
    }),
    writeMidiClip: jest.fn(async (engineId: string, clip: MidiClipData) => {
      if (opts.failClipWrite) throw new Error('engine says no');
      calls.push(`writeMidiClip:${engineId}`);
      clips.set(engineId, clip);
      return {};
    }),
    setTrackRole: jest.fn(async (engineId: string, role: string) => { calls.push(`setTrackRole:${engineId}:${role}`); }),
    setTrackMute: jest.fn(async () => { calls.push('mute'); }),
    shufflePreset: jest.fn(async (engineId: string, exclude?: string[]) => {
      calls.push(`shufflePreset:${engineId}:excl=${(exclude ?? []).join('|')}`);
      return { presetName: `P-${engineId}`, presetCategory: 'Pads-Hi' };
    }),
    deleteTrack: jest.fn(async (engineId: string) => { calls.push(`deleteTrack:${engineId}`); }),
    showToast: jest.fn(),
  };

  const services = {
    host: host as never,
    activeSceneId: 'scene-1',
    tracks: Array.from({ length: opts.trackCount ?? 1 }, (_, i) => ({ id: i })),
    updateTrack: jest.fn(),
    setTracks: jest.fn(),
    reloadTracks: jest.fn(async () => {}),
    soundHistory: {} as never,
    engineToDbId: (id: string) => id,
    trackDataKey: (dbId: string, suffix: string) => `track:${dbId}:${suffix}`,
    markEditLoaded: jest.fn(),
    createFamilyTrack: jest.fn(async (suffix = '') => {
      calls.push(`createFamilyTrack:${suffix}`);
      return { id: `eng-new${suffix}`, name: `pad${suffix}`, dbId: `db-new${suffix}` };
    }),
    resolvedGroups: jest.fn(() => []),
  } as unknown as GenerationServices;

  const track = {
    handle: { id: 'eng-a', name: 'pad-1', dbId: 'db-a' },
    prompt: opts.prompt ?? '2 patches, warm analog pads',
    role: '',
    runtimeState: { muted: false, solo: false },
  } as unknown as GeneratorTrackState;

  return { services, track, calls, llmRequests, sceneData, clips, host };
}

describe('generatePads', () => {
  it('makes ONE schema-forced call and executes create→clip→role→preset→meta in order', async () => {
    const h = makeHarness();
    await generatePads(h.track, h.services);

    // Request shape: forced function calling with our tool + assembled context.
    expect(h.llmRequests).toHaveLength(1);
    const req = h.llmRequests[0];
    expect(req.toolConfig?.functionCallingConfig?.mode).toBe('ANY');
    expect(req.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual([SUBMIT_PADS_TOOL_NAME]);
    const sys = req.systemInstruction?.parts?.[0]?.text ?? '';
    expect(sys).toContain('slot 0: bar 1');
    expect(sys).toContain('chord Am');
    expect(sys).toContain('chord F');
    const user = (req.contents[0].parts[0] as { text: string }).text;
    expect(user).toContain('Musical Context:');
    expect(user).toContain('Am (beats 0-4)');
    expect(user).toContain('Concurrent tracks in scene');
    expect(user).toContain('User request: "2 patches, warm analog pads"');

    // 2 patches (hint-driven), anchor reused → 1 new track created.
    expect(h.calls.filter((c) => c.startsWith('createFamilyTrack'))).toHaveLength(1);

    // Ordering: every clip write precedes every preset shuffle; metas come last.
    const firstShuffle = h.calls.findIndex((c) => c.startsWith('shufflePreset'));
    const lastClip = h.calls
      .map((c, i) => (c.startsWith('writeMidiClip') ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(lastClip).toBeLessThan(firstShuffle);
    const firstMeta = h.calls.findIndex((c) =>
      c.startsWith(`setSceneData:track:db-a:${PAD_VOICE_META_KEY}`)
    );
    expect(firstMeta).toBeGreaterThan(firstShuffle);

    // Presets only for NEW patches (anchor reused keeps its patch).
    expect(h.calls.filter((c) => c.startsWith('shufflePreset'))).toHaveLength(1);

    // Both tracks get the 'pads' role.
    expect(h.calls).toContain('setTrackRole:eng-a:pads');
    expect(h.calls).toContain('setTrackRole:eng-new-v1:pads');

    // Anchor meta has groupId = anchor dbId; full config persisted.
    expect(h.sceneData.get(`track:db-a:${PAD_VOICE_META_KEY}`)).toMatchObject({
      groupId: 'db-a',
      voiceIndex: 0,
      label: 'patch A',
    });
    expect(h.sceneData.get('track:db-a:padConfig')).toMatchObject({
      voiceCount: 2,
      duration: 'whole',
      voicing: 'full',
      rests: 'off',
    });
  });

  it('routes rotation slots to the right patch tracks (bar 1 → A, bar 2 → B)', async () => {
    const h = makeHarness();
    await generatePads(h.track, h.services);

    const anchorClip = h.clips.get('eng-a')!;
    const newClip = h.clips.get('eng-new-v1')!;
    // Patch A sustains bar 1 only; patch B bar 2 only.
    expect(anchorClip.notes.every((n) => n.startBeat === 0 && n.durationBeats === 4)).toBe(true);
    expect(newClip.notes.every((n) => n.startBeat === 4 && n.durationBeats === 4)).toBe(true);
    expect(anchorClip.notes.map((n) => n.pitch)).toEqual([57, 60, 64]);
    expect(newClip.notes.map((n) => n.pitch)).toEqual([57, 60, 65]);
  });

  it('fills omitted slots with a deterministic fallback voicing — never a silent bar', async () => {
    const h = makeHarness({
      llmResults: [llmResponse({ slots: [{ slotIndex: 0, pitches: [57, 60, 64] }] })],
    });
    await generatePads(h.track, h.services);

    const newClip = h.clips.get('eng-new-v1')!;
    expect(newClip.notes.length).toBeGreaterThan(0);
    // Fallback voicing comes from the slot's chord (F major: pcs 5, 9, 0).
    const fPcs = new Set([5, 9, 0]);
    expect(newClip.notes.every((n) => fPcs.has(n.pitch % 12))).toBe(true);
  });

  it('retries ONCE with the violation report when voice-leading fails, keeping the better attempt', async () => {
    const dirty: SlotsArg = {
      slots: [
        { slotIndex: 0, pitches: [55, 60, 64] },
        { slotIndex: 1, pitches: [69, 72, 77] }, // whole voicing jumps ~12 st
      ],
    };
    const h = makeHarness({ llmResults: [llmResponse(dirty), llmResponse(CLEAN_SLOTS)] });
    await generatePads(h.track, h.services);

    expect(h.llmRequests).toHaveLength(2);
    const retryUser = (h.llmRequests[1].contents[0].parts[0] as { text: string }).text;
    expect(retryUser).toContain('voice-leading problems');
    // The clean retry won: patch B carries the smooth voicing, not the jump.
    const newClip = h.clips.get('eng-new-v1')!;
    expect(newClip.notes.map((n) => n.pitch)).toEqual([57, 60, 65]);
  });

  it('honors stored header config over prompt hints', async () => {
    const h = makeHarness({
      prompt: '3 pads please',
      llmResults: [llmResponse(CLEAN_SLOTS)],
    });
    h.sceneData.set('track:db-a:padConfig', {
      voiceCount: 1,
      duration: 'whole',
      patternId: 'front-half',
      voicing: 'full',
      rests: 'off',
    });
    await generatePads(h.track, h.services);
    // voiceCount 1 → everything lands on the anchor; nothing is created.
    expect(h.calls.filter((c) => c.startsWith('createFamilyTrack'))).toHaveLength(0);
    expect(h.clips.get('eng-a')!.notes.some((n) => n.startBeat === 4)).toBe(true);
  });

  it('refuses a chordless scene with a pointer at the contract', async () => {
    const h = makeHarness({ chordless: true });
    await expect(generatePads(h.track, h.services)).rejects.toThrow(/No chords found/);
    expect(h.llmRequests).toHaveLength(0);
  });

  it('refuses to blow the track budget', async () => {
    const h = makeHarness({ trackCount: PAD_MAX_TRACKS });
    await expect(generatePads(h.track, h.services)).rejects.toThrow(/track panel budget/);
    expect(h.calls.filter((c) => c.startsWith('createFamilyTrack'))).toHaveLength(0);
  });

  it('rolls back created tracks LIFO when a clip write fails', async () => {
    const h = makeHarness({ failClipWrite: true });
    await expect(generatePads(h.track, h.services)).rejects.toThrow('engine says no');
    // The created patch track is deleted and its meta key cleaned up.
    expect(h.calls).toContain('deleteTrack:eng-new-v1');
    expect(h.calls).toContain(`deleteSceneData:track:db-new-v1:${PAD_VOICE_META_KEY}`);
    // No group metas survive a failed pass.
    expect(h.sceneData.has(`track:db-a:${PAD_VOICE_META_KEY}`)).toBe(false);
  });
});
