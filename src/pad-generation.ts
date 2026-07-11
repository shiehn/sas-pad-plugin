/**
 * Pad generation strategy — the brain.
 *
 * ONE schema-forced LLM call voices ALL slots together
 * (host.generateWithLLMTools, mode 'ANY', submit_pads tool), then the
 * polyphonic mechanical layer enforces the hard contract per slot (register
 * fold, chord/scale snap, polyphony cap, mud guard, deterministic fallback
 * for omitted slots) and the soft voice-leading rules are analyzed;
 * violations earn ONE guided retry (quota-conscious), keeping whichever
 * attempt scores better.
 *
 * All TIMING is deterministic (pad-patterns.ts): duration mode, curated
 * rhythm patterns, rests, chord-boundary splits, and the rotation of base
 * slots across patches (slot i → patch i % voiceCount).
 *
 * Track lifecycle follows the bass/ensemble plugins verbatim: positional
 * reconcile (reused patches KEEP the user's presets), clips written before
 * presets, metas last, LIFO rollback on failure, everything spawns muted.
 *
 * NOTE: generateWithLLMTools is a raw Gemini passthrough — unlike
 * generateWithLLM it does NOT auto-prefix the musical context, so this
 * strategy assembles key/BPM/chords/contract + the concurrent-tracks block
 * into the user content itself.
 */

import type {
  GeneratorTrackState,
  GenerationServices,
  PluginTrackHandle,
  MidiClipData,
  LLMToolUseRequest,
  LLMFunctionDeclaration,
} from '@signalsandsorcery/plugin-sdk';
import { formatConcurrentTracks } from '@signalsandsorcery/plugin-sdk';
import {
  buildPadSlotGrid,
  DEFAULT_PATTERN_ID,
  padPatternById,
  type PadSlotGrid,
} from './pad-patterns';
import {
  buildSubmitPadsParameters,
  parsePadArgs,
  SUBMIT_PADS_TOOL_NAME,
  type ParsedPads,
} from './pad-schema';
import {
  analyzePads,
  enforceVoicing,
  materializeStrikes,
  type PadNote,
} from './pad-enforce';
import { buildPadRetrySuffix, buildPadSystemPrompt } from './pad-prompt';
import {
  PAD_CONFIG_KEY,
  PAD_VOICE_META_KEY,
  asPadConfig,
  parsePromptHints,
  patchLabel,
  planReconcile,
  type PadConfig,
  type PadVoiceMeta,
  type ReconcileMember,
} from './pad-voice-meta';
import { parseChordSymbol, scalePcsFor } from './music-helpers';

export const PAD_MAX_TRACKS = 16;
export const PAD_MIN_VOICES = 1;
export const PAD_MAX_VOICES = 4;
export const DEFAULT_PAD_CONFIG: PadConfig = {
  voiceCount: 2,
  duration: 'whole',
  patternId: DEFAULT_PATTERN_ID,
  voicing: 'full',
  rests: 'off',
};
/** The generation model — tools-capable; matches the platform's BEST tier. */
export const PAD_MODEL = 'gemini-3.1-pro-preview';
/** Pitches-only schema is small — no counterpoint-sized budgets needed. */
export const PAD_MAX_OUTPUT_TOKENS = 8192;
/** Voicing choice needs less heat than counterpoint. */
export const PAD_TEMPERATURE = 0.7;

interface FilledPatch {
  /** Rotation voice index (which patch in the cycle). */
  voiceIndex: number;
  notes: PadNote[];
}

