/**
 * src/bagReader.js
 * Unified ROS1 (.bag) and ROS2 (.db3/.mcap) bag reader
 */

const fs = require("fs");
const path = require("path");

// Native modules (.node binaries) and modules with compiled binaries cannot be
// loaded from inside an asar archive — the OS can't dlopen a virtual path.
// electron-builder asarUnpack extracts them to app.asar.unpacked/.
// This helper rewrites require() paths for those modules when packaged.
function requireNative(moduleName) {
  try {
    // First try normal require (works in dev, and for pure-JS modules)
    return require(moduleName);
  } catch (e) {
    // In a packaged app, try the unpacked path explicitly
    try {
      const unpackedBase = __dirname.replace("app.asar", "app.asar.unpacked");
      const modPath = path.join(unpackedBase, "..", "node_modules", moduleName);
      return require(modPath);
    } catch (e2) {
      throw new Error(`Cannot load ${moduleName}: ${e.message}`);
    }
  }
}

// Video message types to auto-detect
const VIDEO_TYPES = new Set([
  "sensor_msgs/Image",
  "sensor_msgs/msg/Image",
  "sensor_msgs/CompressedImage",
  "sensor_msgs/msg/CompressedImage",
  "theora_image_transport/Packet",
  "ffmpeg_image_transport_msgs/FFMPEGPacket",
]);

/**
 * Detect bag format from file extension and magic bytes
 */
async function detectFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".bag") return "ros1";
  if (ext === ".mcap") return "mcap";
  if (ext === ".db3") return "ros2";

  // Try magic bytes for .bag
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0);
  fs.closeSync(fd);
  if (buf.toString("ascii") === "#ROS") return "ros1";

  throw new Error(`Unknown bag format: ${filePath}`);
}

/**
 * Read topics and metadata from a ROS1 .bag file
 */
/**
 * Parse ROS1 bag connection records directly from the file.
 * The bag index section contains connection records with a header that
 * includes the 'type' field as a raw key=value string — this is more
 * reliable than the @foxglove/rosbag Connection object which omits type.
 */
async function readRos1ConnectionsDirect(filePath) {
  const fd = fs.openSync(filePath, "r");

  function readBytes(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    return buf;
  }

  function readUInt32LE(offset) {
    return readBytes(offset, 4).readUInt32LE(0);
  }

  function parseHeaderFields(buf) {
    const fields = {};
    let pos = 0;
    while (pos < buf.length) {
      if (pos + 4 > buf.length) break;
      const fieldLen = buf.readUInt32LE(pos);
      pos += 4;
      if (fieldLen <= 0 || pos + fieldLen > buf.length) break;
      const field = buf.slice(pos, pos + fieldLen).toString("binary");
      pos += fieldLen;
      const eq = field.indexOf("=");
      if (eq >= 0) {
        fields[field.slice(0, eq)] = field.slice(eq + 1);
      }
    }
    return fields;
  }

  // Read magic + bag header record
  const magic = readBytes(0, 13).toString("ascii");
  console.log("Magic:", JSON.stringify(magic));

  let pos = 13;
  const headerLen = readUInt32LE(pos); pos += 4;
  console.log("BagHeader record headerLen:", headerLen);

  const bagHeaderBuf = readBytes(pos, headerLen);
  const bagHeaderFields = parseHeaderFields(bagHeaderBuf);
  console.log("BagHeader fields:", bagHeaderFields);
  pos += headerLen;

  const dataLen = readUInt32LE(pos); pos += 4;
  pos += dataLen;

  const indexPosRaw = bagHeaderFields["index_pos"] || "";
  let indexPos = 0;
  if (indexPosRaw.length >= 8) {
    // index_pos is a raw 8-byte little-endian uint64
    const b = Buffer.from(indexPosRaw, "binary");
    // JS can't represent full uint64, but bags won't exceed 2^52 bytes
    indexPos = b.readUInt32LE(0) + b.readUInt32LE(4) * 0x100000000;
  } else if (indexPosRaw.length === 4) {
    indexPos = Buffer.from(indexPosRaw, "binary").readUInt32LE(0);
  }
  console.log("indexPos:", indexPos);

  if (!indexPos) {
    console.log("No index_pos found — bag may be unindexed");
    fs.closeSync(fd);
    return {};
  }

  const connections = {};
  let cursor = indexPos;
  const fileSize = fs.fstatSync(fd).size;
  console.log("fileSize:", fileSize, "reading index from:", indexPos);

  let recordCount = 0;
  while (cursor < fileSize - 8) {
    try {
      const recHeaderLen = readUInt32LE(cursor); cursor += 4;
      if (recHeaderLen <= 0 || recHeaderLen > 1000000 || cursor + recHeaderLen > fileSize) {
        console.log("Bad recHeaderLen:", recHeaderLen, "at cursor:", cursor - 4);
        break;
      }
      const recHeaderBuf = readBytes(cursor, recHeaderLen);
      const recHeader = parseHeaderFields(recHeaderBuf);
      cursor += recHeaderLen;

      const recDataLen = readUInt32LE(cursor); cursor += 4;
      if (recDataLen < 0 || cursor + recDataLen > fileSize) {
        console.log("Bad recDataLen:", recDataLen);
        break;
      }

      const opRaw = recHeader["op"];
      const opCode = opRaw ? Buffer.from(opRaw, "binary").readUInt8(0) : -1;

      recordCount++;
      if (recordCount <= 5) {
        console.log(`Record #${recordCount}: op=0x${opCode.toString(16)}, headerFields:`, Object.keys(recHeader), "dataLen:", recDataLen);
      }

      // op 0x07 = CONNECTION
      if (opCode === 7) {
        const connIdRaw = recHeader["conn"] || "\x00\x00\x00\x00";
        const connId = Buffer.from(connIdRaw, "binary").readUInt32LE(0);
        const topic = recHeader["topic"] || "";

        // The type is NOT in the record header — it's in the data section
        // which contains a second header block with type, md5sum, message_definition
        // At this point cursor points to the START of the data section
        const dataBuf = readBytes(cursor, recDataLen);
        const dataFields = parseHeaderFields(dataBuf);
        const type = dataFields["type"] || "";
        const md5sum = dataFields["md5sum"] || "";
        const messageDefinition = dataFields["message_definition"] || "";

        console.log(`  CONNECTION: id=${connId} topic=${topic} type=${type}`);
        connections[connId] = { conn: connId, topic, type, md5sum, messageDefinition };
      }

      cursor += recDataLen;
      if (recordCount > 5000) { console.log("Safety break at 5000 records"); break; }
    } catch (e) {
      console.log("Error reading record at cursor", cursor, ":", e.message);
      break;
    }
  }

  console.log("Total records scanned:", recordCount, "connections found:", Object.keys(connections).length);
  fs.closeSync(fd);
  return connections;
}

