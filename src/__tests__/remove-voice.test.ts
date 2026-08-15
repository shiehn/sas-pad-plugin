/**
 * Per-patch removal: the pure plan and the scene-data surgery (config
 * shrink, contiguous renumber, anchor handoff, last-patch / miss no-ops).
 */

import { planVoiceRemoval, prepareVoiceRemoval, type VoiceRemovalMember } from '../remove-voice';
import { PAD_MIN_VOICES } from '../pad-generation';
import {
  PAD_CONFIG_KEY,
  PAD_VOICE_META_KEY,
  patchLabel,
  type PadVoiceMeta,
} from '../pad-voice-meta';

const keyFor = (dbId: string, suffix: string): string => `track:${dbId}:${suffix}`;

function member(
  dbId: string,
  voiceIndex: number,
  overrides: Partial<PadVoiceMeta> = {}
): VoiceRemovalMember {
  return {
    dbId,
    meta: { groupId: 'a', voiceIndex, label: patchLabel(voiceIndex), ...overrides },
  };
}

function makeStubHost(initial: Record<string, unknown> = {}): {
  data: Map<string, unknown>;
  host: { getSceneData: jest.Mock; setSceneData: jest.Mock };
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    host: {
      getSceneData: jest.fn(async (_scene: string, key: string) => data.get(key) ?? null),
      setSceneData: jest.fn(async (_scene: string, key: string, value: unknown) => {
        data.set(key, value);
      }),
    },
  };
}

const config = (voiceCount: number): Record<string, unknown> => ({
  voiceCount,
  duration: 'half',
  patternId: 'offbeat-stabs',
  voicing: 'partial',
  rests: 'sparse',
});

describe('planVoiceRemoval', () => {
  it('drops the deleted member and keeps voiceIndex order', () => {
    const plan = planVoiceRemoval([member('c', 2), member('a', 0), member('b', 1)], 'b');
    expect(plan.survivors.map((m) => m.dbId)).toEqual(['a', 'c']);
    expect(plan.anchorDbId).toBe('a');
    expect(plan.newAnchorDbId).toBeNull();
  });

  it('promotes the lowest surviving patch when the anchor is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0), member('b', 1), member('c', 2)], 'a');
    expect(plan.newAnchorDbId).toBe('b');
  });

  it('reports no handoff when the last patch is deleted', () => {
    const plan = planVoiceRemoval([member('a', 0)], 'a');
    expect(plan.survivors).toEqual([]);
    expect(plan.newAnchorDbId).toBeNull();
  });
});

describe('prepareVoiceRemoval', () => {
  const members = [member('a', 0), member('b', 1), member('c', 2)];

  it('shrinks the stored patch count on a non-anchor delete (other settings kept)', async () => {
    const { data, host } = makeStubHost({ [keyFor('a', PAD_CONFIG_KEY)]: config(3) });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(data.get(keyFor('a', PAD_CONFIG_KEY))).toEqual(config(2));
    // Survivors were already contiguous: config write only, no meta churn.
    expect(host.setSceneData).toHaveBeenCalledTimes(1);
  });

  it('renumbers survivors contiguously when a middle patch goes', async () => {
    const { data, host } = makeStubHost({ [keyFor('a', PAD_CONFIG_KEY)]: config(3) });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'b' });

    // 'a' keeps slot 0 (no write); 'c' slides from slot 2 → 1 and is relabelled.
    expect(data.get(keyFor('a', PAD_VOICE_META_KEY))).toBeUndefined();
    expect(data.get(keyFor('c', PAD_VOICE_META_KEY))).toEqual<PadVoiceMeta>({
      groupId: 'a',
      voiceIndex: 1,
      label: 'patch B',
    });
    expect(data.get(keyFor('a', PAD_CONFIG_KEY))).toEqual(config(2));
  });

  it('does not invent a config when none is stored', async () => {
    const { host } = makeStubHost();
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'c' });
    expect(host.setSceneData).not.toHaveBeenCalled();
  });

  it('hands the stack to the next patch when the anchor is deleted', async () => {
    const { data, host } = makeStubHost({
      [keyFor('a', PAD_CONFIG_KEY)]: config(3),
      [keyFor('a', 'prompt')]: 'glassy evolving pads',
    });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members, deletedDbId: 'a' });

    // Config + prompt moved to the new anchor, count shrunk.
    expect(data.get(keyFor('b', PAD_CONFIG_KEY))).toEqual(config(2));
    expect(data.get(keyFor('b', 'prompt'))).toBe('glassy evolving pads');

    // Survivors re-pointed at the new anchor and renumbered from 0.
    expect(data.get(keyFor('b', PAD_VOICE_META_KEY))).toEqual<PadVoiceMeta>({
      groupId: 'b',
      voiceIndex: 0,
      label: 'patch A',
    });
    expect(data.get(keyFor('c', PAD_VOICE_META_KEY))).toEqual<PadVoiceMeta>({
      groupId: 'b',
      voiceIndex: 1,
      label: 'patch B',
    });
  });

  it('leaves a single surviving patch at the minimum count', async () => {
    const two = [member('a', 0), member('b', 1)];
    const { data, host } = makeStubHost({ [keyFor('a', PAD_CONFIG_KEY)]: config(2) });
    await prepareVoiceRemoval({ host, sceneId: 's', keyFor, members: two, deletedDbId: 'b' });
    const cfg = data.get(keyFor('a', PAD_CONFIG_KEY)) as { voiceCount: number };
    expect(cfg.voiceCount).toBe(PAD_MIN_VOICES);
  });

  it('is a no-op for the last patch and for a missing selector', async () => {
    const solo = makeStubHost({ [keyFor('a', PAD_CONFIG_KEY)]: config(2) });
    await prepareVoiceRemoval({
      host: solo.host,
      sceneId: 's',
      keyFor,
      members: [member('a', 0)],
      deletedDbId: 'a',
    });
    expect(solo.host.setSceneData).not.toHaveBeenCalled();

    const miss = makeStubHost();
    await prepareVoiceRemoval({
      host: miss.host,
      sceneId: 's',
      keyFor,
      members,
      deletedDbId: 'zzz',
    });
    expect(miss.host.setSceneData).not.toHaveBeenCalled();
    expect(miss.host.getSceneData).not.toHaveBeenCalled();
  });
});
