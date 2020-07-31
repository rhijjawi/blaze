import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import cors from 'cors';
import shortid from 'shortid';

import Socket from '../common/utils/socket';
import Room from '../common/utils/room';
import log from './log';
import constants from '../common/constants';

const CORS_ORIGIN = process.env.ORIGIN ? JSON.parse(process.env.ORIGIN) : '*';
const PORT = process.env.PORT || 3030;
const WS_SIZE_LIMIT = process.env.WS_SIZE_LIMIT || 1e8;

const app = express();
app.use(express.json());
app.use(cors({ origin: CORS_ORIGIN }));

const server = http.createServer(app);

const wss = new WebSocket.Server({ noServer: true });
const rooms = {};

wss.on('connection', (ws, request) => {
  ws.isAlive = true;
  const ip = request.connection.remoteAddress;
  const socket = new Socket(ws, ip);
  let room;
  
  socket.listen(constants.JOIN, (data) => {
    const { roomName = socket.ip, name, peerId } = data;
    socket.name = name;
    socket.peerId = peerId;

    room = rooms[roomName];

    if (room) {
      const user = room.getSocketFromName(socket.name);
      if (user) {
        socket.close(1000, constants.ERR_SAME_NAME);
        return;
      }
    }
    else {
      rooms[roomName] = new Room(roomName);
      room = rooms[roomName];
    }

    log(`${name} has joined ${roomName}`);

    room.addSocket(socket);
    room.broadcast(constants.USER_JOIN, room.socketsData);
  });

  socket.on('close', data => {
    if (data.reason === constants.ERR_SAME_NAME) return;
    if (!room) return;

    log(`${socket.name} has left ${room.name}`);
    room.removeSocket(socket);
    const sockets = room.socketsData;

    if (Array.isArray(sockets)) {
      if (sockets.length) {
        room.broadcast(constants.USER_LEAVE, socket.name, [ socket.name ]);
      } else if (!room.watchers.length) {
        delete rooms[room.name];
      }
    }
  });

  socket.on('pong', () => {
    socket.socket.isAlive = true;
  });

  socket.listen(constants.FILE_INIT, (data) => {
    // TODO: Prevent init from multiple sockets if a sender is already there
    // TODO: Improve error messaging via sockets
    if (data.size > WS_SIZE_LIMIT) return;

    if (data.end) {
      log(`File transfer just finished!`);
    } else {
      log(`${socket.name} has initiated file transfer`);
    }

    room.sender = socket.name;
    room.broadcast(constants.FILE_INIT, data, [ socket.name ]);
  });

  socket.listen(constants.FILE_STATUS, (data) => {
    const sender = room.senderSocket;
    // TODO: Sender is not there but some file is getting transferred!
    if (!sender) return;

    sender.send(constants.FILE_STATUS, data);
  });

  socket.listen(constants.CHUNK, (data) => {
    room.broadcast(constants.CHUNK, data, [ room.sender ]);
  });

  socket.listen(constants.FILE_TORRENT, (data) => {
    room.broadcast(constants.FILE_TORRENT, data, [ socket.name ]);
  });
});

const interval = setInterval(() => {
  log("Checking alive sockets");
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

app.get('/', (req, res) => {
  res.send({
    message: 'Blaze WebSockets running',
    rooms: Object.keys(rooms).length,
    peers: Object.values(rooms).reduce((sum, room) => sum + room.sockets.length, 0),
  });
});

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;

  let allowed = false;
  if (CORS_ORIGIN === '*') {
    allowed = true;
  } else if (Array.isArray(CORS_ORIGIN)) {
    for(const o of CORS_ORIGIN) {
      if (o === origin) {
        allowed = true;
        break;
      }
    }
  }
  
  if (!allowed) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
  } else {
    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  }
});

app.get('/local-peers', (req, res) => {
  const { ip } = req;
  const headers = {
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
  };
  res.writeHead(200, headers);

  const watcher = { id: shortid.generate(), res };

  if (!rooms[ip]) {
    rooms[ip] = new Room(ip);
  } else {
    rooms[ip].addWatcher(watcher);
  }

  rooms[ip].informWatchers([ watcher ]);

  req.on('close', () => {
    const room = rooms[ip];
    if (!room) return;

    room.removeWatcher(watcher);

    if (!room.watchers.length && !room.socketsData.length) {
      delete rooms[ip];
    }
  });
});

const port = process.env.PORT || 3030;
server.listen(port, '0.0.0.0', () => {
  log(`listening on *:${port}`);
});