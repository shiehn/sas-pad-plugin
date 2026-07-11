/**
 * Meta narrowing, config guards with per-field defaults, the positional
 * reconcile planner, prompt hints, and patch labels.
 */

import {
  PAD_VOICE_META_KEY,
  asPadConfig,
  asPadVoiceMeta,
  parsePromptHints,
  patchLabel,
  planReconcile,
  stampPadAnchor,
} from '../pad-voice-meta';

describe('asPadVoiceMeta', () => {
  it('narrows valid metas and rejects malformed ones', () => {
    expect(asPadVoiceMeta({ groupId: 'a', voiceIndex: 1, label: 'patch B' })).toEqual({
      groupId: 'a',
      voiceIndex: 1,
      label: 'patch B',
    });
    expect(asPadVoiceMeta({ groupId: 'a' })).toBeNull();
    expect(asPadVoiceMeta(null)).toBeNull();
    expect(asPadVoiceMeta('nope')).toBeNull();
  });
});

describe('asPadConfig', () => {
  it('keeps valid values and defaults invalid enum fields per-field', () => {
    expect(
      asPadConfig({ voiceCount: 3, duration: 'half', patternId: 'offbeat-stabs', voicing: 'partial', rests: 'sparse' })
    ).toEqual({ voiceCount: 3, duration: 'half', patternId: 'offbeat-stabs', voicing: 'partial', rests: 'sparse' });

    expect(asPadConfig({ voiceCount: 2, duration: 'triplets', patternId: 'nope', voicing: '?', rests: '?' })).toEqual({
      voiceCount: 2,
      duration: 'whole',
      patternId: 'front-half',
      voicing: 'full',
      rests: 'off',
    });

    expect(asPadConfig({ duration: 'half' })).toBeNull(); // voiceCount required
    expect(asPadConfig(null)).toBeNull();
  });
});

describe('planReconcile', () => {
  const existing = [
    { dbId: 'a', engineId: 'ea', voiceIndex: 0 },
    { dbId: 'b', engineId: 'eb', voiceIndex: 1 },
  ];

  it('reuses positionally (anchor always) and creates the rest', () => {
    const plan = planReconcile(existing, 4);
    expect(plan.reuse).toEqual([
      { dbId: 'a', engineId: 'ea', bucketIndex: 0 },
      { dbId: 'b', engineId: 'eb', bucketIndex: 1 },
    ]);
    expect(plan.createBucketIndexes).toEqual([2, 3]);
    expect(plan.remove).toEqual([]);
  });

  it('removes surplus members when the patch count shrinks', () => {
    const plan = planReconcile(existing, 1);
    expect(plan.reuse).toEqual([{ dbId: 'a', engineId: 'ea', bucketIndex: 0 }]);
    expect(plan.remove).toEqual([{ dbId: 'b', engineId: 'eb' }]);
  });

  it('sorts by voiceIndex before pairing', () => {
    const plan = planReconcile([existing[1], existing[0]], 2);
    expect(plan.reuse[0].dbId).toBe('a');
  });
});

describe('parsePromptHints', () => {
  it('reads patch count and duration words', () => {
    expect(parsePromptHints('3 pads, half notes, warm')).toEqual({ voiceCount: 3, duration: 'half' });
    expect(parsePromptHints('2 patches of sustained warmth')).toEqual({ voiceCount: 2, duration: 'whole' });
    expect(parsePromptHints('pulsing texture')).toEqual({ duration: 'rhythmic' });
    expect(parsePromptHints('dark cinematic wash')).toEqual({});
  });
});

describe('patchLabel', () => {
  it('letters the patches', () => {
    expect(patchLabel(0)).toBe('patch A');
    expect(patchLabel(3)).toBe('patch D');
  });
});

describe('stampPadAnchor', () => {
  it('anchors a newborn track as a group of ONE (meta only — config stays unstamped so prompt hints survive)', async () => {
    const written: Array<{ sceneId: string; key: string; value: unknown }> = [];
    const host = {
      setSceneData: async (sceneId: string, key: string, value: unknown) => {
        written.push({ sceneId, key, value });
      },
    };
    await stampPadAnchor(host, 'scene-1', (dbId, suffix) => `track:${dbId}:${suffix}`, 'db-new');

    expect(written).toEqual([
      {
        sceneId: 'scene-1',
        key: `track:db-new:${PAD_VOICE_META_KEY}`,
        value: { groupId: 'db-new', voiceIndex: 0, label: 'patch A' },
      },
    ]);
  });
});