async function readRos1Meta(filePath) {
  const { Bag } = requireNative("@foxglove/rosbag");
  const { FileReader } = requireNative("@foxglove/rosbag/node");
  const bag = new Bag(new FileReader(filePath));
  await bag.open();

  // Read connections directly from bag binary — reliable type extraction
  const rawConnections = await readRos1ConnectionsDirect(filePath);

  const topics = [];
  for (const conn of Object.values(rawConnections)) {
    if (!conn.topic) continue;
    if (topics.find(t => t.name === conn.topic)) continue;

    const msgType = conn.type || "unknown";
    topics.push({
      name: conn.topic,
      type: msgType,
      messageCount: 0,
      isVideo: VIDEO_TYPES.has(msgType),
    });
  }

  return {
    format: "ros1",
    startTime: bag.startTime,
    endTime: bag.endTime,
    topics,
    bag,
  };
}

/**
 * Read topics and metadata from a ROS2 .db3 or .mcap file
 */
async function readRos2Meta(filePath, format) {
  if (format === "mcap") {
    const { McapIndexedReader } = requireNative("@mcap/core");
    const { FileHandleReadable } = requireNative("@mcap/nodejs");
    const { open } = require("fs/promises");

    const fileHandle = await open(filePath, "r");
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(fileHandle),
    });

    const topics = [];
    let minTime = BigInt(Number.MAX_SAFE_INTEGER);
    let maxTime = BigInt(0);

    for (const channel of reader.channelsById.values()) {
      const schema = reader.schemasById.get(channel.schemaId);
      const msgType = schema?.name || "unknown";
      topics.push({
        name: channel.topic,
        type: msgType,
        messageCount: 0,
        isVideo: VIDEO_TYPES.has(msgType),
      });
    }

    for (const chunk of reader.chunkIndexes) {
      if (chunk.messageStartTime < minTime) minTime = chunk.messageStartTime;
      if (chunk.messageEndTime > maxTime) maxTime = chunk.messageEndTime;
    }

    await fileHandle.close();

    return {
      format: "mcap",
      startTime: { sec: Number(minTime / 1000000000n), nsec: Number(minTime % 1000000000n) },
      endTime: { sec: Number(maxTime / 1000000000n), nsec: Number(maxTime % 1000000000n) },
      topics,
      filePath,
    };
  }

  // .db3 via better-sqlite3 direct query (ROS2 SQLite format)
  let Database;
  try {
    Database = requireNative("better-sqlite3");
  } catch {
    throw new Error(
      "For .db3 files, install better-sqlite3: npm install better-sqlite3"
    );
  }

  const db = new Database(filePath, { readonly: true });
  const topicRows = db.prepare("SELECT * FROM topics").all();
  const msgCountRows = db
    .prepare(
      "SELECT topic_id, COUNT(*) as count FROM messages GROUP BY topic_id"
    )
    .all();
  const countMap = Object.fromEntries(
    msgCountRows.map((r) => [r.topic_id, r.count])
  );

  const timeRow = db
    .prepare(
      "SELECT MIN(timestamp) as minT, MAX(timestamp) as maxT FROM messages"
    )
    .get();

  const topics = topicRows.map((t) => ({
    name: t.name,
    type: t.type,
    messageCount: countMap[t.id] || 0,
    isVideo: VIDEO_TYPES.has(t.type),
  }));

  const toRosTime = (ns) => ({
    sec: Math.floor(Number(ns) / 1e9),
    nsec: Number(ns) % 1e9,
  });

  db.close();

  return {
    format: "ros2-db3",
    startTime: toRosTime(timeRow.minT),
    endTime: toRosTime(timeRow.maxT),
    topics,
    filePath,
  };
}

