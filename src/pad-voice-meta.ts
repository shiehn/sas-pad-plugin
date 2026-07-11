/**
 * Pad voice-group metadata — the bass/ensemble voice-group shape, verbatim
 * discipline: membership is per-member scene-data under
 * `track:<dbId>:padVoice`, the anchor is voiceIndex 0 and carries the group
 * prompt under the standard prompt key plus the pad config under
 * `track:<anchorDbId>:padConfig`, and regeneration reconciles positionally
 * (reused patches KEEP the user's presets).
 */

import type {
  GroupParseSpec,
  ResolvedTrackGroup,
  GeneratorTrackState,
} from '@signalsandsorcery/plugin-sdk';
import {
  DEFAULT_PATTERN_ID,
  PAD_DURATION_MODES,
  PAD_PATTERNS,
  PAD_RESTS_MODES,
  PAD_VOICING_MODES,
  type PadDurationMode,
  type PadRestsMode,
  type PadVoicingMode,
} from './pad-patterns';

export const PAD_VOICE_META_KEY = 'padVoice';
/** Anchor-held pad config (all five header controls), same scene-data channel. */
export const PAD_CONFIG_KEY = 'padConfig';

export interface PadVoiceMeta {
  /** dbId of the anchor (voice 0). */
  groupId: string;
  /** Rotation position: base slot i plays on voice (i % voiceCount). */
  voiceIndex: number;
  /** Patch label shown in the voice row ("patch A"). */
  label: string;
}

export function patchLabel(voiceIndex: number): string {
  const letter = 'ABCDEFGH'[voiceIndex] ?? String(voiceIndex + 1);
  return `patch ${letter}`;
}

export function asPadVoiceMeta(val: unknown): PadVoiceMeta | null {
  if (!val || typeof val !== 'object') return null;
  const m = val as Partial<PadVoiceMeta>;
  if (typeof m.groupId !== 'string' || typeof m.voiceIndex !== 'number') return null;
  return {
    groupId: m.groupId,
    voiceIndex: m.voiceIndex,
    label: typeof m.label === 'string' ? m.label : '',
  };
}

export const padVoiceGroupSpec: GroupParseSpec<PadVoiceMeta> = {
  metaKey: PAD_VOICE_META_KEY,
  asMeta: asPadVoiceMeta,
  groupIdOf: (m) => m.groupId,
  sortMembers: (a, b) => a.meta.voiceIndex - b.meta.voiceIndex,
};

export function padGroupIsComplete(
  group: ResolvedTrackGroup<PadVoiceMeta, GeneratorTrackState>
): boolean {
  return group.members.some((m) => m.meta.voiceIndex === 0);
}

// --- reconcile planner (pure; the bass/ensemble shape) ---

export interface ReconcileMember {
  dbId: string;
  engineId: string;
  voiceIndex: number;
}

export interface ReconcilePlan {
  reuse: Array<{ dbId: string; engineId: string; bucketIndex: number }>;
  createBucketIndexes: number[];
  remove: Array<{ dbId: string; engineId: string }>;
}

/**
 * Pair existing members with the new patch list positionally: index 0 (the
 * anchor) is always reused, so the groupId and the prompt key never move;
 * extra patches are created, surplus members removed. Reused patches keep
 * their presets unconditionally.
 */
export function planReconcile(existing: ReconcileMember[], bucketCount: number): ReconcilePlan {
  const sorted = [...existing].sort((a, b) => a.voiceIndex - b.voiceIndex);
  const reuse: ReconcilePlan['reuse'] = [];
  const createBucketIndexes: number[] = [];
  const remove: ReconcilePlan['remove'] = [];
  for (let i = 0; i < bucketCount; i++) {
    const member = sorted[i];
    if (member) reuse.push({ dbId: member.dbId, engineId: member.engineId, bucketIndex: i });
    else createBucketIndexes.push(i);
  }
  for (let i = bucketCount; i < sorted.length; i++) {
    remove.push({ dbId: sorted[i].dbId, engineId: sorted[i].engineId });
  }
  return { reuse, createBucketIndexes, remove };
}

// --- pad config (anchor-held) ---

export interface PadConfig {
  voiceCount: number;
  duration: PadDurationMode;
  patternId: string;
  voicing: PadVoicingMode;
  rests: PadRestsMode;
}

export function asPadConfig(val: unknown): PadConfig | null {
  if (!val || typeof val !== 'object') return null;
  const c = val as Partial<PadConfig>;
  if (typeof c.voiceCount !== 'number') return null;
  return {
    voiceCount: c.voiceCount,
    duration: PAD_DURATION_MODES.includes(c.duration as PadDurationMode)
      ? (c.duration as PadDurationMode)
      : 'whole',
    patternId: PAD_PATTERNS.some((p) => p.id === c.patternId)
      ? (c.patternId as string)
      : DEFAULT_PATTERN_ID,
    voicing: PAD_VOICING_MODES.includes(c.voicing as PadVoicingMode)
      ? (c.voicing as PadVoicingMode)
      : 'full',
    rests: PAD_RESTS_MODES.includes(c.rests as PadRestsMode)
      ? (c.rests as PadRestsMode)
      : 'off',
  };
}

/**
 * Deterministic prompt hints for the FIRST generate (before the group header
 * with its explicit controls exists): "3 pads" / "2 patches" sets the count,
 * "half notes" / "whole notes" the duration. Explicit config always wins.
 */
export function parsePromptHints(prompt: string): {
  voiceCount?: number;
  duration?: PadDurationMode;
} {
  const hints: { voiceCount?: number; duration?: PadDurationMode } = {};
  const count = /(\d+)\s*[- ]?\s*(?:pad|patch|voice|part)e?s?\b/i.exec(prompt);
  if (count) hints.voiceCount = parseInt(count[1], 10);
  if (/\bhalf(?:-|\s)?notes?\b/i.test(prompt)) hints.duration = 'half';
  else if (/\b(?:whole(?:-|\s)?notes?|sustained?)\b/i.test(prompt)) hints.duration = 'whole';
  else if (/\b(?:rhythmic|stabs?|puls\w+)\b/i.test(prompt)) hints.duration = 'rhythmic';
  return hints;
}
