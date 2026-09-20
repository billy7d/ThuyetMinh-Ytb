import {
  DeterministicTranslationProvider,
  MockSTTProvider,
  ProductionPipelineDependencies,
  ProductionProviderFactory,
  TranslationEngine
} from '@vietdub/backend';
import { FixtureTTSProvider } from './providers.js';

/** Test-only factory for gateway integration tests; never used by production startup. */
export function createFixtureProviderFactory(
  sentences?: string[]
): ProductionProviderFactory {
  return {
    mode: 'local',
    missingConfiguration: [],
    getStatus() {
      return { mode: 'local', configured: true, missingConfiguration: [] };
    },
    create(): ProductionPipelineDependencies {
      return {
        sttProvider: new MockSTTProvider(sentences),
        translationEngine: new TranslationEngine(new DeterministicTranslationProvider()),
        ttsProvider: new FixtureTTSProvider(),
        budgetConfig: {
          costMode: 'local',
          maxCostPerSessionUsd: 2,
          maxSessionMinutes: 30,
          rateLimitChunksPerSecond: 10
        }
      };
    }
  };
}
