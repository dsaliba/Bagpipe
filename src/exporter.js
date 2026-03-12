/**
 * src/exporter.js
 * Main export pipeline — shared by CLI and Electron
 */

const fs = require("fs");
const path = require("path");
const { loadBagMeta, bagMessages } = require("./bagReader");
const { exportTopicToCsv } = require("./csvExporter");
const { exportVideoTopic } = require("./videoExporter");
const { generateSyncXml } = require("./syncXml");

/**
 * Export one or more bag files
 *
 * @param {Object} options
 * @param {string[]} options.bagPaths        - Paths to .bag/.db3/.mcap files
 * @param {string}   options.outputDir       - Root output directory
 * @param {Object}   options.topicSelection  - { [bagPath]: string[] } selected topic names
 * @param {boolean}  options.generateSync    - Whether to write sync.xml
 * @param {Function} options.onProgress      - progress callback({ bag, topic, stage, pct })
 *
 * @returns {Object} { success: true, outputDir, bags: [...] }
 */
async function exportBags(options) {
  const {
    bagPaths,
    outputDir,
    topicSelection = {},
    generateSync = true,
    onProgress = () => {},
  } = options;

  fs.mkdirSync(outputDir, { recursive: true });

  const bagExports = [];

  for (let bi = 0; bi < bagPaths.length; bi++) {
    const bagPath = bagPaths[bi];
    onProgress({ bag: bagPath, stage: "loading", pct: 0 });

    let bagMeta;
    try {
      bagMeta = await loadBagMeta(bagPath);
    } catch (err) {
      throw new Error(`Failed to load bag ${bagPath}: ${err.message}`);
    }

    const bagOutDir = path.join(outputDir, sanitizeName(bagMeta.name));
    fs.mkdirSync(bagOutDir, { recursive: true });

    // Determine which topics to export — no fallback to "all", empty = skip bag
    const selectedTopics = (
      topicSelection[bagPath] ||
      topicSelection[bagMeta.name] ||
      []
    ).filter(Boolean);

    if (selectedTopics.length === 0) {
      onProgress({ bag: bagMeta.name, stage: "skipped (no topics selected)", pct: 100 });
      continue;
    }

    const topicMeta = Object.fromEntries(
      bagMeta.topics.map((t) => [t.name, t])
    );

    const exportedTopics = [];
    const totalTopics = selectedTopics.length;

    for (let ti = 0; ti < selectedTopics.length; ti++) {
      const topicName = selectedTopics[ti];
      const meta = topicMeta[topicName];
      if (!meta) continue;

      const safeName = sanitizeName(topicName.replace(/\//g, "__").replace(/^__/, ""));
      const pct = Math.round((ti / totalTopics) * 100);
      onProgress({ bag: bagMeta.name, topic: topicName, stage: "exporting", pct });

      if (meta.isVideo) {
        const outFile = path.join(bagOutDir, `${safeName}.mp4`);
        const msgs = bagMessages(bagMeta, [topicName]);

        let videoResult;
        try {
          videoResult = await exportVideoTopic(msgs, outFile, (msg) => {
            onProgress({ bag: bagMeta.name, topic: topicName, stage: msg, pct });
          });
        } catch (err) {
          console.error(`Video export failed for ${topicName}: ${err.message}`);
          videoResult = { frameCount: 0, frameLog: [], durationSec: 0, fps: 0 };
        }

        const frameLog = videoResult.frameLog || [];
        exportedTopics.push({
          topicName,
          messageType: meta.type,
          outputFile: path.relative(outputDir, outFile),
          type: "video",
          frameCount: videoResult.frameCount,
          fps: videoResult.fps,
          durationSec: videoResult.durationSec,
          firstTimestampSec: frameLog.length > 0 ? frameLog[0].timestampSec : null,
          lastTimestampSec: frameLog.length > 0 ? frameLog[frameLog.length - 1].timestampSec : null,
        });
      } else {
        const outFile = path.join(bagOutDir, `${safeName}.csv`);
        const msgs = bagMessages(bagMeta, [topicName]);

        let csvResult;
        try {
          csvResult = await exportTopicToCsv(msgs, outFile);
        } catch (err) {
          console.error(`CSV export failed for ${topicName}: ${err.message}`);
          csvResult = { rowCount: 0, timestampLog: [] };
        }

        const tsLog = csvResult.timestampLog || [];
        exportedTopics.push({
          topicName,
          messageType: meta.type,
          outputFile: path.relative(outputDir, outFile),
          type: "csv",
          rowCount: csvResult.rowCount,
          firstTimestampSec: tsLog.length > 0 ? tsLog[0].timestampSec : null,
          lastTimestampSec: tsLog.length > 0 ? tsLog[tsLog.length - 1].timestampSec : null,
        });
      }
    }

    const startTimeSec =
      bagMeta.startTime
        ? bagMeta.startTime.sec + bagMeta.startTime.nsec / 1e9
        : 0;
    const endTimeSec =
      bagMeta.endTime
        ? bagMeta.endTime.sec + bagMeta.endTime.nsec / 1e9
        : 0;

    const bagExportData = {
      bagName: bagMeta.name,
      bagFile: path.basename(bagPath),
      format: bagMeta.format,
      startTimeSec,
      endTimeSec,
      topics: exportedTopics,
      outDir: bagOutDir,
    };

    bagExports.push(bagExportData);

    // Write per-bag sync XML into this bag's subfolder
    if (generateSync) {
      const bagXmlContent = generateSyncXml([bagExportData], { perBag: true });
      const bagXmlPath = path.join(bagOutDir, "bagpipe_sync.xml");
      fs.writeFileSync(bagXmlPath, bagXmlContent, "utf8");
    }

    onProgress({ bag: bagMeta.name, stage: "done", pct: 100 });
  }

  // Write global multi-bag sync XML at the output root (only when >1 bag)
  if (generateSync && bagExports.length > 0) {
    const globalXmlContent = generateSyncXml(bagExports, { perBag: false });
    const globalXmlPath = path.join(outputDir, "bagpipe_sync.xml");
    fs.writeFileSync(globalXmlPath, globalXmlContent, "utf8");
  }

  return { success: true, outputDir, bags: bagExports };
}

/**
 * Sanitize a string for use as a filename
 */
function sanitizeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-\.]/g, "_").replace(/_{2,}/g, "_").slice(0, 128);
}

module.exports = { exportBags, sanitizeName };