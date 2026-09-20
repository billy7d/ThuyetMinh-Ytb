import http from 'node:http';
import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { WebSocketGateway } from './gateway/ws-gateway.js';

export function createServer(port = 8080): { server: http.Server; gateway: WebSocketGateway } {
  let gateway: WebSocketGateway;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const providerStatus = gateway?.getProviderStatus() || { configured: false, missingConfiguration: [] };
      res.writeHead(providerStatus.configured ? 200 : 503, { 'Content-Type': 'application/json' });
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

  const wss = new WebSocketServer({ server });
  gateway = new WebSocketGateway(wss);

  return { server, gateway };
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const port = Number(process.env.PORT) || 8080;
  const { server } = createServer(port);
  server.listen(port, () => {
    console.log(`[VietDub Backend] WebSocket AI Gateway listening on port ${port}`);
  });
}