/**
 * Main entry: load bag metadata
 */
async function loadBagMeta(filePath) {
  const format = await detectFormat(filePath);
  const name = path.basename(filePath, path.extname(filePath));

  let meta;
  if (format === "ros1") {
    meta = await readRos1Meta(filePath);
  } else {
    meta = await readRos2Meta(filePath, format);
  }

  return { ...meta, name, filePath };
}

/**
 * Iterate messages for selected topics from ROS1 bag
 */
async function* ros1Messages(bag, topics) {
  const topicSet = new Set(topics);
  for await (const result of bag.messageIterator({ topics: [...topicSet] })) {
    yield {
      topic: result.topic,
      timestamp: result.timestamp,
      data: result.message,
    };
  }
}

/**
 * Iterate messages for selected topics from MCAP
 */
async function* mcapMessages(filePath, topics) {
  const { McapIndexedReader } = requireNative("@mcap/core");
  const { FileHandleReadable } = requireNative("@mcap/nodejs");
  const { open } = require("fs/promises");
  const topicSet = new Set(topics);

  const fileHandle = await open(filePath, "r");
  const reader = await McapIndexedReader.Initialize({
    readable: new FileHandleReadable(fileHandle),
  });

  // Build channel->topic map
  const channelTopics = new Map();
  for (const channel of reader.channelsById.values()) {
    if (topicSet.has(channel.topic)) {
      channelTopics.set(channel.id, channel.topic);
    }
  }

  for await (const msg of reader.readMessages()) {
    const topic = channelTopics.get(msg.channelId);
    if (!topic) continue;
    const nsec = msg.logTime;
    yield {
      topic,
      timestamp: {
        sec: Number(nsec / 1000000000n),
        nsec: Number(nsec % 1000000000n),
      },
      data: msg.data,
      isRaw: true,
    };
  }

  await fileHandle.close();
}

/**
 * Iterate messages for ROS2 db3
 */
async function* db3Messages(filePath, topics) {
  const Database = requireNative("better-sqlite3");
  const db = new Database(filePath, { readonly: true });
  const topicSet = new Set(topics);

  const topicRows = db.prepare("SELECT id, name FROM topics").all();
  const topicIds = topicRows
    .filter((t) => topicSet.has(t.name))
    .map((t) => t.id);

  if (topicIds.length === 0) {
    db.close();
    return;
  }

  const placeholders = topicIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT m.timestamp, t.name as topic, m.data FROM messages m
       JOIN topics t ON m.topic_id = t.id
       WHERE m.topic_id IN (${placeholders})
       ORDER BY m.timestamp ASC`
    )
    .all(...topicIds);

  db.close();

  for (const row of rows) {
    yield {
      topic: row.topic,
      timestamp: {
        sec: Math.floor(Number(row.timestamp) / 1e9),
        nsec: Number(row.timestamp) % 1e9,
      },
      data: row.data,
      isRaw: true,
    };
  }
}

/**
 * Get message iterator for a bag
 */
async function* bagMessages(bagMeta, topics) {
  if (bagMeta.format === "ros1") {
    yield* ros1Messages(bagMeta.bag, topics);
  } else if (bagMeta.format === "mcap") {
    yield* mcapMessages(bagMeta.filePath, topics);
  } else if (bagMeta.format === "ros2-db3") {
    yield* db3Messages(bagMeta.filePath, topics);
  }
}

module.exports = { loadBagMeta, bagMessages, VIDEO_TYPES };