import { BackgroundFilterController, type EffectRequest } from './background-filter-controller';
import { type VideoFxBlurStrength } from 'amazon-chime-sdk-js';

/**
 * Entry point for the Background Filter comparison POC.
 *
 * Wires the DOM controls to {@link BackgroundFilterController} so a reviewer can
 * toggle between Background Filter 1.0 and 2.0 for blur and replacement, on the
 * same camera, and directly compare foreground-segmentation edge quality.
 */

// Same-origin replacement images served from /public.
const IMAGE_A = '/bg1.jpg';
const IMAGE_B = '/bg-respondent.png';
const SOLID_GREEN = '#00ff00';

const els = {
  status: document.getElementById('status') as HTMLElement,
  log: document.getElementById('log') as HTMLElement,
  video: document.getElementById('preview') as HTMLVideoElement,
  camera: document.getElementById('camera-select') as HTMLSelectElement,
  blurStrength: document.getElementById('blur-strength') as HTMLSelectElement,
  resolution: document.getElementById('resolution') as HTMLSelectElement,
};

function log(message: string): void {
  const timestamp = new Date().toLocaleTimeString();
  els.log.textContent += `[${timestamp}] ${message}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

function setStatus(message: string): void {
  els.status.textContent = message;
}

const controller = new BackgroundFilterController(log);

/** Runs an effect request, refreshes the preview, and reports intrinsic resolution. */
async function run(request: EffectRequest, description: string): Promise<void> {
  try {
    setStatus(`Applying: ${description}`);
    await controller.applyEffect(request);
    controller.bindPreview(els.video);
    reportIntrinsicResolution(description);
    setStatus(`Active: ${description} — inspect the edge around the person`);
  } catch (error) {
    log(`ERROR while applying "${description}": ${String(error)}`);
    setStatus(`Failed: ${description} — see log`);
  }
}

/**
 * Logs the intrinsic video resolution once the new stream produces frames. The
 * 2.0 segmentation mask (176x160) is upscaled to this resolution, so a larger
 * intrinsic size increases the upscale factor at the segmentation edge.
 */
function reportIntrinsicResolution(description: string): void {
  window.setTimeout(() => {
    if (els.video.videoWidth > 0) {
      log(`${description}: intrinsic resolution ${els.video.videoWidth}x${els.video.videoHeight}`);
    }
  }, 350);
}

function selectedBlurStrength(): VideoFxBlurStrength {
  return els.blurStrength.value as VideoFxBlurStrength;
}

function bindControls(): void {
  const onClick = (id: string, handler: () => Promise<void>): void => {
    document.getElementById(id)?.addEventListener('click', () => void handler());
  };

  // Background Filter 2.0 — VideoFxProcessor.
  onClick('btn-none', () => run({ generation: 'v2', effect: 'none' }, 'None (raw camera)'));
  onClick('btn-blur2', () =>
    run({ generation: 'v2', effect: 'blur', blurStrength: selectedBlurStrength() }, `Blur 2.0 (${selectedBlurStrength()})`),
  );
  onClick('btn-image2-bg1', () =>
    run({ generation: 'v2', effect: 'replacement', imageUrl: IMAGE_A }, 'Replacement 2.0 (image A)'),
  );
  onClick('btn-image2-resp', () =>
    run({ generation: 'v2', effect: 'replacement', imageUrl: IMAGE_B }, 'Replacement 2.0 (image B)'),
  );
  onClick('btn-color2', () =>
    run({ generation: 'v2', effect: 'replacement', color: SOLID_GREEN }, 'Replacement 2.0 (solid green)'),
  );

  // Background Filter 1.0 — legacy processors.
  onClick('btn-blur1', () => run({ generation: 'v1', effect: 'blur' }, 'Blur 1.0'));
  onClick('btn-image1-bg1', () =>
    run({ generation: 'v1', effect: 'replacement', imageUrl: IMAGE_A }, 'Replacement 1.0 (image A)'),
  );
  onClick('btn-image1-resp', () =>
    run({ generation: 'v1', effect: 'replacement', imageUrl: IMAGE_B }, 'Replacement 1.0 (image B)'),
  );

  // Camera / resolution.
  onClick('btn-apply-settings', applyCameraSettings);
  els.camera.addEventListener('change', () => void applyCameraSettings());
}

async function applyCameraSettings(): Promise<void> {
  const deviceId = els.camera.value;
  const [width, height] = parseResolution(els.resolution.value);
  await controller.selectCamera({ deviceId, width, height });
  controller.bindPreview(els.video);
  reportIntrinsicResolution('Camera/resolution');
  setStatus('Camera/resolution applied — now pick an effect');
}

function parseResolution(value: string): [number | undefined, number | undefined] {
  if (!value) {
    return [undefined, undefined];
  }
  const [width, height] = value.split('x').map(Number);
  return [width, height];
}

function populateCameras(devices: MediaDeviceInfo[]): void {
  els.camera.innerHTML = '';
  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || device.deviceId.slice(0, 12);
    els.camera.appendChild(option);
  }
}

async function bootstrap(): Promise<void> {
  try {
    setStatus('Requesting camera permission…');
    const devices = await controller.initialize();
    populateCameras(devices);
    bindControls();
    await run({ generation: 'v2', effect: 'none' }, 'None (raw camera)');
    log('Ready. Compare 1.0 (256x144 model) against 2.0 (176x160 model) — same person, same camera.');
  } catch (error) {
    log(`FATAL: ${String(error)}`);
    setStatus('Failed to start — see log');
  }
}

void bootstrap();