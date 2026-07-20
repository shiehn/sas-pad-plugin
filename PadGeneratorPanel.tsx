/**
 * Pad panel — a thin GeneratorPanelAdapter over the SDK panel-core (the
 * ensemble plugin's container with a different brain and, unlike ensemble,
 * a Transition Designer). One voice-group per pad stack: the anchor
 * (voice 0) carries the prompt; the group header adds the five explicit
 * intent controls — patches (1-4), duration (whole / half / rhythmic),
 * rhythmic pattern, voicing (full / partial), and rests — persisted in
 * scene-data under the anchor (`track:<anchorDbId>:padConfig`).
 *
 * Per-patch sound choice stays mechanical: each patch's 'pads' role + its
 * actual register drive shufflePreset's category pick (Pads-Hi / Pads-Low /
 * Drones), exactly like every other generator.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type {
  PluginUIProps,
  PluginHost,
  PluginTrackHandle,
  GeneratorPanelAdapter,
  GeneratorTrackState,
  GroupRenderContext,
  ResolvedTrackGroup,
} from '@signalsandsorcery/plugin-sdk';
import {
  GeneratorPanelShell,
  useGeneratorPanelCore,
  createSurgeSoundAdapter,
  ConfirmDialog,
  parseLLMNoteResponse,
  promptEnterToGenerate,
} from '@signalsandsorcery/plugin-sdk';
import {
  PAD_DURATION_MODES,
  PAD_PATTERNS,
  PAD_RESTS_MODES,
  PAD_VOICING_MODES,
  buildPadSlotGrid,
  type PadDurationMode,
  type PadRestsMode,
  type PadVoicingMode,
} from './src/pad-patterns';
import {
  PAD_CONFIG_KEY,
  PAD_VOICE_META_KEY,
  asPadConfig,
  padGroupIsComplete,
  padVoiceGroupSpec,
  stampPadAnchor,
  type PadConfig,
  type PadVoiceMeta,
} from './src/pad-voice-meta';
import {
  generatePads,
  DEFAULT_PAD_CONFIG,
  PAD_MAX_TRACKS,
  PAD_MAX_VOICES,
  PAD_MIN_VOICES,
} from './src/pad-generation';
import { buildPadSystemPrompt } from './src/pad-prompt';
import { createPadTransitionGroupAdapter } from './src/pad-transition';

const ESTIMATED_GENERATION_MS = 25000; // one joint call + a possible guided retry

// ============================================================================
// Group row — header (prompt + five controls + Generate + M/S/✕), patch rows
// ============================================================================

function PadVoiceGroupRow({
  group,
  ctx,
}: {
  group: ResolvedTrackGroup<PadVoiceMeta, GeneratorTrackState>;
  ctx: GroupRenderContext;
}): React.ReactElement {
  const anchor = group.members.find((m) => m.meta.voiceIndex === 0) ?? group.members[0];
  const anchorTrack = anchor.track;
  const scene = ctx.services.activeSceneId;
  const host = ctx.services.host;
  const configKey = ctx.services.trackDataKey(anchor.dbId, PAD_CONFIG_KEY);

  const [config, setConfig] = useState<PadConfig>(DEFAULT_PAD_CONFIG);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!scene) return undefined;
    void host
      .getSceneData(scene, configKey)
      .then((raw) => {
        const cfg = asPadConfig(raw);
        if (cfg && !cancelled) {
          setConfig({
            ...cfg,
            voiceCount: Math.max(PAD_MIN_VOICES, Math.min(PAD_MAX_VOICES, cfg.voiceCount)),
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [host, scene, configKey]);

  const updateConfig = (patch: Partial<PadConfig>): void => {
    const next = { ...config, ...patch };
    setConfig(next);
    if (scene) void host.setSceneData(scene, configKey, next).catch(() => {});
  };

  const memberEngineIds = group.members.map((m) => m.track.handle.id);
  const allMuted = group.members.every((m) => m.track.runtimeState.muted);
  const anySolo = group.members.some((m) => m.track.runtimeState.solo);
  const isGenerating = group.members.some((m) => m.track.isGenerating);
  const generateDisabled = isGenerating || !anchorTrack.prompt.trim();
  const isRhythmic = config.duration === 'rhythmic';

  const selectClass =
    'text-xs bg-sas-panel border border-sas-border rounded-sm px-1 py-0.5 text-sas-text';

  return (
    <div
      data-testid={`pad-group-${group.groupId}`}
      className="rounded-sm border border-sas-border bg-sas-panel-alt overflow-hidden"
      style={{ borderLeftColor: '#14B8A6', borderLeftWidth: '3px' }}
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-sas-border flex-wrap">
        <span className="text-[9px] uppercase tracking-wide text-sas-muted whitespace-nowrap">
          Pads · {group.members.length} {group.members.length === 1 ? 'patch' : 'patches'}
        </span>
        <input
          type="text"
          value={anchorTrack.prompt}
          placeholder="Describe the pads…"
          onChange={(e) => ctx.handlers.promptChange(anchorTrack.handle.id, e.target.value)}
          onKeyDown={promptEnterToGenerate(
            () => ctx.handlers.generate(anchorTrack.handle.id),
            generateDisabled
          )}
          className="flex-1 min-w-[120px] bg-sas-panel border border-sas-border rounded-sm px-2 py-0.5 text-xs text-sas-text placeholder:text-sas-muted/50 focus:border-sas-accent focus:outline-none"
          data-testid="pad-group-prompt"
        />
        <select
          value={config.voiceCount}
          onChange={(e) => updateConfig({ voiceCount: parseInt(e.target.value, 10) })}
          title="Rotating patches — bar 1 → patch A, bar 2 → patch B, …"
          className={selectClass}
          data-testid="pad-voice-count"
        >
          {Array.from(
            { length: PAD_MAX_VOICES - PAD_MIN_VOICES + 1 },
            (_, i) => PAD_MIN_VOICES + i
          ).map((n) => (
            <option key={n} value={n}>
              {n} {n === 1 ? 'patch' : 'patches'}
            </option>
          ))}
        </select>
        <select
          value={config.duration}
          onChange={(e) => updateConfig({ duration: e.target.value as PadDurationMode })}
          title="Pad duration"
          className={selectClass}
          data-testid="pad-duration"
        >
          {PAD_DURATION_MODES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        {isRhythmic && (
          <select
            value={config.patternId}
            onChange={(e) => updateConfig({ patternId: e.target.value })}
            title="Rhythmic pattern (tiles per bar)"
            className={selectClass}
            data-testid="pad-pattern"
          >
            {PAD_PATTERNS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        <select
          value={config.voicing}
          onChange={(e) => updateConfig({ voicing: e.target.value as PadVoicingMode })}
          title="Full (4-5 notes, colors) vs partial (2-3 guide tones)"
          className={selectClass}
          data-testid="pad-voicing"
        >
          {PAD_VOICING_MODES.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          value={config.rests}
          onChange={(e) => updateConfig({ rests: e.target.value as PadRestsMode })}
          disabled={isRhythmic}
          title={
            isRhythmic
              ? 'The rhythmic pattern owns its rests'
              : 'Rests — sparse (breath every 4th slot) or half-bar (play the first half only)'
          }
          className={`${selectClass} ${isRhythmic ? 'opacity-40 cursor-not-allowed' : ''}`}
          data-testid="pad-rests"
        >
          {PAD_RESTS_MODES.map((r) => (
            <option key={r} value={r}>
              rests: {r}
            </option>
          ))}
        </select>
        <button
          onClick={() => ctx.handlers.generate(anchorTrack.handle.id)}
          disabled={generateDisabled}
          title="Regenerate the whole pad stack"
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            generateDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          data-testid="pad-generate"
        >
          {isGenerating ? 'Generating…' : 'Generate'}
        </button>
        <button
          onClick={() => ctx.setGroupMute(memberEngineIds, !allMuted)}
          title="Mute group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            allMuted
              ? 'bg-red-500/20 border-red-500/40 text-red-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          M
        </button>
        <button
          onClick={() => ctx.setGroupSolo(memberEngineIds, !anySolo)}
          title="Solo group"
          className={`px-1.5 py-0.5 text-[10px] font-bold rounded-sm border transition-colors ${
            anySolo
              ? 'bg-yellow-500/20 border-yellow-500/40 text-yellow-400'
              : 'bg-sas-panel border-sas-border text-sas-muted hover:border-sas-accent'
          }`}
        >
          S
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          title="Delete pads"
          className="px-1.5 py-0.5 text-[10px] rounded-sm border border-sas-border text-sas-muted hover:border-red-500/60 hover:text-red-400 transition-colors"
        >
          ✕
        </button>
      </div>

      <div className="p-1 space-y-1">
        {group.members.map((m) =>
          ctx.renderDefaultTrackRow(m.track, {
            // The prompt field shows the MECHANICAL patch label ("patch A");
            // the pad intent lives on the group header (the anchor's prompt
            // key). Patch count is owned by the header dropdown, so per-patch
            // generate/delete/copy are off (the group owns those).
            prompt: m.meta.label || 'pad patch',
            onPromptChange: undefined,
            onGenerate: undefined,
            onCopy: undefined,
            onDelete: undefined,
          })
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete pads?"
          message={`Removes all ${group.members.length} patch tracks of this pad stack.`}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirmDelete(false);
            void ctx.deleteGroup(
              group.members.map((m) => ({ engineId: m.track.handle.id, dbId: m.dbId })),
              [PAD_VOICE_META_KEY, PAD_CONFIG_KEY, 'prompt', 'soundHistory', 'role']
            );
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Adapter + panel
// ============================================================================

function createPadGeneratorAdapter(host: PluginHost): GeneratorPanelAdapter<PadVoiceMeta> {
  const surgeSound = createSurgeSoundAdapter(host);
  return {
    identity: {
      familyKey: 'pads',
      familyLabel: 'Pads',
      trackNamePrefix: 'pad',
      logTag: 'PadGeneratorPanel',
      accentColor: '#14B8A6',
      transitionAccentColor: '#9333EA',
      placeholderAccentColor: '#6366F1',
      maxTracks: PAD_MAX_TRACKS,
      estimatedGenerationMs: ESTIMATED_GENERATION_MS,
      addTrackLabel: 'Add Pads',
    },
    features: {
      instrumentPicker: true,
      bulkComposePlaceholders: false,
      exportMidi: true,
      transitionDesigner: true,
      importTracks: false,
    },
    createTrackOptions: () => ({ loadSynth: true, synthName: 'Surge XT' }),
    // Anchor every newborn as a group of ONE so the header's intent controls
    // (patches / duration / pattern / voicing / rests) exist BEFORE the first
    // generation — never make the user burn a generation to reach a control.
    onTrackCreated: async (handle, ctx) => {
      await stampPadAnchor(host, ctx.activeSceneId, ctx.trackDataKey, handle.dbId);
    },
    applyPortedTrackSound: async (handle: PluginTrackHandle) => {
      try {
        await host.shufflePreset(handle.id);
      } catch {
        /* non-fatal */
      }
    },
    // The core's generic path wants a system prompt; the real generation goes
    // through generatePads (schema-forced tools call), so this is only a
    // sane fallback shape.
    buildSystemPrompt: () =>
      buildPadSystemPrompt(
        buildPadSlotGrid({
          bars: 4,
          voiceCount: DEFAULT_PAD_CONFIG.voiceCount,
          duration: DEFAULT_PAD_CONFIG.duration,
          rests: DEFAULT_PAD_CONFIG.rests,
          chordTiming: [],
        }).voicingSlots,
        DEFAULT_PAD_CONFIG.voicing
      ),
    parseNotesResponse: parseLLMNoteResponse,
    sound: surgeSound,
    shuffle: {
      shuffle: async (track, excludeNames) => {
        const result = await host.shufflePreset(track.handle.id, excludeNames, {
          description: track.prompt,
        });
        return { appliedName: result.presetName };
      },
      isExhaustedError: (err) =>
        /no presets available/i.test(err instanceof Error ? err.message : String(err)),
    },
    generation: { generate: generatePads },
    groupExtensions: [
      {
        ...padVoiceGroupSpec,
        isComplete: padGroupIsComplete,
        renderGroup: (group, ctx) => <PadVoiceGroupRow group={group} ctx={ctx} />,
      },
    ],
    transitionGroup: createPadTransitionGroupAdapter(host),
  };
}

export function PadGeneratorPanel(props: PluginUIProps): React.ReactElement {
  const adapter = useMemo(() => createPadGeneratorAdapter(props.host), [props.host]);
  const core = useGeneratorPanelCore({ ui: props, adapter: adapter as GeneratorPanelAdapter });
  return <GeneratorPanelShell core={core} />;
}

export default PadGeneratorPanel;
