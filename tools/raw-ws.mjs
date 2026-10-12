/*
  Minimal RFC6455 WebSocket server, zero dependencies.

  The bundled Node runtime has no node_modules, and Node's built-in WebSocket
  is client-only, so the mock OBS server needs its own server implementation.
  Only what the mock needs is implemented: text frames, fragmentation, ping,
  close, and the 16/64-bit length forms.

  Usage:  import { createRawWSServer } from './raw-ws.mjs';
*/
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-5AB0DC85B11F';

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Encode a server->client frame (never masked). */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

export function createRawWSServer({ host = '127.0.0.1', port }) {
  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only\n');
  });

  const listeners = { connection: [], listening: [], error: [] };
  const emit = (name, ...args) => listeners[name].forEach((fn) => fn(...args));

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const ws = {
      readyState: 1,
      send(data) {
        if (ws.readyState !== 1) return;
        const payload = Buffer.from(String(data), 'utf8');
        socket.write(encodeFrame(0x1, payload));
      },
      close(code = 1000, reason = '') {
        if (ws.readyState !== 1) return;
        ws.readyState = 2;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try {
          socket.write(encodeFrame(0x8, body));
        } catch {}
        socket.end();
      },
      on(event, fn) {
        (ws._handlers[event] ||= []).push(fn);
        return ws;
      },
      _handlers: {},
      _emit(event, ...args) {
        (ws._handlers[event] || []).forEach((fn) => fn(...args));
      },
    };

    emit('connection', ws, req);

    // ---- frame parsing ----
    let buf = Buffer.alloc(0);
    const fragments = [];
    let fragmentOpcode = 0;

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      for (;;) {
        if (buf.length < 2) return;

        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }

        let mask = null;
        if (masked) {
          if (buf.length < offset + 4) return;
          mask = buf.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buf.length < offset + len) return;

        let payload = Buffer.from(buf.subarray(offset, offset + len));
        buf = buf.subarray(offset + len);

        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

        if (opcode === 0x8) {
          ws.readyState = 3;
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          ws._emit('close', { code, reason });
          socket.end();
          return;
        }

        if (opcode === 0x9) {
          socket.write(encodeFrame(0xa, payload));
          continue;
        }

        if (opcode === 0xa) continue;

        if (opcode === 0x0) {
          fragments.push(payload);
        } else {
          fragmentOpcode = opcode;
          fragments.length = 0;
          fragments.push(payload);
        }

        if (fin) {
          const full = Buffer.concat(fragments);
          fragments.length = 0;
          if (fragmentOpcode === 0x1) ws._emit('message', full.toString('utf8'));
        }
      }
    });

    socket.on('close', () => {
      if (ws.readyState === 1) {
        ws.readyState = 3;
        ws._emit('close', { code: 1006, reason: 'connection lost' });
      }
    });

    socket.on('error', () => {
      if (ws.readyState === 1) {
        ws.readyState = 3;
        ws._emit('close', { code: 1006, reason: 'socket error' });
      }
    });
  });

  server.listen(port, host, () => emit('listening'));

  return {
    on(event, fn) {
      (listeners[event] ||= []).push(fn);
      return this;
    },
    close() {
      server.close();
    },
    get server() {
      return server;
    },
  };
}
