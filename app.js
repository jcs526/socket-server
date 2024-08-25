const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const multer = require("multer");
const { Readable } = require("stream");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const mongoUrl = "mongodb://test:test1234@127.0.0.1:27027";
const dbName = "chat_test";
let gfs;
let chatCollection;

MongoClient.connect(mongoUrl, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(client => {
    console.log("Connected to MongoDB");
    const db = client.db(dbName);
    gfs = new GridFSBucket(db, {
      bucketName: "uploads",
    });

    chatCollection = db.collection("messages");
  })
  .catch(error => console.error(error));

const storage = multer.memoryStorage();
const upload = multer({ storage });

// 파일 업로드 엔드포인트
app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const readableStream = new Readable();
    readableStream.push(req.file.buffer);
    readableStream.push(null);

    const originalName = req.file.originalname;

    const uploadStream = gfs.openUploadStream(originalName);
    readableStream
      .pipe(uploadStream)
      .on("error", error => res.status(500).send(error))
      .on("finish", async () => {
        const fileId = uploadStream.id;
        const fileUrl = `http://localhost:3000/files/${fileId}`;

        // 파일 업로드가 완료되면 클라이언트에게 파일 ID와 URL 반환
        res.json({ fileUrl, fileId, originalName });
      });
  } catch (error) {
    res.status(500).send({ error: "Failed to upload file", details: error.message });
  }
});

app.get("/files/:id", async (req, res) => {
  let fileId;

  // ObjectId가 유효한지 검증
  try {
    fileId = new ObjectId(req.params.id);
  } catch (error) {
    return res.status(400).json({ error: "Invalid file ID" });
  }

  try {
    const files = await gfs.find({ _id: fileId }).toArray();

    if (!files || files.length === 0) {
      return res.status(404).json({ error: "File not found" });
    }

    const originalName = files[0].filename; // 원래 파일 이름 추출

    res.attachment(originalName);

    const downloadStream = gfs.openDownloadStream(fileId);
    downloadStream.on("error", downloadError => {
      return res.status(500).json({ error: "Error during file download", details: downloadError.message });
    });

    downloadStream.pipe(res);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Error fetching file metadata", details: err.message });
  }
});

io.on("connection", socket => {
  socket.on("joinRoom", async ({ room, username }) => {
    socket.join(room);
    socket.currentRoom = room;
    socket.username = username; // 사용자 이름 저장
    socket.emit("joinRoomSuccess");
  });

  socket.on("loadMessages", async page => {
    const room = socket.currentRoom;
    if (!room) return;

    const PAGE_SIZE = 3;
    const skip = page * PAGE_SIZE;
    const messages = await chatCollection
      .find({ room: room })
      .sort({ _id: -1 }) // 최신 메시지를 먼저 가져오기 위해 내림차순 정렬
      .skip(skip)
      .limit(PAGE_SIZE)
      .toArray();

    socket.emit("history", messages); // 클라이언트에 전달
  });

  socket.on("newMessage", async ({ message, fileUrl }) => {
    const room = socket.currentRoom;
    if (!room) return;

    let chatMessage = {
      text: message,
      timestamp: new Date(),
      room: room,
      username: socket.username, // 메시지에 작성자 정보 추가
    };

    if (fileUrl) {
      chatMessage.text += ` <a href="${fileUrl}" target="_blank">Download File</a>`;
    }

    await chatCollection.insertOne(chatMessage);

    io.to(room).emit("message", chatMessage);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected from room: ${socket.currentRoom}`);
  });
});

server.listen(3000, () => {
  console.log("Server is running on port 3000");
});
