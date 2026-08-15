/**
 * Per-patch removal — the "delete ONE patch" counterpart of the group ✕
 * (the bass/ensemble shape, pad-flavoured).
 *
 * Deleting a patch is a plain track delete plus scene-data surgery so the
 * group that reloads afterwards is internally consistent:
 *
 *   - the anchor-held config's voiceCount shrinks to the survivor count, so
 *     the header dropdown — and the next Generate, which reconciles
 *     positionally against it — match what is actually left;
 *   - survivors are RENUMBERED contiguously (0…n-1) and relabelled, because
 *     a pad voiceIndex is a rotation slot ("base slot i plays on patch
 *     i % voiceCount") and its label is positional ("patch A"). Leaving a
 *     gap would show "patch A · patch C" over a 2-patch rotation and park a
 *     track on a slot nothing rotates onto until the next generation
 *     re-stamps it. Bass/ensemble keep their indices because their labels
 *     are semantic, not positional;
 *   - deleting the ANCHOR (voice 0) hands the group identity to the next
 *     surviving patch: prompt + config move to the new anchor's keys and
 *     every survivor's meta is re-pointed (groupId = new anchor dbId) BEFORE
 *     the old anchor's track and keys are scrubbed — the group must never
 *     reload through an anchorless (degraded-to-loose-rows) state.
 *
 * The caller runs this surgery FIRST, then `ctx.deleteGroup([deleted], …)`
 * with the same suffix list the whole-group ✕ uses: the anchor-held keys
 * either moved here already or belong to the last remaining patch.
 */

import { PAD_MAX_VOICES, PAD_MIN_VOICES } from './pad-generation';
import {
  PAD_CONFIG_KEY,
  PAD_VOICE_META_KEY,
  asPadConfig,
  patchLabel,
  type PadVoiceMeta,
} from './pad-voice-meta';

/** The slice of PluginHost the surgery needs (kept narrow for tests). */
export interface VoiceRemovalHost {
  getSceneData(sceneId: string, key: string): Promise<unknown>;
  setSceneData(sceneId: string, key: string, value: unknown): Promise<void>;
}

export interface VoiceRemovalMember {
  dbId: string;
  meta: PadVoiceMeta;
}

export interface VoiceRemovalPlan {
  /** Members left after the delete, sorted by voiceIndex. */
  survivors: VoiceRemovalMember[];
  /** The group's anchor BEFORE the delete (voiceIndex 0, or first member). */
  anchorDbId: string | null;
  /** Set when the anchor itself is deleted and survivors remain. */
  newAnchorDbId: string | null;
}

export function planVoiceRemoval(
  members: VoiceRemovalMember[],
  deletedDbId: string
): VoiceRemovalPlan {
  const sorted = [...members].sort((a, b) => a.meta.voiceIndex - b.meta.voiceIndex);
  const anchor = sorted.find((m) => m.meta.voiceIndex === 0) ?? sorted[0];
  const survivors = sorted.filter((m) => m.dbId !== deletedDbId);
  const anchorDeleted = anchor !== undefined && anchor.dbId === deletedDbId;
  return {
    survivors,
    anchorDbId: anchor?.dbId ?? null,
    newAnchorDbId: anchorDeleted && survivors.length > 0 ? survivors[0].dbId : null,
  };
}

const clampVoiceCount = (n: number): number =>
  Math.max(PAD_MIN_VOICES, Math.min(PAD_MAX_VOICES, n));

/**
 * Scene-data surgery for removing one patch. No-op when the selector misses
 * or when the deleted patch is the LAST one (the caller's deleteGroup scrub
 * is the whole cleanup then). Never invents a config: when no config blob is
 * stored (pre-first-generate), hints/defaults keep resolving the count.
 * NOTE the stored count clamps at PAD_MIN_VOICES — deleting down to a single
 * patch keeps the dropdown (and the next Generate) at the minimum.
 */
export async function prepareVoiceRemoval(opts: {
  host: VoiceRemovalHost;
  sceneId: string;
  keyFor: (dbId: string, suffix: string) => string;
  members: VoiceRemovalMember[];
  deletedDbId: string;
}): Promise<void> {
  const { host, sceneId, keyFor, members, deletedDbId } = opts;
  const plan = planVoiceRemoval(members, deletedDbId);
  if (plan.survivors.length === members.length) return; // selector missed
  if (plan.survivors.length === 0 || plan.anchorDbId === null) return; // last patch

  const anchorDbId = plan.newAnchorDbId ?? plan.anchorDbId;
  const cfg = asPadConfig(await host.getSceneData(sceneId, keyFor(plan.anchorDbId, PAD_CONFIG_KEY)));
  if (cfg) {
    await host.setSceneData(sceneId, keyFor(anchorDbId, PAD_CONFIG_KEY), {
      ...cfg,
      voiceCount: clampVoiceCount(plan.survivors.length),
    });
  }

  if (plan.newAnchorDbId) {
    const prompt = await host.getSceneData(sceneId, keyFor(plan.anchorDbId, 'prompt'));
    if (typeof prompt === 'string' && prompt.trim() !== '') {
      await host.setSceneData(sceneId, keyFor(plan.newAnchorDbId, 'prompt'), prompt);
    }
  }

  // Renumber every survivor onto a contiguous rotation (0…n-1). Cheap, and it
  // keeps labels honest whether or not the anchor moved.
  for (let i = 0; i < plan.survivors.length; i++) {
    const s = plan.survivors[i];
    const meta: PadVoiceMeta = { ...s.meta, groupId: anchorDbId, voiceIndex: i, label: patchLabel(i) };
    if (
      s.meta.groupId === meta.groupId &&
      s.meta.voiceIndex === meta.voiceIndex &&
      s.meta.label === meta.label
    ) {
      continue; // already where it belongs — don't burn a write
    }
    await host.setSceneData(sceneId, keyFor(s.dbId, PAD_VOICE_META_KEY), meta);
  }
}
