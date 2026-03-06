/**
 * DeviceChat MCP Bridge Server
 *
 * Implements the Model Context Protocol (MCP) over HTTP/SSE so that
 * Chrome Canary's built-in WebMCP client can discover and call ESP32
 * devices as first-class MCP tools.
 *
 * MCP Transport: HTTP + Server-Sent Events  (per MCP spec §3)
 *   POST /mcp          — client → server JSON-RPC messages
 *   GET  /mcp/sse      — server → client SSE event stream
 *
 * Device registration: Socket.IO (WebSerial bridge page)
 * Admin control:       Socket.IO (admin page)
 * Participant chat:    Socket.IO (participant page, also MCP client)
 *
 * Each connected ESP32 device exposes these MCP tools:
 *   <deviceName>_display      (text, line?)
 *   <deviceName>_clear
 *   <deviceName>_scroll       (text)
 *   <deviceName>_ping
 *   <deviceName>_get_status
 *   <deviceName>_set_brightness (value)
 *
 * Plus cross-device tools:
 *   list_devices
 *   broadcast_display         (text)
 */

const express   = require('express');
const http      = require('http');
const path      = require('path');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use('/pages', express.static(path.join(__dirname, 'pages')));

// ─────────────────────────────────────────────────────────────
//  Global state
// ─────────────────────────────────────────────────────────────

/**
 * rooms[roomName] = {
 *   password, adminIds[], logs[],
 *   devices: { socketId: DeviceRecord },
 *   participants: { socketId: ParticipantRecord },
 *   mcpSseClients: Map<clientId, res>   // SSE streams for MCP clients
 * }
 */
const rooms = {};

/** deviceRecord = { id, name, roomName, capabilities[], lastSeen } */
/** participantRecord = { id, name, roomName } */

// ─────────────────────────────────────────────────────────────
//  MCP Protocol helpers
// ─────────────────────────────────────────────────────────────

const MCP_VERSION = '2024-11-05';

function mcpResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function mcpError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Build the MCP tool list for a given room.
 * Each device contributes a set of tools named  <deviceName>_<action>
 */
function buildToolList(room) {
  const tools = [];

  // ── Cross-room utility tools ────────────────────────────
  tools.push({
    name: 'list_devices',
    description: 'List all currently connected ESP32 devices in this room with their status.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  });

  if (room) {
    const devs = Object.values(room.devices);

    if (devs.length > 0) {
      tools.push({
        name: 'broadcast_display',
        description: 'Send a text message to ALL connected ESP32 device OLED displays simultaneously.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to show on all OLEDs (max ~60 chars)' }
          },
          required: ['text']
        }
      });
    }

    // Per-device tools
    for (const dev of devs) {
      const n = safeName(dev.name);
      tools.push(
        {
          name: `${n}_display`,
          description: `Show text on the OLED display of device "${dev.name}". Supports up to 5 lines.`,
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to display (use \\n for multiple lines)' },
              line: { type: 'integer', description: 'Starting line number 0-4 (default 0)', minimum: 0, maximum: 4 }
            },
            required: ['text']
          }
        },
        {
          name: `${n}_clear`,
          description: `Clear the OLED display on device "${dev.name}".`,
          inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
          name: `${n}_scroll`,
          description: `Scroll a text marquee across the OLED display of device "${dev.name}".`,
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Text to scroll across the display' }
            },
            required: ['text']
          }
        },
        {
          name: `${n}_ping`,
          description: `Ping device "${dev.name}" and get latency + uptime stats.`,
          inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
          name: `${n}_get_status`,
          description: `Get full status from device "${dev.name}": chip model, free heap, CPU freq, uptime, SDK version.`,
          inputSchema: { type: 'object', properties: {}, required: [] }
        },
        {
          name: `${n}_set_brightness`,
          description: `Set OLED display brightness on device "${dev.name}" (0=off, 255=max).`,
          inputSchema: {
            type: 'object',
            properties: {
              value: { type: 'integer', description: 'Brightness 0-255', minimum: 0, maximum: 255 }
            },
            required: ['value']
          }
        }
      );
    }
  }

  return tools;
}

/** Build MCP resources list — expose device status as readable resources */
function buildResourceList(room) {
  const resources = [];
  if (!room) return resources;
  for (const dev of Object.values(room.devices)) {
    resources.push({
      uri: `device://${safeName(dev.name)}/status`,
      name: `${dev.name} Status`,
      description: `Live status of ESP32 device "${dev.name}"`,
      mimeType: 'application/json'
    });
  }
  return resources;
}

