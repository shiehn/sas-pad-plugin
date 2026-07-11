/**
 * @signalsandsorcery/pad-generator — plugin entry.
 *
 * Pad generator: the scene's chord progression voiced as sustained pads
 * that ROTATE across 1-4 Surge XT patches (bar 1 → patch A, bar 2 →
 * patch B, …). One schema-forced LLM call picks the voicings (smooth
 * voice-leading); the deterministic grid owns ALL timing — whole / half /
 * rhythmic-pattern durations, full or partial voicings, rests. Each patch
 * lands on its own Surge XT track as one voice-group, with verbatim group
 * fades in the Transition Designer. See PadGeneratorPanel.tsx and
 * src/pad-generation.ts.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
} from '@signalsandsorcery/plugin-sdk';
import { PadGeneratorPanel } from './PadGeneratorPanel';
import manifest from './plugin.json';

class PadGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/pad-generator';
  readonly displayName = 'Pads';
  readonly version = '1.0.0';
  readonly description =
    'Pad generator — the scene\'s chords voiced as sustained pads that rotate across 1-4 Surge XT patches (whole / half / rhythmic durations, full or partial voicings, rests), with verbatim group fades in the Transition Designer';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[PadGeneratorPlugin] activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return PadGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }
}

export default PadGeneratorPlugin;
export { PadGeneratorPlugin, PadGeneratorPanel };
export const padManifest = manifest;
