# ROS Bag Exporter

Export ROS1 (`.bag`), ROS2 (`.db3`), and MCAP (`.mcap`) bag files to:
- **CSV** — for any data topic
- **MP4** — for image/video topics (`sensor_msgs/Image`, `CompressedImage`, etc.)
- **sync.xml** — timestamp index linking CSVs, videos, and multi-bag offsets

Zero Python dependency. Uses Node.js only.

---

## Installation

```bash
npm install
```

> **Windows users:** no Python, no OpenSSL issues. All dependencies are pure JS or bundled binaries (`ffmpeg-static`).

### Optional: ROS2 `.db3` support

```bash
npm install better-sqlite3
```

---

## CLI Usage

### Inspect a bag

```bash
node cli/index.js info --bag my_recording.bag
```

Output:
```
✔ Loaded my_recording (ros1)

Bag:         /path/to/my_recording.bag
Format:      ros1
Start:       1693000000.000 s
Duration:    42.500 s

Topics (5):
  /imu/data          sensor_msgs/Imu          (1020 msgs)
  /gps/fix           sensor_msgs/NavSatFix    (425 msgs)
  /camera/image_raw  sensor_msgs/Image        (1275 msgs)  [VIDEO]
  /cmd_vel           geometry_msgs/Twist      (850 msgs)
  /odom              nav_msgs/Odometry        (425 msgs)
```

### Export all topics

```bash
node cli/index.js export --bags recording.bag --output ./out
```

### Export specific topics from multiple bags

```bash
node cli/index.js export \
  --bags session1.bag session2.mcap \
  --output ./exports \
  --topics /imu/data /camera/image_raw /odom
```

### Options

| Flag | Description |
|------|-------------|
| `--bags <paths...>` | One or more bag files |
| `--output <dir>` | Output directory (created if missing) |
| `--topics <names...>` | Topic names to export (default: all) |
| `--no-sync` | Skip sync.xml generation |
| `--no-video` | Skip MP4 export (CSV only) |

---

## Electron App

```bash
npm run electron
```

### Features

- **Drag & drop** bag files onto the app
- **Auto-detects** video vs data topics by message type
- **Drag-and-drop topic ordering** — reorder topics between groups
- **Per-bag topic selection** — checkboxes with select all/none
- **Toggle** sync.xml, video, and CSV export independently
- **Live progress** log during export

---

## Output Structure

```
output/
├── sync.xml                      ← cross-bag timestamp manifest
├── session1/
│   ├── __imu__data.csv           ← /imu/data topic
│   ├── __odom.csv                ← /odom topic
│   └── __camera__image_raw.mp4  ← /camera/image_raw topic
└── session2/
    ├── __imu__data.csv
    └── __camera__image_raw.mp4
```

---

## sync.xml Format

```xml
<RosBagExport version="1.0" generated="2024-01-15T10:30:00Z">

  <GlobalTimeline
    startSec="1693000000.000"
    endSec="1693000085.200"
    durationSec="85.200"
    bagCount="2" />

  <Bags>
    <Bag name="session1" format="ros1"
         startSec="1693000000.000" endSec="1693000042.500"
         offsetFromGlobalStartSec="0.000000000">

      <Topics>
        <Topic name="/imu/data" type="csv" outputFile="session1/__imu__data.csv" rowCount="1020">
          <TimestampIndex count="1020">
            <Row index="0"   timestampSec="1693000000.012" offsetFromBagStartSec="0.012" />
            <Row index="1"   timestampSec="1693000000.022" offsetFromBagStartSec="0.022" />
            ...
          </TimestampIndex>
        </Topic>

        <Topic name="/camera/image_raw" type="video"
               outputFile="session1/__camera__image_raw.mp4"
               frameCount="1275" fps="30" durationSec="42.500">
          <FrameIndex count="1275">
            <Frame index="0"  timestampSec="1693000000.033" offsetFromBagStartSec="0.033" />
            <Frame index="1"  timestampSec="1693000000.066" offsetFromBagStartSec="0.066" />
            ...
          </FrameIndex>
        </Topic>
      </Topics>
    </Bag>

    <Bag name="session2" format="mcap"
         offsetFromGlobalStartSec="42.700000000">
      ...
    </Bag>
  </Bags>

  <!-- Multi-bag time offsets -->
  <BagOffsets referenceBag="session1">
    <Offset from="session1" to="session2" offsetSec="42.700000000" />
    <Offset from="session2" to="session1" offsetSec="-42.700000000" />
  </BagOffsets>

</RosBagExport>
```

---

## Supported Message Types

### Auto-detected as video (→ MP4):
- `sensor_msgs/Image`
- `sensor_msgs/msg/Image`
- `sensor_msgs/CompressedImage`
- `sensor_msgs/msg/CompressedImage`
- `theora_image_transport/Packet`
- `ffmpeg_image_transport_msgs/FFMPEGPacket`

### Supported image encodings:
- `rgb8`, `bgr8`, `mono8`, `bgra8`, `rgba8`

### All other topics → CSV with dot-notation column flattening

---

## Building the Electron App

```bash
npm run build
```

Outputs to `dist/` — creates:
- Windows: `.exe` installer
- macOS: `.dmg`
- Linux: `.AppImage`
