import { createServer } from '@vietdub/backend';
import { createFixtureProviderFactory } from '../../fixtures/provider-factory.js';

const port = Number(process.env.PORT || 0);
const { server } = createServer(port, {
  providerFactory: createFixtureProviderFactory([
    "Let's break it down.",
    "That's not the whole story."
  ])
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[VietDub E2E Fixture Backend] listening on ${port}`);
});
