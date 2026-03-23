import 'dotenv/config';
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import haversine from "haversine-distance";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(cors({ origin: "*" }));

const server = createServer(app);

// --- REDIS SETUP (Optimized for Upstash & Cloud Run) ---
// Note: Ensure REDIS_URL in your .env starts with 'rediss://'
const redisOptions = {
  tls: { rejectUnauthorized: false }, // Mandatory for Upstash SSL
  maxRetriesPerRequest: null,         // Mandatory for Socket.io Redis Adapter
};

// We create two separate clients for the Pub/Sub mechanism
const pubClient = new Redis(process.env.REDIS_URL, redisOptions);
const subClient = new Redis(process.env.REDIS_URL, redisOptions);

const io = new Server(server, {
  cors: { origin: "*" },
  adapter: createAdapter(pubClient, subClient),
  pingTimeout: 60000, 
  pingInterval: 25000,
});

// --- HARDCODED DATA ---
const data = {
  "nit_jal": { 
    "name": "NIT JAL", 
    "lat": 31.396418, 
    "lon": 75.537029, 
    "radius": 3.5 
  },
  "my_home": { 
    "name": "My Home", 
    "lat": 30.3355, 
    "lon": 76.397, 
    "radius": 3.5 
  }
};

// --- SOCKET LOGIC ---
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // 1. Handshake Recovery: Fixes the "Amnesia" bug during Cloud Run resets
  const { currentRoom } = socket.handshake.auth;
  if (currentRoom) {
    console.log(`[RECOVERY] Re-syncing socket ${socket.id} to: ${currentRoom}`);
    socket.join(currentRoom);
    socket.currentRoom = currentRoom;
  }

  socket.on("joinRoom", (roomKey) => {
    // Prevent duplicate join spam
    if (socket.currentRoom === roomKey) return;

    // Leave old room if switching
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      io.to(socket.currentRoom).emit("system message", `User left the room`);
    }

    socket.join(roomKey);
    socket.currentRoom = roomKey;
    
    console.log(`[JOIN] ${socket.id} joined ${roomKey}`);
    io.to(roomKey).emit("system message", `User joined room ${roomKey}`);
  });

  socket.on("chat message", async (roomKey, msg) => {
    // Validation: Ensure user is actually in the room they are messaging
    if (!socket.rooms.has(roomKey)) {
      console.warn(`[REJECTED] Unauthorized message from ${socket.id} to ${roomKey}`);
      return;
    }

    try {
      // Broadcast to room (via Redis adapter for horizontal scaling)
      io.to(roomKey).emit("chat message", msg);

      // Async save to Prisma
      await prisma.message.create({
        data: {
          room: roomKey,
          parentClientId: msg.replyTo || null,
          content: msg.text,
          clientId: msg.id,
          nickname: msg.author,
        },
      });
    } catch (err) {
      console.error("Database Error:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// --- UTILS & ROUTES ---
function getRoomForUser(userLat, userLon) {
  let nearest = null;
  let minDistance = Infinity;
  for (const [key, loc] of Object.entries(data)) {
    const distance = haversine(
      { lat: userLat, lon: userLon },
      { lat: loc.lat, lon: loc.lon }
    ) / 1000; 
    if (distance <= loc.radius && distance < minDistance) {
      nearest = { key, ...loc, distance };
      minDistance = distance;
    }
  }
  return nearest;
}

app.get("/", (req, res) => res.send("Socket.IO server is running"));

app.post('/getroom', (req, res) => {
  const { lat, lon } = req.body;
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

// --- SERVER START & SHUTDOWN ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// SIGTERM handler for Google Cloud Run graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Cleaning up...');
  server.close(async () => {
    await prisma.$disconnect();
    pubClient.quit();
    subClient.quit();
    process.exit(0);
  });
});