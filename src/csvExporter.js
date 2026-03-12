/**
 * src/csvExporter.js
 * Flatten ROS messages to CSV rows
 */

const fs = require("fs");
const path = require("path");

/**
 * Recursively flatten a ROS message object into dot-notation columns
 * e.g. { header: { stamp: { sec: 1 } } } => { "header.stamp.sec": 1 }
 */
function flattenMessage(obj, prefix = "") {
  const result = {};

  if (obj === null || obj === undefined) return result;

  if (typeof obj !== "object" || obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
    result[prefix] = obj instanceof Uint8Array || Buffer.isBuffer(obj)
      ? `[binary ${obj.length} bytes]`
      : obj;
    return result;
  }

  if (Array.isArray(obj)) {
    // For short arrays inline them; for long binary arrays summarize
    if (obj.length > 64) {
      result[prefix] = `[array len=${obj.length}]`;
    } else {
      obj.forEach((item, i) => {
        Object.assign(result, flattenMessage(item, `${prefix}[${i}]`));
      });
    }
    return result;
  }

  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    Object.assign(result, flattenMessage(val, fullKey));
  }

  return result;
}

/**
 * Convert ROS timestamp to seconds (float string)
 */
function tsToSec(ts) {
  return (ts.sec + ts.nsec / 1e9).toFixed(9);
}

/**
 * Export messages for a single non-video topic to CSV.
 * Streams rows to disk — never holds all rows in memory.
 */
async function exportTopicToCsv(messages, outputPath) {
  const timestampLog = [];
  let headers = null;
  let rowCount = 0;
  let writeStream = null;

  // We need headers from the first row before we can open the stream,
  // so buffer only the first row then open + flush immediately after.
  let firstRow = null;

  for await (const msg of messages) {
    const tsStr = tsToSec(msg.timestamp);
    let flat;

    if (msg.isRaw) {
      flat = { _data_bytes: msg.data?.length || 0 };
    } else {
      flat = flattenMessage(msg.data);
    }

    const row = { timestamp_sec: tsStr, ...flat };

    // Merge any new columns into headers
    if (!headers) {
      headers = Object.keys(row);
    } else {
      for (const k of Object.keys(row)) {
        if (!headers.includes(k)) headers.push(k);
      }
    }

    if (!writeStream) {
      // Open file and write header line
      writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
      // We'll write the header after seeing the first row so we have all columns
      firstRow = row;
    } else {
      if (firstRow) {
        // Now we have at least two rows — safe to write header + first row
        writeStream.write(headers.join(',') + '\n');
        writeStream.write(formatRow(firstRow, headers) + '\n');
        firstRow = null;
      }
      writeStream.write(formatRow(row, headers) + '\n');
    }

    timestampLog.push({ index: rowCount, timestampSec: parseFloat(tsStr) });
    rowCount++;
  }

  if (rowCount === 0) {
    fs.writeFileSync(outputPath, 'timestamp_sec\n');
    return { rowCount: 0, timestampLog };
  }

  // If only one row came through, firstRow is still pending
  if (!writeStream) {
    fs.writeFileSync(outputPath, 'timestamp_sec\n');
    return { rowCount: 0, timestampLog };
  }

  if (firstRow) {
    // Only one row total
    writeStream.write(headers.join(',') + '\n');
    writeStream.write(formatRow(firstRow, headers) + '\n');
    firstRow = null;
  }

  await new Promise((resolve, reject) => {
    writeStream.end((err) => err ? reject(err) : resolve());
  });

  return { rowCount, timestampLog };
}

function formatRow(row, headers) {
  return headers.map((h) => {
    const val = row[h] ?? '';
    const str = String(val);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"`
      : str;
  }).join(',');
}

module.exports = { exportTopicToCsv, flattenMessage, tsToSec };