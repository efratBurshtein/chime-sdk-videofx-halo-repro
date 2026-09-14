import {
  BackgroundBlurVideoFrameProcessor,
  BackgroundReplacementVideoFrameProcessor,
  ConsoleLogger,
  DefaultDeviceController,
  DefaultVideoTransformDevice,
  LogLevel,
  VideoFxProcessor,
  type Device,
  type Logger,
  type VideoFrameProcessor,
  type VideoFxBlurStrength,
  type VideoFxConfig,
} from 'amazon-chime-sdk-js';

/**
 * Which Amazon Chime SDK background-filter generation to apply.
 *
 * - `v1` uses the legacy `BackgroundBlurVideoFrameProcessor` /
 *   `BackgroundReplacementVideoFrameProcessor` (segmentation model 256x144).
 * - `v2` uses the current `VideoFxProcessor` (segmentation model 176x160).
 */
export type FilterGeneration = 'v1' | 'v2';

/** The visual effect to apply. */
export type EffectKind = 'none' | 'blur' | 'replacement';

/** Optional camera constraints for reproducing the issue at a given resolution. */
export interface CameraSelection {
  deviceId: string;
  width?: number;
  height?: number;
}

/** A fully described request to apply to the local video stream. */
export interface EffectRequest {
  generation: FilterGeneration;
  effect: EffectKind;
  /** Same-origin image URL for replacement (used by both v1 and v2). */
  imageUrl?: string;
  /** Solid replacement color (v2 only, e.g. '#00ff00'). Highlights the mask edge. */
  color?: string;
  /** Blur strength (v2 only). v1 blur uses a fixed pixel radius. */
  blurStrength?: VideoFxBlurStrength;
}

const LEGACY_BLUR_PIXELS = 15;

/**
 * Owns the local camera video input and applies Amazon Chime SDK background
 * filters to it, so a single foreground person can be compared under both the
 * legacy (1.0) and current (2.0) segmentation engines with identical input.
 *
 * The processing pipeline is intentionally minimal and identical for both
 * generations: `camera -> VideoFrameProcessor -> DefaultVideoTransformDevice ->
 * DefaultDeviceController.startVideoInput`. No cropping, scaling, or compositing
 * is performed by this POC; every transformation happens inside the SDK.
 */
export class BackgroundFilterController {
  private readonly logger: Logger;
  private readonly deviceController: DefaultDeviceController;

  private transformDevice: DefaultVideoTransformDevice | null = null;
  /** Retained 2.0 processor, reused across 2.0 effect changes via setEffectConfig. */
  private videoFxProcessor: VideoFxProcessor | null = null;
  private selectedCamera: CameraSelection | null = null;

  constructor(onLog: (message: string) => void) {
    this.logger = new ConsoleLogger('BackgroundFilterPOC', LogLevel.INFO);
    this.deviceController = new DefaultDeviceController(this.logger, { enableWebAudio: false });
    this.log = onLog;
  }

  private readonly log: (message: string) => void;

  /** Requests camera permission and returns the available video input devices. */
  async initialize(): Promise<MediaDeviceInfo[]> {
    await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = await this.deviceController.listVideoInputDevices();
    if (devices.length > 0) {
      this.selectedCamera = { deviceId: devices[0].deviceId };
    }
    this.log(`Cameras: ${devices.map((d) => d.label || d.deviceId.slice(0, 8)).join(', ') || 'none'}`);
    return devices;
  }

  /** Renders the current video input into the given <video> element. */
  bindPreview(videoElement: HTMLVideoElement): void {
    this.deviceController.startVideoPreviewForVideoInput(videoElement);
  }

  /** Updates the active camera / requested resolution and restarts as raw input. */
  async selectCamera(selection: CameraSelection): Promise<void> {
    this.selectedCamera = selection;
    await this.applyEffect({ generation: 'v2', effect: 'none' });
  }

