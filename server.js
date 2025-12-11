// server.js
//
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import haversine from "haversine-distance";
const app = express();
const prisma = new PrismaClient();
app.use(express.json());
app.use(cors({ origin: "*" }));
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // allow all for demo; restrict in prod
});
app.get('/home', (req, res) => {
  res.send('Hello from Express API!');
});
const data=
  {
  "nit_jal": { 
    "name": "NIT JAL", 
    "lat": 31.396418, 
    "lon": 75.537029, 
    "radius": 1.5 
  },
  "my_home": { 
    "name": "My Home", 
    "lat": 30.3365, 
    "lon": 76.397, 
    "radius": 1.5 
  }
}

// Basic route to test server

// status
app.get("/", (req, res) => {
  res.send("Socket.IO server is running");
});

io.on("connection", (socket) => {
  console.log("a user connected:", socket.id);
  socket.currentRoom = null;
  socket.on("joinRoom", (roomKey) => {
    // Leave old room if in one
    if (socket.currentRoom && socket.currentRoom !== roomKey) {
      socket.leave(socket.currentRoom);
      console.log(`Socket ${socket.id} left room ${socket.currentRoom}`);
      io.to(socket.currentRoom).emit(
        "system message",
        `User ${socket.id} left the room`
      );
    }

    // Join new room
    socket.join(roomKey);
    socket.currentRoom = roomKey;
    console.log(`Socket ${socket.id} joined room ${roomKey}`);
    io.to(roomKey).emit(
      "system message",
      `User ${socket.id} joined room ${roomKey}`
    );
  });
// send message only to that room
socket.on("chat message", async (roomKey, msg) => {
  try {
    // 1️⃣ Immediately broadcast to everyone in the room
    io.to(roomKey).emit("chat message", msg);
    console.log(msg);
    // 2️⃣ Save to DB asynchronously (don’t block emit)
      await prisma.message.create({
      data: {
        room: roomKey,
        parentClientId: msg.replyTo || null,
        content: msg.text,
        clientId: msg.id,
        nickname: msg.author,
      },
    });

    console.log("Message saved to DB:", msg.text);
  } catch (err) {
    console.error("Error saving message:", err);
  }
});
  socket.on("disconnect", () => {
    console.log("user disconnected:", socket.id);
  });
});
function getRoomForUser(userLat, userLon) {
  let nearest = null;
  let minDistance = Infinity;
  for (const [key, loc] of Object.entries(data)) {
    const distance = haversine(
      { lat: userLat, lon: userLon },
      { lat: loc.lat, lon: loc.lon }
    ) / 1000; // convert to km
    if (distance <= loc.radius && distance < minDistance) {
      nearest = { key, ...loc, distance };
      minDistance = distance;
    }
  }
  return nearest;
}

app.post('/getroom', (req, res) => {
  const { lat, lon } = req.body;
  console.log(`Finding room for user at (${lat}, ${lon})`);
   try {
    const room = getRoomForUser(lat, lon);
    if (room) {
      res.json({ room });
    } else {
      res.status(404).json({ error: "No room found for this location" });
    }
  } catch (error) {
    console.error("Error finding room:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
server.listen(3001, () => {
  console.log("Server running on http://localhost:3001");
});