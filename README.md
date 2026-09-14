# Amazon Chime SDK - Background Filter Edge Quality: 1.0 vs 2.0

A minimal, self-contained reproduction that compares foreground-segmentation
edge quality between the two Amazon Chime SDK for JavaScript background-filter
generations, using the same camera and the same SDK build:

| Generation | Processor | Segmentation model input |
| --- | --- | --- |
| 1.0 (legacy) | BackgroundBlurVideoFrameProcessor / BackgroundReplacementVideoFrameProcessor | 256 x 144 |
| 2.0 (current) | VideoFxProcessor | 176 x 160 |

SDK version under test: amazon-chime-sdk-js@3.32.0.

## Summary of the issue

After migrating background blur / replacement from the 1.0 processors to
VideoFxProcessor (2.0), we observe a soft, semi-transparent halo around the
person silhouette (head, shoulders, hair). Under 1.0 the same subject on the
same camera produces a noticeably tighter, cleaner cutout.

This POC removes our application entirely (no meeting session, no state
management, no framework) so the two generations can be compared side by side on
identical input. The processing pipeline is intentionally identical for both:

```
camera -> VideoFrameProcessor -> DefaultVideoTransformDevice
       -> DefaultDeviceController.startVideoInput -> video element
```

No cropping, scaling, or compositing is performed by this POC. Every
transformation happens inside the SDK.

## What we found

- The halo reproduces in this isolated POC, so it is NOT caused by our
  application layer.
- It reproduces with a solid-color replacement background (the "solid green"
  button), so it is not related to a specific background image or to any
  compositing on our side; it originates in the segmentation mask.
- Tracing the installed SDK, the 2.0 segmentation mask is produced at a fixed
  176 x 160 and upscaled to the stream resolution inside the processor renderer.
  The 1.0 model runs at 256 x 144. The lower 2.0 mask resolution and its upscale
  are consistent with the softer edge we observe.
- The public 2.0 API (VideoFxConfig, VideoFxSpec, processingBudgetPerFrame)
  exposes no setting to control segmentation resolution or edge sharpness.

## Prerequisites

- Node.js 18+ and npm.
- A webcam.
- A browser that supports WebGL2 + WebAssembly + Web Workers (required by the
  SDK background filters).
- Internet access: the background-filter model assets are downloaded at runtime
  from the Amazon Chime SDK asset CDN (https://static.sdkassets.chime.aws).

## Running

Install dependencies, then start the Vite dev server (the `start` script is
aliased to `vite` in package.json):

```
npm install
npm start
```

Then open the printed URL (default http://localhost:5178) and grant camera
permission.

## How to reproduce the comparison

1. Click "Replacement 2.0 (solid green)" and observe the halo along the
   silhouette. The uniform background makes the mask edge easy to see.
2. Compare "Blur 1.0" vs "Blur 2.0", then "Replacement 1.0" vs
   "Replacement 2.0" using the same image. Same subject, same camera.
3. Optionally change "Requested resolution", click "Apply camera / resolution",
   and repeat. Higher capture resolutions increase the mask upscale factor.

The on-screen log records the intrinsic video resolution and which segmentation
model each generation uses.

## Project structure

```
index.html                                 UI and styling
src/main.ts                                DOM wiring and comparison controls
src/background-filter-controller.ts        SDK integration for both 1.0 and 2.0
public/bg1.jpg, public/bg-respondent.png   Same-origin replacement images
```

## Notes

- Background replacement 1.0 accepts an image blob, so the POC fetches the
  same-origin image and passes the blob; 2.0 accepts a direct image URL.
- Both processors are wrapped in a DefaultVideoTransformDevice and applied via
  DefaultDeviceController.startVideoInput, mirroring standard SDK usage.
