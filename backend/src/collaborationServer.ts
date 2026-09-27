import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const port = process.env.WS_PORT || 1234;

interface RoomPresence {
  clients: Set<WebSocket>;
  roomName: string;
}

const roomPresenceMap = new Map<string, RoomPresence>();

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', activeRooms: roomPresenceMap.size }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/plain' });
  response.end('Y-Websocket Collaboration Server is running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (conn: WebSocket, req) => {
  const url = new URL(req?.url || '/', `http://${req?.headers.host || 'localhost'}`);
  const roomName = url.pathname.replace(/^\//, '') || 'default';

  // Real-time room presence tracking
  if (!roomPresenceMap.has(roomName)) {
    roomPresenceMap.set(roomName, { clients: new Set(), roomName });
  }

  const room = roomPresenceMap.get(roomName)!;
  room.clients.add(conn);

  // Broadcast presence count update to connected room clients
  const broadcastPresence = () => {
    const presencePayload = JSON.stringify({
      type: 'presence_update',
      roomName,
      activeUsers: room.clients.size,
    });

    room.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(presencePayload);
      }
    });
  };

  broadcastPresence();

  conn.on('message', (message) => {
    // Relay room synchronization messages to all room peers
    room.clients.forEach((client) => {
      if (client !== conn && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  conn.on('close', () => {
    room.clients.delete(conn);
    if (room.clients.size === 0) {
      roomPresenceMap.delete(roomName);
    } else {
      broadcastPresence();
    }
  });

  conn.on('error', (err) => {
    console.error(`WebSocket error in room ${roomName}:`, err);
    conn.close();
  });
});

server.listen(port, () => {
  console.log(`Collaboration server running on port ${port}`);
});
