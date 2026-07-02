'use strict';
// Minimal HTTP/HTTPS forward proxy that only allows CONNECT (and absolute-URI
// HTTP) requests to an explicit domain allowlist. Everything else gets 403.
//
// This does NOT terminate TLS - CONNECT tunnels are blind byte pipes, same
// approach documented for Claude Code's own built-in sandbox proxy. That
// means it allowlists by hostname only, not by inspecting encrypted payloads.
const http = require('http');
const net = require('net');
const { URL } = require('url');

const PORT = parseInt(process.env.PROXY_PORT || '8888', 10);
const RAW_ALLOWLIST = process.env.ALLOWED_DOMAINS || '';

const allowlist = RAW_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);

if (allowlist.length === 0) {
  console.error('ALLOWED_DOMAINS is empty - refusing to start (would allow nothing, which is safe, but is almost certainly a config mistake)');
  process.exit(1);
}

function isAllowed(host) {
  const h = host.toLowerCase();
  return allowlist.some((domain) => h === domain || h.endsWith('.' + domain));
}

function log(action, host, port) {
  const line = `[egress-proxy] ${action} ${host}:${port}`;
  console.log(line);
}

const server = http.createServer((req, res) => {
  // Plain HTTP absolute-URI requests (rare in practice; almost everything
  // relevant uses HTTPS/CONNECT) - filtered the same way.
  let target;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const host = target.hostname;
  const port = target.port || 80;
  if (!isAllowed(host)) {
    log('DENY', host, port);
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Host not allowed: ${host}\n`);
    return;
  }
  log('ALLOW', host, port);
  const upstream = http.request(target, { headers: req.headers, method: req.method }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', () => res.destroy());
  req.pipe(upstream);
});

server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  if (!isAllowed(host)) {
    log('DENY', host, port);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  log('ALLOW', host, port);

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => {
  console.log(`[egress-proxy] listening on :${PORT}, allowlist: ${allowlist.join(', ')}`);
});
