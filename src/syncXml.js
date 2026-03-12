/**
 * src/syncXml.js
 * Generate bagpipe_sync.xml describing timestamp relationships between
 * CSV files, video files, and multiple bags.
 */

const { create } = require("xmlbuilder2");

/**
 * @param {Object[]} bagExports  - Array of per-bag export info
 * @param {Object}   opts
 * @param {boolean}  opts.perBag - true = single-bag file inside bag subfolder
 *                                 (paths are relative to that folder, no offset table)
 *                                 false/undefined = global file at output root
 */
function generateSyncXml(bagExports, opts = {}) {
  const { perBag = false } = opts;

  const root = create({ version: "1.0", encoding: "UTF-8" }).ele("BagpipeSync", {
    version: "1.0",
    generated: new Date().toISOString(),
    mode: perBag ? "single" : "multi",
  });

  const globalStart = Math.min(...bagExports.map((b) => b.startTimeSec));
  const globalEnd   = Math.max(...bagExports.map((b) => b.endTimeSec));

  root.ele("GlobalTimeline", {
    startSec:    globalStart.toFixed(9),
    endSec:      globalEnd.toFixed(9),
    durationSec: (globalEnd - globalStart).toFixed(9),
    bagCount:    bagExports.length,
  });

  const bagsEl = root.ele("Bags");

  for (const bagExport of bagExports) {
    const offsetSec = (bagExport.startTimeSec - globalStart).toFixed(9);
    const bagEl = bagsEl.ele("Bag", {
      name:                    bagExport.bagName,
      file:                    bagExport.bagFile,
      format:                  bagExport.format,
      startSec:                bagExport.startTimeSec.toFixed(9),
      endSec:                  bagExport.endTimeSec.toFixed(9),
      durationSec:             (bagExport.endTimeSec - bagExport.startTimeSec).toFixed(9),
      offsetFromGlobalStartSec: offsetSec,
    });

    const topicsEl = bagEl.ele("Topics");

    for (const topic of bagExport.topics) {
      // In per-bag mode, strip the leading subfolder from the path so the
      // XML is portable — paths are relative to the bagpipe_sync.xml file itself.
      const outputFile = perBag
        ? require("path").basename(topic.outputFile)
        : topic.outputFile;

      if (topic.type === "csv") {
        topicsEl.ele("Topic", {
          name:        topic.topicName,
          messageType: topic.messageType,
          outputFile,
          type:        "csv",
          rowCount:    topic.rowCount || 0,
          startSec:    (topic.firstTimestampSec  || bagExport.startTimeSec).toFixed(9),
          endSec:      (topic.lastTimestampSec   || bagExport.endTimeSec).toFixed(9),
        });
      } else if (topic.type === "video") {
        const rosTimespan = (topic.lastTimestampSec  || bagExport.endTimeSec) -
                            (topic.firstTimestampSec || bagExport.startTimeSec);
        const videoSpeed = topic.durationSec > 0
          ? rosTimespan / topic.durationSec
          : 1.0;

        topicsEl.ele("Topic", {
          name:                    topic.topicName,
          messageType:             topic.messageType,
          outputFile,
          type:                    "video",
          frameCount:              topic.frameCount || 0,
          fps:                     topic.fps || 0,
          videoDurationSec:        (topic.durationSec || 0).toFixed(6),
          rosStartSec:             (topic.firstTimestampSec || bagExport.startTimeSec).toFixed(9),
          rosEndSec:               (topic.lastTimestampSec  || bagExport.endTimeSec).toFixed(9),
          rosTimespan:             rosTimespan.toFixed(9),
          rosSecondsPerVideoSecond: videoSpeed.toFixed(9),
        });
      }
    }
  }

  // Multi-bag offset table — only in global mode with more than one bag
  if (!perBag && bagExports.length > 1) {
    const refBag = bagExports.reduce((a, b) =>
      a.startTimeSec <= b.startTimeSec ? a : b
    );
    const offsetsEl = root.ele("BagOffsets", {
      referenceBag: refBag.bagName,
    });
    for (const bagA of bagExports) {
      for (const bagB of bagExports) {
        if (bagA.bagName === bagB.bagName) continue;
        offsetsEl.ele("Offset", {
          from:      bagA.bagName,
          to:        bagB.bagName,
          offsetSec: (bagB.startTimeSec - bagA.startTimeSec).toFixed(9),
        });
      }
    }
  }

  return root.end({ prettyPrint: true });
}

module.exports = { generateSyncXml };