export async function generatePads(
  track: GeneratorTrackState,
  services: GenerationServices
): Promise<void> {
  const { host } = services;
  const scene = services.activeSceneId;
  if (!scene) throw new Error('No active scene — select a scene first.');
  const prompt = (track.prompt ?? '').trim();
  if (!prompt) throw new Error('Describe the pads first (e.g. "warm analog pads, 3 patches, half notes").');

  // ── group / anchor resolution (bass/ensemble shape) ────────────────────
  const groups = services.resolvedGroups<PadVoiceMeta>(PAD_VOICE_META_KEY);
  const promptedDbId = track.handle.dbId;
  const existingGroup = groups.find((g) => g.members.some((m) => m.dbId === promptedDbId)) ?? null;
  const anchorMember = existingGroup?.members.find((m) => m.meta.voiceIndex === 0);
  const anchorTrack = anchorMember ? anchorMember.track : track;
  const anchorDbId = anchorTrack.handle.dbId;
  const anchorPrompt = (anchorTrack.prompt ?? '').trim() || prompt;

  // ── config: stored (header controls) > prompt hints > defaults ────────
  const storedRaw = await host
    .getSceneData(scene, services.trackDataKey(anchorDbId, PAD_CONFIG_KEY))
    .catch(() => null);
  const stored = asPadConfig(storedRaw);
  const hints = parsePromptHints(anchorPrompt);
  const config: PadConfig = {
    voiceCount: Math.max(
      PAD_MIN_VOICES,
      Math.min(PAD_MAX_VOICES, stored?.voiceCount ?? hints.voiceCount ?? DEFAULT_PAD_CONFIG.voiceCount)
    ),
    duration: stored?.duration ?? hints.duration ?? DEFAULT_PAD_CONFIG.duration,
    patternId: stored?.patternId ?? DEFAULT_PAD_CONFIG.patternId,
    voicing: stored?.voicing ?? DEFAULT_PAD_CONFIG.voicing,
    rests: stored?.rests ?? DEFAULT_PAD_CONFIG.rests,
  };

  // ── musical context + the deterministic grid ───────────────────────────
  const musical = await host.getMusicalContext();
  const bars = musical.bars > 0 ? musical.bars : 4;
  const bpm = musical.bpm > 0 ? musical.bpm : 120;
  if (musical.chordProgression.length === 0) {
    throw new Error(
      'No chords found — generate a scene contract first (pads voice the scene\'s chord progression).'
    );
  }

  const grid = buildPadSlotGrid({
    bars,
    voiceCount: config.voiceCount,
    duration: config.duration,
    patternId: config.patternId,
    rests: config.rests,
    chordTiming: musical.chordProgression,
  });
  if (grid.voicingSlots.length === 0) {
    throw new Error('The current duration/rests settings produce only silence — relax the rests.');
  }

  // ── sibling context (tools path has NO auto-prefix) ────────────────────
  let concurrentBlock = '';
  try {
    const genCtx = await host.getGenerationContext(anchorTrack.handle.id);
    // Don't make the model write "around" its own previous patches.
    const groupDbIds = new Set((existingGroup?.members ?? []).map((m) => m.dbId));
    concurrentBlock = formatConcurrentTracks({
      ...genCtx,
      concurrentTracks: genCtx.concurrentTracks.filter(
        (t) => !(t.dbId !== undefined && groupDbIds.has(t.dbId))
      ),
    });
  } catch {
    /* sibling context is best-effort, never a gate */
  }

  const chordText = musical.chordProgression
    .map((c) => `${c.symbol} (beats ${c.startQn}-${c.endQn})`)
    .join(', ');
  const pattern = padPatternById(config.patternId);
  const contextText = [
    'Musical Context:',
    `- Key: ${musical.key} ${musical.mode}`,
    `- BPM: ${bpm}`,
    `- Bars: ${bars} (clip = ${bars * 4} quarter-note beats)`,
    musical.genre ? `- Genre: ${musical.genre}` : null,
    `- Chord Progression: ${chordText}`,
    musical.contractPrompt ? `- Scene Contract: ${musical.contractPrompt}` : null,
    `- Pad settings: ${config.voiceCount} rotating patch(es), ${config.duration} durations` +
      (config.duration === 'rhythmic' ? ` (pattern: ${pattern.label})` : '') +
      (config.rests !== 'off' && config.duration !== 'rhythmic' ? `, rests: ${config.rests}` : ''),
  ]
    .filter(Boolean)
    .join('\n');

  const systemPrompt = buildPadSystemPrompt(grid.voicingSlots, config.voicing);
  const baseUser = `${contextText}\n\n${concurrentBlock ? `${concurrentBlock}\n\n` : ''}User request: "${anchorPrompt}"`;

  // ── the joint call (+ at most ONE guided retry) ────────────────────────
  const submitDeclaration: LLMFunctionDeclaration = {
    name: SUBMIT_PADS_TOOL_NAME,
    description: `Submit one chord voicing (MIDI pitches) for each of the ${grid.voicingSlots.length} slots.`,
    parameters: buildSubmitPadsParameters(grid.voicingSlots) as LLMFunctionDeclaration['parameters'],
  };

  const callModel = async (userText: string): Promise<ParsedPads | null> => {
    const request: LLMToolUseRequest = {
      model: PAD_MODEL,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      tools: [{ functionDeclarations: [submitDeclaration] }],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [SUBMIT_PADS_TOOL_NAME] },
      },
      generationConfig: {
        temperature: PAD_TEMPERATURE,
        maxOutputTokens: PAD_MAX_OUTPUT_TOKENS,
      },
    };
    const response = await host.generateWithLLMTools(request);
    for (const candidate of response.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall && part.functionCall.name === SUBMIT_PADS_TOOL_NAME) {
          return parsePadArgs(part.functionCall.args, grid.voicingSlots.length);
        }
      }
    }
    return null;
  };

  const scalePcs = scalePcsFor(musical.key, musical.mode) ?? undefined;
  const enforceAll = (parsed: ParsedPads): number[][] =>
    grid.voicingSlots.map((slot, i) => {
      const chord = slot.chordSymbol ? parseChordSymbol(slot.chordSymbol) : null;
      return enforceVoicing(parsed.slotPitches[i], { chord, scalePcs, voicing: config.voicing })
        .pitches;
    });

  const first = await callModel(baseUser);
  if (!first) {
    throw new Error('The model returned no usable voicings — try rephrasing the prompt.');
  }
  let voicings = enforceAll(first);
  let violations = analyzePads(voicings, grid.voicingSlots);
  if (violations.length > 0) {
    const second = await callModel(baseUser + buildPadRetrySuffix(violations)).catch(() => null);
    if (second) {
      const voicingsRetry = enforceAll(second);
      const violationsRetry = analyzePads(voicingsRetry, grid.voicingSlots);
      if (violationsRetry.length < violations.length) {
        voicings = voicingsRetry;
        violations = violationsRetry;
      }
    }
  }

  // ── rotation → per-patch note arrays ───────────────────────────────────
  // Every slot got a voicing (fallback fills holes), so a patch is only
  // empty in degenerate configs (fewer base slots than patches). Empty
  // patches are not created; buckets stay compact.
  const perVoice = materializeStrikes(grid, voicings, config.duration);
  const filled: FilledPatch[] = perVoice
    .map((notes, voiceIndex) => ({ voiceIndex, notes }))
    .filter((v) => v.notes.length > 0);
  if (filled.length === 0) {
    throw new Error('No notes were produced — try different duration/rests settings.');
  }

  // ── reconcile + budget ─────────────────────────────────────────────────
  const existingMembers: ReconcileMember[] = existingGroup
    ? existingGroup.members.map((m) => ({
        dbId: m.dbId,
        engineId: m.track.handle.id,
        voiceIndex: m.meta.voiceIndex,
      }))
    : [{ dbId: anchorDbId, engineId: anchorTrack.handle.id, voiceIndex: 0 }];
  const plan = planReconcile(existingMembers, filled.length);
  const liveCount = services.tracks.length;
  if (liveCount - plan.remove.length + plan.createBucketIndexes.length > PAD_MAX_TRACKS) {
    throw new Error(
      `These pads would exceed the ${PAD_MAX_TRACKS}-track panel budget — reduce the patch count or delete tracks first.`
    );
  }

  const secondsPerBeat = 60 / bpm;
  const clipFor = (notes: PadNote[]): MidiClipData => ({
    startTime: 0,
    endTime: bars * 4 * secondsPerBeat,
    tempo: bpm,
    notes: notes.map((n) => ({
      pitch: n.pitch,
      startBeat: n.startBeat,
      durationBeats: n.durationBeats,
      velocity: n.velocity,
      channel: 0,
    })),
  });

  // ── execute: create → clips → role+mute → presets (new only) → metas ──
  const created: PluginTrackHandle[] = [];
  try {
    const memberByBucket = new Map<number, { engineId: string; dbId: string; isNew: boolean }>();
    for (const r of plan.reuse) {
      memberByBucket.set(r.bucketIndex, { engineId: r.engineId, dbId: r.dbId, isNew: false });
    }
    for (const bucketIndex of plan.createBucketIndexes) {
      const handle = await services.createFamilyTrack(`-v${bucketIndex}`);
      created.push(handle);
      memberByBucket.set(bucketIndex, { engineId: handle.id, dbId: handle.dbId, isNew: true });
    }

    // Clips FIRST (preset range-analysis reads real pitches), then role + mute.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      await host.writeMidiClip(member.engineId, clipFor(filled[i].notes));
      await host.setTrackRole(member.engineId, 'pads').catch(() => {});
      await host.setTrackMute(member.engineId, true).catch(() => {});
      if (!member.isNew) {
        services.updateTrack(member.engineId, (t) => ({
          ...t,
          runtimeState: { ...t.runtimeState, muted: true },
        }));
      }
    }

    // Presets for NEW patches only — reused patches keep the user's pick.
    // The accumulating exclude list is what makes rotation WORK: every
    // patch in the cycle must sound different.
    const appliedNames: string[] = [];
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      if (!member.isNew) continue;
      try {
        const result = await host.shufflePreset(member.engineId, appliedNames);
        appliedNames.push(result.presetName);
      } catch {
        /* non-fatal — default patch */
      }
    }

    // Metas LAST — a mid-flight failure above leaves the OLD group intact.
    for (let i = 0; i < filled.length; i++) {
      const member = memberByBucket.get(i)!;
      const meta: PadVoiceMeta = {
        groupId: anchorDbId,
        voiceIndex: i,
        label: patchLabel(i),
      };
      await host.setSceneData(scene, services.trackDataKey(member.dbId, PAD_VOICE_META_KEY), meta);
    }
    await host.setSceneData(scene, services.trackDataKey(anchorDbId, PAD_CONFIG_KEY), config);

    // Surplus patches: delete track + its group/soundHistory keys.
    for (const surplus of plan.remove) {
      await host.deleteTrack(surplus.engineId).catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, PAD_VOICE_META_KEY))
        .catch(() => {});
      await host
        .deleteSceneData(scene, services.trackDataKey(surplus.dbId, 'soundHistory'))
        .catch(() => {});
    }
  } catch (err) {
    // LIFO rollback — remove any tracks created this pass, newest first.
    for (const handle of [...created].reverse()) {
      try {
        await host.deleteTrack(handle.id);
      } catch {
        /* best effort */
      }
      await host
        .deleteSceneData(scene, services.trackDataKey(handle.dbId, PAD_VOICE_META_KEY))
        .catch(() => {});
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // ── success patch on the anchor + reload ──────────────────────────────
  services.updateTrack(anchorTrack.handle.id, (t) => ({
    ...t,
    isGenerating: false,
    error: null,
    role: 'pads',
    hasMidi: true,
    generationProgress: 0,
    editNotes: clipFor(filled[0].notes).notes,
    editBars: bars,
    editBpm: bpm,
  }));
  services.markEditLoaded(anchorTrack.handle.id);
  host.showToast(
    'success',
    'Pads generated',
    `${filled.length} patch${filled.length === 1 ? '' : 'es'} · ${config.duration}` +
      (config.duration === 'rhythmic' ? ` (${pattern.label})` : '') +
      (violations.length > 0 ? ` · ${violations.length} soft rule note(s)` : '')
  );
  await services.reloadTracks(true);
}
