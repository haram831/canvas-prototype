import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// room -> events[]
const roomHistory = new Map();

function broadcast(room, data, except) {
  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.room !== room) return;
    if (client === except) return;
    client.send(data);
  });
}

wss.on("connection", (ws) => {
  ws.room = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // join
    if (msg.type === "join") {
      ws.room = msg.room;
      if (!roomHistory.has(ws.room)) {
        roomHistory.set(ws.room, []);
      }

      ws.send(
        JSON.stringify({
          type: "history",
          room: ws.room,
          events: roomHistory.get(ws.room),
        })
      );
      return;
    }

    if (!ws.room) return;

    const data = JSON.stringify({ ...msg, room: ws.room });
    roomHistory.get(ws.room).push(JSON.parse(data));

    broadcast(ws.room, data, ws);
  });
});

console.log(`✅ WS server running on ws://localhost:${PORT}`);
