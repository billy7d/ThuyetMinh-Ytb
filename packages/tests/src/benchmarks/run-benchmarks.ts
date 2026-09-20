import { BENCHMARK_DATASET } from './benchmark-dataset.js';
import {
  DeterministicTranslationProvider,
  TranslationEngine,
  VietnameseTTSEngine
} from '@vietdub/backend';
import { FixtureTTSProvider } from '../fixtures/providers.js';

/**
 * This command is intentionally fixture-only. It is useful for checking the
 * benchmark harness and deterministic translation fixtures, but its timings
 * and scores must never be presented as live provider or browser evidence.
 */
async function runFixtureBenchmark(): Promise<void> {
  const translationEngine = new TranslationEngine(new DeterministicTranslationProvider());
  const ttsEngine = new VietnameseTTSEngine(new FixtureTTSProvider());
  const rows: Array<{ id: string; translationMs: number; ttsMs: number; translatedText: string }> = [];

  for (const sample of BENCHMARK_DATASET) {
    const translationStart = Date.now();
    const translation = await translationEngine.translate(sample.sourceText, 0, 1000);
    const translationMs = Date.now() - translationStart;
    const translatedText = translation.translatedText || sample.referenceVietnamese;

    const ttsStart = Date.now();
    await ttsEngine.synthesize({
      segmentId: sample.id,
      text: translatedText,
      generation: 1,
      startMs: 0,
      endMs: 1000
    });
    rows.push({
      id: sample.id,
      translationMs,
      ttsMs: Date.now() - ttsStart,
      translatedText
    });
  }

  console.log(JSON.stringify({
    status: 'FIXTURE_ONLY_NOT_PRODUCTION_EVIDENCE',
    sampleCount: rows.length,
    sttMs: null,
    rows
  }, null, 2));
}

runFixtureBenchmark().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
