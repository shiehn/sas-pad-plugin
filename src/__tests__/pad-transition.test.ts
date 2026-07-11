/**
 * Pad transition-group adapter — subject collapse, member expansion, and
 * group-meta round-trip against a mock host.
 */

import type { PluginHost, SceneFamilyTrack } from '@signalsandsorcery/plugin-sdk';
import { createPadTransitionGroupAdapter, padGroupLabel } from '../pad-transition';
import { PAD_VOICE_META_KEY, type PadVoiceMeta } from '../pad-voice-meta';

const SCENE = 'scene-from';

function voiceMeta(groupId: string, voiceIndex: number, label = ''): PadVoiceMeta {
  return { groupId, voiceIndex, label };
}

interface MockHostState {
  sceneData: Record<string, unknown>;
  familyTracks: SceneFamilyTrack[];
  written: Array<{ sceneId: string; key: string; value: unknown }>;
}

function mockHost(state: MockHostState): PluginHost {
  return {
    getAllSceneData: jest.fn(async (sceneId: string) =>
      sceneId === SCENE ? state.sceneData : {}
    ),
    listSceneFamilyTracks: jest.fn(async (sceneId: string) =>
      sceneId === SCENE ? state.familyTracks : []
    ),
    setSceneData: jest.fn(async (sceneId: string, key: string, value: unknown) => {
      state.written.push({ sceneId, key, value });
    }),
  } as unknown as PluginHost;
}

/** Two-patch group (g1) + one loose pad track. */
function makeState(): MockHostState {
  return {
    sceneData: {
      [`track:g1-v0:${PAD_VOICE_META_KEY}`]: voiceMeta('g1-v0', 0, 'patch A'),
      [`track:g1-v1:${PAD_VOICE_META_KEY}`]: voiceMeta('g1-v0', 1, 'patch B'),
      'track:g1-v0:prompt': 'warm analog wash',
    },
    familyTracks: [
      { dbId: 'g1-v0', name: 'pad-1-v0', role: 'pads', prompt: 'warm analog wash' },
      { dbId: 'g1-v1', name: 'pad-1-v1', role: 'pads' },
      { dbId: 'loose-1', name: 'pad-loose', role: 'pads' },
    ],
    written: [],
  };
}

describe('padGroupLabel', () => {
  it('pluralizes patches', () => {
    expect(padGroupLabel(1)).toBe('Pads (1 patch)');
    expect(padGroupLabel(3)).toBe('Pads (3 patches)');
  });
});

describe('mapColumnSubjects', () => {
  it('collapses a patch group to ONE anchor-addressed subject and passes loose tracks through', async () => {
    const state = makeState();
    const adapter = createPadTransitionGroupAdapter(mockHost(state));

    const subjects = await adapter.mapColumnSubjects(SCENE, state.familyTracks);

    expect(subjects).toEqual([
      {
        dbId: 'g1-v0', // the ANCHOR's dbId — exclude/row keys stay source-exact
        name: 'Pads (2 patches)',
        role: 'pads',
        prompt: 'warm analog wash',
      },
      { dbId: 'loose-1', name: 'pad-loose', role: 'pads' },
    ]);
  });

  it('drops groups with no live members and counts only live ones', async () => {
    const state = makeState();
    state.sceneData[`track:gone:${PAD_VOICE_META_KEY}`] = voiceMeta('gone', 0);
    state.familyTracks = state.familyTracks.filter((t) => t.dbId !== 'g1-v1');
    const adapter = createPadTransitionGroupAdapter(mockHost(state));

    const subjects = await adapter.mapColumnSubjects(SCENE, state.familyTracks);

    expect(subjects.map((s) => s.dbId)).toEqual(['g1-v0', 'loose-1']);
    expect(subjects[0].name).toBe('Pads (1 patch)');
  });
});

describe('expandSubject', () => {
  it('expands the anchor dbId into voiceIndex-ordered members with labels + familyMeta', async () => {
    const state = makeState();
    const adapter = createPadTransitionGroupAdapter(mockHost(state));

    const members = await adapter.expandSubject(SCENE, 'g1-v0');

    expect(members).toEqual([
      {
        dbId: 'g1-v0',
        name: 'pad-1-v0',
        role: 'pads',
        memberIndex: 0,
        memberLabel: 'patch A',
        familyMeta: voiceMeta('g1-v0', 0, 'patch A'),
      },
      {
        dbId: 'g1-v1',
        name: 'pad-1-v1',
        role: 'pads',
        memberIndex: 1,
        memberLabel: 'patch B',
        familyMeta: voiceMeta('g1-v0', 1, 'patch B'),
      },
    ]);
  });

  it('expands a loose track to a single member', async () => {
    const state = makeState();
    const adapter = createPadTransitionGroupAdapter(mockHost(state));

    const members = await adapter.expandSubject(SCENE, 'loose-1');

    expect(members).toEqual([
      { dbId: 'loose-1', name: 'pad-loose', role: 'pads', memberIndex: 0 },
    ]);
  });

  it('returns [] for an unknown subject', async () => {
    const state = makeState();
    const adapter = createPadTransitionGroupAdapter(mockHost(state));
    expect(await adapter.expandSubject(SCENE, 'nope')).toEqual([]);
  });
});

describe('writeGroupMetas', () => {
  it('writes one padVoice meta per copy sharing the NEW anchor groupId, labels round-tripped', async () => {
    const state = makeState();
    const adapter = createPadTransitionGroupAdapter(mockHost(state));
    const members = await adapter.expandSubject(SCENE, 'g1-v0');

    await adapter.writeGroupMetas(
      'scene-transition',
      [
        { newDbId: 'copy-a', member: members[0] },
        { newDbId: 'copy-b', member: members[1] },
      ],
      'copy-a'
    );

    expect(state.written).toEqual([
      {
        sceneId: 'scene-transition',
        key: `track:copy-a:${PAD_VOICE_META_KEY}`,
        value: { groupId: 'copy-a', voiceIndex: 0, label: 'patch A' },
      },
      {
        sceneId: 'scene-transition',
        key: `track:copy-b:${PAD_VOICE_META_KEY}`,
        value: { groupId: 'copy-a', voiceIndex: 1, label: 'patch B' },
      },
    ]);
  });
});

describe('defaults', () => {
  it('crosses symmetrically at 0.5 (overlapping washes) and stays fade-only', () => {
    const adapter = createPadTransitionGroupAdapter(mockHost(makeState()));
    expect(adapter.fadeOnly).toBe(true);
    expect(adapter.defaultSliderPos?.('out')).toBe(0.5);
    expect(adapter.defaultSliderPos?.('in')).toBe(0.5);
    expect(adapter.cleanupKeySuffixes).toEqual([PAD_VOICE_META_KEY]);
  });
});
