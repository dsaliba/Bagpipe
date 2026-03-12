#!/usr/bin/env node
/**
 * cli/index.js
 * Command-line interface for ros-bag-exporter
 *
 * Usage:
 *   ros-bag-exporter export --bags a.bag b.bag --output ./out --topics /imu /cam
 *   ros-bag-exporter info --bag a.bag
 */

const { program } = require("commander");
const chalk = require("chalk");
const ora = require("ora");
const path = require("path");
const fs = require("fs");
const { loadBagMeta } = require("../src/bagReader");
const { exportBags } = require("../src/exporter");

program
  .name("ros-bag-exporter")
  .description("Export ROS1/ROS2 bag topics to CSV, MP4, and sync XML")
  .version("1.0.0");

// ── info command ──────────────────────────────────────────────────────────────
program
  .command("info")
  .description("Print topics and metadata from a bag file")
  .requiredOption("-b, --bag <path>", "Path to .bag, .db3, or .mcap file")
  .action(async (opts) => {
    const spinner = ora(`Loading ${opts.bag}...`).start();
    try {
      const meta = await loadBagMeta(path.resolve(opts.bag));
      spinner.succeed(`Loaded ${meta.name} (${meta.format})`);

      console.log();
      console.log(chalk.bold("Bag:         ") + meta.filePath);
      console.log(chalk.bold("Format:      ") + meta.format);
      const startSec = meta.startTime
        ? (meta.startTime.sec + meta.startTime.nsec / 1e9).toFixed(3)
        : "?";
      const endSec = meta.endTime
        ? (meta.endTime.sec + meta.endTime.nsec / 1e9).toFixed(3)
        : "?";
      const dur = meta.startTime && meta.endTime
        ? ((meta.endTime.sec - meta.startTime.sec) + (meta.endTime.nsec - meta.startTime.nsec) / 1e9).toFixed(3)
        : "?";
      console.log(chalk.bold("Start:       ") + startSec + " s");
      console.log(chalk.bold("End:         ") + endSec + " s");
      console.log(chalk.bold("Duration:    ") + dur + " s");
      console.log();
      console.log(chalk.bold(`Topics (${meta.topics.length}):`));

      const maxLen = Math.max(...meta.topics.map((t) => t.name.length));
      for (const t of meta.topics) {
        const tag = t.isVideo ? chalk.magenta(" [VIDEO]") : "";
        const count = t.messageCount ? chalk.gray(` (${t.messageCount} msgs)`) : "";
        console.log(
          "  " +
            chalk.cyan(t.name.padEnd(maxLen + 2)) +
            chalk.yellow(t.type) +
            count +
            tag
        );
      }
    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

// ── export command ────────────────────────────────────────────────────────────
program
  .command("export")
  .description("Export selected topics from one or more bags")
  .requiredOption(
    "-b, --bags <paths...>",
    "One or more bag files (.bag, .db3, .mcap)"
  )
  .requiredOption("-o, --output <dir>", "Output directory")
  .option(
    "-t, --topics <names...>",
    "Topics to export (default: all). Applied to all bags."
  )
  .option("--no-sync", "Skip generating sync.xml")
  .option("--no-video", "Skip video export (CSV only)")
  .action(async (opts) => {
    const bagPaths = opts.bags.map((b) => path.resolve(b));
    const outputDir = path.resolve(opts.output);

    // Validate files exist
    for (const p of bagPaths) {
      if (!fs.existsSync(p)) {
        console.error(chalk.red(`File not found: ${p}`));
        process.exit(1);
      }
    }

    console.log(chalk.bold("\nROS Bag Exporter"));
    console.log(chalk.gray("─".repeat(40)));
    console.log(`Bags:    ${bagPaths.map((b) => path.basename(b)).join(", ")}`);
    console.log(`Output:  ${outputDir}`);
    if (opts.topics) console.log(`Topics:  ${opts.topics.join(", ")}`);
    console.log(chalk.gray("─".repeat(40)) + "\n");

    const spinner = ora("Exporting...").start();

    // Build topic selection map (same topics applied to all bags)
    const topicSelection = {};
    if (opts.topics) {
      for (const bp of bagPaths) {
        topicSelection[bp] = opts.topics;
      }
    }

    try {
      const result = await exportBags({
        bagPaths,
        outputDir,
        topicSelection,
        generateSync: opts.sync !== false,
        onProgress: ({ bag, topic, stage, pct }) => {
          const label = topic
            ? `${bag} / ${topic} — ${stage}`
            : `${bag} — ${stage}`;
          spinner.text = label + (pct != null ? ` ${pct}%` : "");
        },
      });

      spinner.succeed("Export complete!");
      console.log();

      for (const bag of result.bags) {
        console.log(chalk.bold(`📦 ${bag.bagName}`));
        console.log(`   Duration: ${(bag.endTimeSec - bag.startTimeSec).toFixed(3)} s`);
        for (const topic of bag.topics) {
          const icon = topic.type === "video" ? "🎥" : "📊";
          const detail =
            topic.type === "video"
              ? `${topic.frameCount} frames, ${topic.fps} fps`
              : `${topic.rowCount} rows`;
          console.log(
            `   ${icon} ${chalk.cyan(topic.topicName)} → ${chalk.gray(topic.outputFile)} (${detail})`
          );
        }
        console.log();
      }

      if (opts.sync !== false) {
        console.log(chalk.green(`✅ sync.xml written to ${outputDir}`));
      }
    } catch (err) {
      spinner.fail("Export failed: " + err.message);
      if (process.env.DEBUG) console.error(err);
      process.exit(1);
    }
  });

program.parse();