function safeName(name) {
  return (name || 'device').toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// ─────────────────────────────────────────────────────────────
//  MCP HTTP/SSE endpoints
//  These are per-room:  /room/:roomName/mcp  and  /room/:roomName/mcp/sse
// ─────────────────────────────────────────────────────────────

/** GET /room/:room/mcp/sse  — open SSE stream, send initial capabilities */
app.get('/room/:roomName/mcp/sse', (req, res) => {
  const { roomName } = req.params;
  const room = rooms[roomName];
  if (!room) { res.status(404).json({ error: 'Room not found' }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const clientId = randomUUID();
  room.mcpSseClients.set(clientId, res);
  roomLog(roomName, `MCP SSE client connected: ${clientId.slice(0,8)}`, 'mcp');

  // Send MCP initialize notification so client knows server is ready
  sendSse(res, 'message', {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {}
  });

  // Keep-alive ping every 15s
  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(keepAlive); }
  }, 15000);

  req.on('close', () => {
    room.mcpSseClients.delete(clientId);
    clearInterval(keepAlive);
    roomLog(roomName, `MCP SSE client disconnected: ${clientId.slice(0,8)}`, 'mcp');
  });
});

/** POST /room/:room/mcp  — receive JSON-RPC from MCP client */
app.post('/room/:roomName/mcp', async (req, res) => {
  const { roomName } = req.params;
  const room = rooms[roomName];

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!room) { res.status(404).json(mcpError(null, -32000, 'Room not found')); return; }

  const msg = req.body;
  if (!msg || msg.jsonrpc !== '2.0') {
    res.status(400).json(mcpError(null, -32600, 'Invalid JSON-RPC'));
    return;
  }

  const { id, method, params } = msg;

  // ── MCP method dispatch ──────────────────────────────────
  switch (method) {

    case 'initialize': {
      res.json(mcpResponse(id, {
        protocolVersion: MCP_VERSION,
        capabilities: {
          tools:     { listChanged: true },
          resources: { listChanged: true, subscribe: false },
          prompts:   {}
        },
        serverInfo: { name: 'DeviceChat MCP Bridge', version: '2.0.0' }
      }));
      break;
    }

    case 'tools/list': {
      res.json(mcpResponse(id, { tools: buildToolList(room) }));
      break;
    }

    case 'resources/list': {
      res.json(mcpResponse(id, { resources: buildResourceList(room) }));
      break;
    }

    case 'resources/read': {
      const uri = params?.uri || '';
      const match = uri.match(/^device:\/\/([^/]+)\/status$/);
      if (!match) { res.json(mcpError(id, -32002, 'Unknown resource')); break; }
      const devKey = match[1];
      const dev = Object.values(room.devices).find(d => safeName(d.name) === devKey);
      if (!dev) { res.json(mcpError(id, -32002, 'Device not found')); break; }
      res.json(mcpResponse(id, {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            name: dev.name,
            id: dev.id,
            lastSeen: dev.lastSeen,
            uptime: dev.lastStatus?.uptime || null,
            freeHeap: dev.lastStatus?.free_heap || null,
            chip: dev.lastStatus?.chip || 'ESP32S3'
          }, null, 2)
        }]
      }));
      break;
    }

    case 'tools/call': {
      const toolName = params?.name || '';
      const args     = params?.arguments || {};
      const result   = await dispatchTool(room, roomName, toolName, args);
      res.json(mcpResponse(id, result));
      break;
    }

    case 'prompts/list': {
      res.json(mcpResponse(id, {
        prompts: [
          {
            name: 'device_dashboard',
            description: 'Get a summary of all connected devices and suggest useful commands',
            arguments: []
          }
        ]
      }));
      break;
    }

    case 'prompts/get': {
      const devList = Object.values(room.devices).map(d =>
        `- ${d.name} (last seen: ${d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : 'unknown'})`
      ).join('\n') || '  (no devices connected)';
      const toolList = buildToolList(room).map(t => `- ${t.name}: ${t.description}`).join('\n');
      res.json(mcpResponse(id, {
        description: 'Device Dashboard Context',
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `You are controlling IoT devices via MCP tools.\n\nConnected devices:\n${devList}\n\nAvailable tools:\n${toolList}\n\nHelp the user interact with these devices naturally.`
          }
        }]
      }));
      break;
    }

    default:
      res.json(mcpError(id, -32601, `Method not found: ${method}`));
  }
});

