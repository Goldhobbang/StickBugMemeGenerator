# StickBugMemeGenerator

A browser-only meme animation editor with Stick Bug, RickRoll, and Custom GIF/Video targets.

**Live:** https://goldhobbang.github.io/StickBugMemeGenerator/

## GIF / video import

1. Select **Custom GIF / Video · Auto Trace**.
2. Upload a GIF or browser-playable MP4, WebM, MOV or M4V video. Browser codec support varies.
3. Choose **IN/OUT** frames to trim the clip.
4. Roughly sketch around the subject on the selected IN frame.
5. Press **Local edge trace**, or optionally **AI refine object** for on-device segmentation.
6. Adjust **Detail**, maximum lines and extraction mode, and edit the generated lines.
7. Upload the starting still image and draw its source strokes.
8. Preview and adjust the six-stage timeline.
9. Choose **GIF** or **Video** as the output, generate, then download.

## Video input limits

- Video is decoded locally using the browser's video decoder and Canvas; no cloud API key is needed.
- Maximum upload: 100 MB, 20-second duration. Sampled at 15 fps, downscaled to 512 pixels along the longest side, with a 180 MB decoded-memory cap.
- IN and OUT refer to sampled frames, not perfect original video cuts.
- The source audio is not transferred; GIF and video outputs are silent.
- A valid MP4 or MOV container can still fail if its codec is not supported by the current browser.
- Existing GIF uploads remain supported (20 MB max; original GIF source timing preserved).

## Output format

- **Animated GIF:** existing gifenc encoding pipeline, with accurate centisecond GIF source delays.
- **Video:** MediaRecorder from the shared transformation renderer, preferring MP4/H.264 when supported or WebM otherwise.
- Video output works with all target variations, including Stick Bug and RickRoll presets.
- The video format selection is disabled if MediaRecorder or Canvas capture is unavailable.
- Keep the tab visible during video export. Recording happens in real time, supports Cancel, and uses the configured output FPS.
- Video exports are capped at 90 seconds and 1920×1080 pixel output area.
- The recorded output is transcoded video, not bitstream remuxing. Real-world frame pacing depends on the browser.

## Editing

- Sketch a closed loop around one object, and choose local edge trace or optional on-device MagicTouch AI.
- Use **Include object point** / **Exclude background point** and **Undo AI hint** to refine the AI segmentation mask.
- Adjust precision (0-100%), maximum lines, and outer/inner contour settings before manually correcting line endpoints.
- Regenerating automatic segments replaces prior manual target edits; adjust detail first.
- Existing mapping, virtual stroke cloning, timeline, previews, and GIF export remain available.

## Development

    npm ci
    npm run dev
    npm run build

Build runs TypeScript and Vite. GitHub Actions deploys GitHub Pages. A passing build does not establish runtime video codec/MediaRecorder compatibility or AI inference quality.

## Main source modules

- src/core/gifDecoder.ts — GIF decoder
- src/core/videoDecoder.ts — local video sampling
- src/core/videoRecorder.ts — real-time MP4/WebM recording
- src/core/customGifPanel.ts — source clip selection, ROI tracing
- src/core/autoTrace.ts — contour simplification
- src/core/onDeviceSegmentation.ts — optional on-device segmentation
- src/core/segmentMapping.ts — source and target stroke correspondence
- src/core/timelineEditor.ts — six-stage timeline
- src/main.ts — app state and output routing
