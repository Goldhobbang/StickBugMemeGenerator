# StickBugMemeGenerator

A static, browser-based GIF meme creator with **Stick Bug**, **RickRoll**, and **Custom GIF** target modes.

**Live application:** https://goldhobbang.github.io/StickBugMemeGenerator/

## Custom GIF workflow

1. Select **Custom GIF · Auto Trace** from the variation menu.
2. Upload your `.gif` file (up to 20 MiB, with a decoded-memory guard).
3. Choose **IN** and **OUT** source frames. Only the selected original frames are appended to the final GIF; their centisecond frame delays are preserved.
4. Draw a **rough closed loop around an object** in the IN-frame canvas; release to close it automatically.
5. Choose **Local edge trace** for an offline, deterministic contour estimate. Alternatively, click **AI refine object** to download Google's MagicTouch model and run optional interactive segmentation on-device.
6. Adjust **Detail** (0–100%), **Max lines**, and **Outline/Outline + inner detail**. Automatic vectorization regenerates the target segments.
7. If the AI selected the wrong pixels, choose **Include object point** (green) or **Exclude background point** (red), tap the image, and run **AI refine object** again. **Undo AI hint** removes the latest hint. The AI mask appears as a translucent cyan overlay.\n8. Select **Edit lines** to drag their endpoints or move segments, **Add line** to append, and **Delete selected** to remove unwanted segments. *Make manual edits after tuning detail: regenerating replaces the current auto-generated lines.*
9. In the regular **Image Editor**, upload your starting photo, draw one or more strokes, and optionally map strokes to target lines. The generator virtually clones or subdivides source strokes as needed.
10. Adjust the six-color full GIF timeline (hover frame previews; drag a phase edge to resize just that phase), preview, and choose **Generate GIF** to export.

## Current scope

- Source GIF frames are decoded in the browser. No uploaded image is sent to this application's server.
- Local edge tracing requires **no network connection after the site loads**.
- **AI refine** requires network access to download MediaPipe's JavaScript/WASM runtime and the MagicTouch model, but no API key or inference server. It is an optional/experimental feature; model availability, browser compatibility, and quality vary. If it fails, **Local edge trace** remains available.
- Semantic segmentation accepts a positive object point and optional inclusion/exclusion correction points; contour vectorization and the detail slider separately decide how many lines represent it.
- Rough sketches are hints, not guaranteed exact masks. For the local algorithm, sketches drawn reasonably near the object edge work best.
- Input files are limited to 20 MiB, with a 180 MiB decoded-frame memory guard (also subject to browser memory limits).
- The current project supports **one target object per tracing operation**. Browser-based AI inference is experimental; a successful TypeScript build does not verify model download, inference, or GIF export on all devices. Automatic full-motion tracking and persistent manual correction layers are future enhancements.

## Development

```bash
npm ci
npm run dev
npm run build
```

Build: TypeScript type-check + Vite. Deployment: GitHub Actions → GitHub Pages.

## Key files

- `src/core/gifDecoder.ts`: local GIF decoding and frame safety limits
- `src/core/customGifPanel.ts`: custom clip, sketch, precision, and target-edit UI
- `src/core/autoTrace.ts`: contour snapping, vector simplification, and AI-mask vectorization
- `src/core/onDeviceSegmentation.ts`: optional MediaPipe MagicTouch inference
- `src/core/segmentMapping.ts`: target mapping and virtual stroke cloning
- `src/core/timelineEditor.ts`: six-stage draggable timeline
- `src/main.ts`: end-to-end application state and GIF export