app.options('/room/:roomName/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────
//  Tool dispatch — executes MCP tool calls → sends to ESP32
// ─────────────────────────────────────────────────────────────

async function dispatchTool(room, roomName, toolName, args) {
  // ── list_devices ─────────────────────────────────────────
  if (toolName === 'list_devices') {
    const devs = Object.values(room.devices);
    if (!devs.length) {
      return { content: [{ type: 'text', text: 'No devices currently connected.' }] };
    }
    const lines = devs.map(d =>
      `• **${d.name}** — last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleTimeString() : '?'}` +
      (d.lastStatus ? `, uptime ${d.lastStatus.uptime}s, heap ${d.lastStatus.free_heap}` : '')
    ).join('\n');
    return { content: [{ type: 'text', text: `Connected devices (${devs.length}):\n${lines}` }] };
  }

  // ── broadcast_display ────────────────────────────────────
  if (toolName === 'broadcast_display') {
    const devs = Object.values(room.devices);
    if (!devs.length) return { content: [{ type: 'text', text: 'No devices connected.' }] };
    const payload = { cmd: 'display', text: args.text || '', line: 0 };
    devs.forEach(d => io.to(d.id).emit('incomingJSON', { type: 'mcp_tool', from: 'AI', payload }));
    broadcastToRoom(roomName, 'mcpToolCall', { tool: toolName, args, result: 'sent to all devices' });
    roomLog(roomName, `MCP broadcast_display → all ${devs.length} devices`, 'mcp');
    return { content: [{ type: 'text', text: `Displayed "${args.text}" on ${devs.length} device(s).` }] };
  }

  // ── Per-device tool  <devName>_<action> ──────────────────
  const devs = Object.values(room.devices);
  for (const dev of devs) {
    const prefix = safeName(dev.name) + '_';
    if (!toolName.startsWith(prefix)) continue;
    const action = toolName.slice(prefix.length);

    let payload;
    switch (action) {
      case 'display':
        payload = { cmd: 'display', text: args.text || '', line: args.line ?? 0 };
        break;
      case 'clear':
        payload = { cmd: 'clear_display' };
        break;
      case 'scroll':
        payload = { cmd: 'scroll_text', text: args.text || '' };
        break;
      case 'ping':
        payload = { cmd: 'ping', ts: Date.now() };
        break;
      case 'get_status':
        payload = { cmd: 'get_status' };
        break;
      case 'set_brightness':
        payload = { cmd: 'set_brightness', value: args.value ?? 128 };
        break;
      default:
        return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
    }

    // Send to device via Socket.IO → bridge → WebSerial → ESP32
    io.to(dev.id).emit('incomingJSON', { type: 'mcp_tool', from: 'AI/MCP', payload });
    broadcastToRoom(roomName, 'mcpToolCall', { tool: toolName, args, deviceName: dev.name });
    roomLog(roomName, `MCP tool "${toolName}" → device "${dev.name}"`, 'mcp');

    // For ping/status, wait briefly for device reply (best-effort)
    if (action === 'ping' || action === 'get_status') {
      const reply = await waitForDeviceReply(dev.id, 3000);
      if (reply) {
        dev.lastStatus = reply;
        return { content: [{ type: 'text', text: JSON.stringify(reply, null, 2) }] };
      }
      return { content: [{ type: 'text', text: `Command sent to "${dev.name}" — no reply within 3s.` }] };
    }

    return { content: [{ type: 'text', text: `Command "${action}" sent to device "${dev.name}".` }] };
  }

  return { content: [{ type: 'text', text: `Tool not found: ${toolName}` }], isError: true };
}

/** Wait up to `timeout` ms for a device reply via event emitter */
function waitForDeviceReply(deviceSocketId, timeout) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      io.off('deviceReplyInternal_' + deviceSocketId, handler);
      resolve(null);
    }, timeout);
    function handler(payload) {
      clearTimeout(t);
      resolve(payload);
    }
    io.once('deviceReplyInternal_' + deviceSocketId, handler);
  });
}

// ─────────────────────────────────────────────────────────────
//  SSE push helpers
// ─────────────────────────────────────────────────────────────

function sendSse(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (e) { /* client disconnected */ }
}

