import http from 'node:http';
import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { WebSocketGateway } from './gateway/ws-gateway.js';
import { ProductionProviderFactory, ProviderFactoryStatus } from './provider-factory.js';

export function createServer(
  port = 8080,
  options: { providerFactory?: ProductionProviderFactory } = {}
): { server: http.Server; gateway: WebSocketGateway } {
  let gateway: WebSocketGateway;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const providerStatus: ProviderFactoryStatus = gateway?.getProviderStatus() || {
        mode: 'local',
        configured: false,
        missingConfiguration: ['Backend is still starting']
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      if (origin && isAllowedLocalOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      res.writeHead(providerStatus.configured ? 200 : 503, headers);
      res.end(JSON.stringify({
        status: providerStatus.configured ? 'ok' : 'not_configured',
        providers: providerStatus,
        time: new Date().toISOString()
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: 256 * 1024,
    verifyClient: ({ origin }, done) => {
      if (isAllowedLocalOrigin(origin)) {
        done(true);
        return;
      }
      done(false, 403, 'Origin is not allowed for the loopback AI backend');
    }
  });
  gateway = new WebSocketGateway(wss, options);

  return { server, gateway };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.PORT) || 8080;
  const { server } = createServer(port);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[VietDub Backend] WebSocket AI Gateway listening on port ${port}`);
  });
}

function isAllowedLocalOrigin(origin?: string): boolean {
  // Node-based local clients do not send Origin. Browser requests are limited
  // to extension schemes and loopback pages; no wildcard/CORS origin is used.
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  } catch {
    return false;
  }
}