  /**
   * Applies the requested effect to the local video input. Any previously active
   * transform device is fully stopped first, so each comparison starts clean.
   */
  async applyEffect(request: EffectRequest): Promise<void> {
    await this.teardownActiveTransform();

    const device = this.buildInputDevice();

    if (request.effect === 'none') {
      await this.deviceController.startVideoInput(device);
      return;
    }

    const processor =
      request.generation === 'v2'
        ? await this.createV2Processor(request)
        : await this.createV1Processor(request);

    if (!processor) {
      this.log(`Background filter ${request.generation} is not supported; falling back to raw camera.`);
      await this.deviceController.startVideoInput(device);
      return;
    }

    this.transformDevice = new DefaultVideoTransformDevice(this.logger, device, [processor]);
    await this.deviceController.startVideoInput(this.transformDevice);
  }

  /**
   * Creates (or reuses) a 2.0 `VideoFxProcessor` and applies the effect config.
   * Segmentation runs at a fixed 176x160 and the mask is upscaled to the stream
   * resolution inside the processor's WebGL renderer.
   */
  private async createV2Processor(request: EffectRequest): Promise<VideoFxProcessor | null> {
    if (!(await VideoFxProcessor.isSupported(this.logger))) {
      return null;
    }
    const config = this.buildVideoFxConfig(request);
    if (!this.videoFxProcessor) {
      this.videoFxProcessor = await VideoFxProcessor.create(this.logger, config);
      this.log('Created VideoFxProcessor (2.0, segmentation model 176x160).');
    } else {
      await this.videoFxProcessor.setEffectConfig(config);
    }
    return this.videoFxProcessor;
  }

  /**
   * Creates a legacy 1.0 processor. Background replacement 1.0 accepts an image
   * blob (not a URL), so the same-origin image is fetched here. Segmentation runs
   * at the selfie-segmentation model resolution (256x144).
   */
  private async createV1Processor(request: EffectRequest): Promise<VideoFrameProcessor | null> {
    if (request.effect === 'blur') {
      if (!(await BackgroundBlurVideoFrameProcessor.isSupported())) {
        return null;
      }
      const processor = await BackgroundBlurVideoFrameProcessor.create(undefined, {
        blurStrength: LEGACY_BLUR_PIXELS,
      });
      this.log('Created BackgroundBlurVideoFrameProcessor (1.0, segmentation model 256x144).');
      return processor ?? null;
    }

    if (!(await BackgroundReplacementVideoFrameProcessor.isSupported())) {
      return null;
    }
    const imageBlob = await this.fetchImageBlob(request.imageUrl ?? '');
    const processor = await BackgroundReplacementVideoFrameProcessor.create(undefined, { imageBlob });
    this.log('Created BackgroundReplacementVideoFrameProcessor (1.0, segmentation model 256x144).');
    return processor ?? null;
  }

  /** Builds a 2.0 VideoFxConfig for the requested effect (blur / image / color). */
  private buildVideoFxConfig(request: EffectRequest): VideoFxConfig {
    if (request.effect === 'blur') {
      return {
        backgroundBlur: { isEnabled: true, strength: request.blurStrength ?? 'high' },
        backgroundReplacement: { isEnabled: false, backgroundImageURL: undefined, defaultColor: undefined },
      };
    }
    return {
      backgroundBlur: { isEnabled: false, strength: 'high' },
      backgroundReplacement: {
        isEnabled: true,
        backgroundImageURL: request.imageUrl,
        defaultColor: request.imageUrl ? undefined : request.color,
      },
    };
  }

  /** Resolves the SDK `Device` for the active camera, honoring requested resolution. */
  private buildInputDevice(): Device {
    const camera = this.selectedCamera;
    if (!camera) {
      throw new Error('No camera selected.');
    }
    if (camera.width && camera.height) {
      return {
        deviceId: camera.deviceId,
        width: { ideal: camera.width },
        height: { ideal: camera.height },
      } as unknown as Device;
    }
    return camera.deviceId as Device;
  }

  private async fetchImageBlob(url: string): Promise<Blob> {
    const response = await fetch(url);
    return response.blob();
  }

  /** Fully stops and releases the active transform device and retained processor. */
  private async teardownActiveTransform(): Promise<void> {
    if (this.transformDevice) {
      try {
        await this.transformDevice.stop();
      } catch {
        // Ignore: stopping an already-stopped device is harmless for this POC.
      }
      this.transformDevice = null;
    }
    // v1 and v2 use different processor types; drop the retained 2.0 processor so
    // switching generations always builds a fresh processor.
    this.videoFxProcessor = null;
  }
}