/** Push a notifications/tools/list_changed to all MCP SSE clients in a room */
function pushToolListChanged(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  for (const res of room.mcpSseClients.values()) {
    sendSse(res, 'message', { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    sendSse(res, 'message', { jsonrpc: '2.0', method: 'notifications/resources/list_changed', params: {} });
  }
}

function broadcastToRoom(roomName, event, data) {
  io.to(roomName).emit(event, data);
}

// ─────────────────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────────────────
app.get('/',        (_, res) => res.sendFile(path.join(__dirname, 'pages/participant.html')));
app.get('/device',  (_, res) => res.sendFile(path.join(__dirname, 'pages/device.html')));
app.get('/admin',   (_, res) => res.sendFile(path.join(__dirname, 'pages/admin.html')));

/** Convenience: return MCP endpoint URL for a room */
app.get('/room/:roomName/mcp-info', (req, res) => {
  const { roomName } = req.params;
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    room: roomName,
    exists: !!rooms[roomName],
    mcpEndpoint: `${base}/room/${roomName}/mcp`,
    mcpSse:      `${base}/room/${roomName}/mcp/sse`,
    tools:       rooms[roomName] ? buildToolList(rooms[roomName]).map(t => t.name) : []
  });
});

// ─────────────────────────────────────────────────────────────
//  Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('roomList', Object.keys(rooms));

  // ── ADMIN: create/join room ──────────────────────────────
  socket.on('adminLogin', ({ roomName, password, name }) => {
    if (!roomName || !name) return;
    if (!rooms[roomName]) {
      if (!password) { socket.emit('authError', 'New rooms require a password.'); return; }
      rooms[roomName] = {
        password, adminIds: [], logs: [],
        devices: {}, participants: {},
        mcpSseClients: new Map()
      };
      io.emit('roomList', Object.keys(rooms));
    }
    const room = rooms[roomName];
    if (password !== room.password) { socket.emit('authError', 'Wrong password.'); return; }
    if (!room.adminIds.includes(socket.id)) room.adminIds.push(socket.id);
    socket.join(roomName);
    socket.data = { role: 'admin', roomName, name };
    const base = `${socket.handshake.headers['x-forwarded-proto'] || 'http'}://${socket.handshake.headers.host}`;
    socket.emit('adminAuthSuccess', {
      roomName, logs: room.logs,
      devices: Object.values(room.devices),
      participants: Object.values(room.participants),
      mcpEndpoint: `${base}/room/${roomName}/mcp`,
      mcpSse:      `${base}/room/${roomName}/mcp/sse`
    });
    roomLog(roomName, `Admin "${name}" joined.`, 'admin');
    io.to(roomName).emit('presenceUpdate', buildPresence(roomName));
  });

  // ── PARTICIPANT: join ────────────────────────────────────
  socket.on('participantJoin', ({ roomName, name }) => {
    if (!name || !rooms[roomName]) { socket.emit('joinError', 'Room not found.'); return; }
    const room = rooms[roomName];
    room.participants[socket.id] = { id: socket.id, name, msgCount: 0 };
    socket.join(roomName);
    socket.data = { role: 'participant', roomName, name };
    const base = `${socket.handshake.headers['x-forwarded-proto'] || 'http'}://${socket.handshake.headers.host}`;
    socket.emit('joinSuccess', {
      roomName, name,
      mcpEndpoint: `${base}/room/${roomName}/mcp`,
      mcpSse:      `${base}/room/${roomName}/mcp/sse`
    });
    roomLog(roomName, `Participant "${name}" joined.`, 'join');
    io.to(roomName).emit('presenceUpdate', buildPresence(roomName));
  });

  // ── DEVICE BRIDGE: register ──────────────────────────────
  socket.on('deviceJoin', ({ roomName, deviceName }) => {
    if (!deviceName || !rooms[roomName]) { socket.emit('deviceError', 'Room not found.'); return; }
    const room = rooms[roomName];
    room.devices[socket.id] = { id: socket.id, name: deviceName, roomName, lastSeen: Date.now(), lastStatus: null };
    socket.join(roomName);
    socket.data = { role: 'device', roomName, name: deviceName };
    socket.emit('deviceJoinSuccess', { roomName, deviceName });
    roomLog(roomName, `Device "${deviceName}" registered. MCP tools updated.`, 'device');
    io.to(roomName).emit('presenceUpdate', buildPresence(roomName));
    // IMPORTANT: notify all MCP clients that tool list has changed
    pushToolListChanged(roomName);
    // Tell admin the new MCP tool names
    room.adminIds.forEach(id => io.to(id).emit('mcpToolsUpdated', {
      tools: buildToolList(room).map(t => t.name)
    }));
  });

  // ── DEVICE BRIDGE: reply from ESP32 ─────────────────────
  socket.on('deviceReply', ({ roomName, payload }) => {
    const room = rooms[roomName];
    if (!room) return;
    const dev = room.devices[socket.id];
    if (!dev) return;
    dev.lastSeen = Date.now();
    dev.lastStatus = payload;
    // Fire internal event so waitForDeviceReply can catch it
    io.emit('deviceReplyInternal_' + socket.id, payload);
    // Broadcast to room participants
    io.to(roomName).emit('deviceMessage', { from: dev.name, payload });
    // Log to admin
    roomLog(roomName, `Device "${dev.name}" reply: ${JSON.stringify(payload)}`, 'device');
  });

  // ── PARTICIPANT: plain chat ──────────────────────────────
  socket.on('chatSend', ({ roomName, text }) => {
    const room = rooms[roomName];
    if (!room || !text) return;
    const p = room.participants[socket.id];
    if (!p) return;
    p.msgCount++;
    io.to(roomName).emit('chatMessage', { type: 'chat', from: p.name, text });
  });

  // ── ADMIN: broadcast ─────────────────────────────────────
  socket.on('adminBroadcast', ({ roomName, text }) => {
    const room = rooms[roomName];
    if (!room || !room.adminIds.includes(socket.id)) return;
    io.to(roomName).emit('chatMessage', { type: 'admin', from: socket.data.name || 'Admin', text });
  });

  // ── ADMIN: send JSON directly to device ─────────────────
  socket.on('adminSendJSON', ({ roomName, targetDeviceId, payload }) => {
    const room = rooms[roomName];
    if (!room || !room.adminIds.includes(socket.id)) return;
    const envelope = { type: 'admin_command', from: 'ADMIN', payload };
    if (targetDeviceId === 'all') {
      Object.keys(room.devices).forEach(id => io.to(id).emit('incomingJSON', envelope));
    } else {
      io.to(targetDeviceId).emit('incomingJSON', envelope);
    }
    roomLog(roomName, `Admin JSON → ${targetDeviceId === 'all' ? 'ALL' : room.devices[targetDeviceId]?.name}: ${JSON.stringify(payload)}`, 'admin');
  });

  // ── ADMIN: kick ──────────────────────────────────────────
  socket.on('kickUser', ({ roomName, userId }) => {
    const room = rooms[roomName];
    if (!room || !room.adminIds.includes(socket.id)) return;
    io.to(userId).emit('kicked', 'Removed by admin.');
    delete room.participants[userId];
    delete room.devices[userId];
    io.to(roomName).emit('presenceUpdate', buildPresence(roomName));
    pushToolListChanged(roomName);
  });

  // ── ADMIN: shutdown room ─────────────────────────────────
  socket.on('shutdownRoom', (roomName) => {
    const room = rooms[roomName];
    if (!room || !room.adminIds.includes(socket.id)) return;
    io.to(roomName).emit('roomShutdown', 'Room closed by admin.');
    delete rooms[roomName];
    io.emit('roomList', Object.keys(rooms));
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const { role, roomName, name } = socket.data || {};
    if (!roomName || !rooms[roomName]) return;
    const room = rooms[roomName];
    room.adminIds = room.adminIds.filter(id => id !== socket.id);
    delete room.participants[socket.id];
    const wasDevice = !!room.devices[socket.id];
    delete room.devices[socket.id];
    if (wasDevice) {
      pushToolListChanged(roomName); // devices gone → update tool list
      roomLog(roomName, `Device "${name}" disconnected. MCP tools updated.`, 'device');
    }
    io.to(roomName).emit('presenceUpdate', buildPresence(roomName));
  });
});

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function buildPresence(roomName) {
  const room = rooms[roomName];
  if (!room) return {};
  return {
    devices: Object.values(room.devices).map(d => ({ id: d.id, name: d.name, lastSeen: d.lastSeen })),
    participants: Object.values(room.participants).map(p => ({ id: p.id, name: p.name, msgCount: p.msgCount })),
    adminCount: room.adminIds.length
  };
}

function roomLog(roomName, message, type = 'info') {
  const ts = new Date().toLocaleTimeString();
  const entry = { ts, message, type };
  console.log(`[${roomName}] [${ts}] ${message}`);
  if (rooms[roomName]) {
    rooms[roomName].logs.push(entry);
    if (rooms[roomName].logs.length > 300) rooms[roomName].logs.shift();
    rooms[roomName].adminIds.forEach(id => io.to(id).emit('serverLog', entry));
  }
}

// ─────────────────────────────────────────────────────────────
server.listen(process.env.PORT || 3000, () => {
  console.log('🚀 DeviceChat MCP Bridge running on :3000');
  console.log('   /        → Participant (WebMCP client)');
  console.log('   /device  → ESP32 WebSerial bridge');
  console.log('   /admin   → Admin dashboard');
  console.log('   /room/:name/mcp     → MCP HTTP endpoint');
  console.log('   /room/:name/mcp/sse → MCP SSE stream');
});
