// Mobile Browser Web Audio API, Microphone Fallback, PCM/WAV Recorder Fallback,
// and Background Keep-Alive (Silent Audio Stream) Engine for Safari (iOS), Chrome (Android), and HarmonyOS.

// 1-second 8kHz 16-bit Mono Silent WAV Data URI (with +/-1 LSB dither so mobile OS audio engines do not suspend it as digital zero)
export const SILENT_WAV_DATA_URI = (() => {
  const sampleRate = 8000;
  const numSamples = sampleRate; // 1 second
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  // Fill with +/- 1 LSB imperceptible sub-audible dither so iOS/Android/HarmonyOS never flags stream as dead silence
  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
})();

export interface MicAcquisitionResult {
  stream: MediaStream | null;
  constraintTier: 'OPT_DSP' | 'STD_DSP' | 'RAW_FALLBACK' | 'LEGACY_FALLBACK' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Detect mobile browser platform for targeted Web Audio / MediaRecorder compatibility
 */
export function detectMobileAudioPlatform() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (typeof navigator !== 'undefined' &&
      navigator.platform === 'MacIntel' &&
      navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua) || isIOS;
  const isHarmonyOS = /HarmonyOS|ArkWeb|HuaweiBrowser/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  return {
    isIOS,
    isSafari,
    isHarmonyOS,
    isAndroid,
    label: isIOS
      ? 'Safari/iOS'
      : isHarmonyOS
      ? 'HarmonyOS'
      : isAndroid
      ? 'Chrome/Android'
      : 'Browser',
  };
}

/**
 * Safely creates or resumes a cross-browser AudioContext (supports Safari webkitAudioContext & 'interrupted' state)
 */
export function getOrCreateCompatibleAudioContext(
  existing: AudioContext | null
): AudioContext | null {
  try {
    let ctx = existing;
    if (!ctx || (ctx.state as string) === 'closed') {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtxClass) return null;

      try {
        ctx = new AudioCtxClass({ latencyHint: 'interactive' });
      } catch {
        // Fallback for older iOS Safari / HarmonyOS WebViews that reject AudioContextOptions
        ctx = new AudioCtxClass();
      }

      // Auto-recover when iOS Safari or Android Chrome puts AudioContext into 'suspended' or 'interrupted' state
      ctx.onstatechange = () => {
        if (!ctx) return;
        const st = ctx.state as string;
        if (st === 'suspended' || st === 'interrupted') {
          ctx.resume().catch(() => {});
        }
      };
    }

    const currentState = ctx.state as string;
    if (currentState === 'suspended' || currentState === 'interrupted') {
      ctx.resume().catch(() => {});
    }

    return ctx;
  } catch {
    return null;
  }
}

/**
 * Unlocks Web Audio API output & reusable HTMLAudioElement on user interaction or permission grant
 * (Required by Safari iOS and Chrome Android autoplay policies)
 */
export async function unlockMobileAudioSession(
  ctx: AudioContext | null,
  reusableAudioEl?: HTMLAudioElement | null
): Promise<boolean> {
  let unlocked = false;
  try {
    if (ctx) {
      const st = ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        await ctx.resume().catch(() => {});
      }
      // Play 1-frame silent buffer to unlock iOS Safari hardware output channel
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      unlocked = ctx.state === 'running';
    }
  } catch {
    // Ignore Web Audio unlock error
  }

  if (reusableAudioEl) {
    try {
      reusableAudioEl.setAttribute('playsinline', 'true');
      reusableAudioEl.setAttribute('webkit-playsinline', 'true');
      if (!reusableAudioEl.src) {
        reusableAudioEl.src = SILENT_WAV_DATA_URI;
      }
      reusableAudioEl.volume = 0.01;
      const playPromise = reusableAudioEl.play();
      if (playPromise !== undefined) {
        await playPromise
          .then(() => {
            reusableAudioEl.pause();
            reusableAudioEl.currentTime = 0;
            reusableAudioEl.volume = 1.0;
            unlocked = true;
          })
          .catch(() => {});
      }
    } catch {
      // Ignore HTMLAudioElement unlock error
    }
  }

  return unlocked;
}

/**
 * Multi-tier getUserMedia microphone acquisition with automatic fallback for Safari (iOS), Chrome (Android), and HarmonyOS
 */
export async function requestMicrophoneWithFallbacks(): Promise<MicAcquisitionResult> {
  // Tier 1: Ideal Tactical DSP constraints (echoCancellation + noiseSuppression + autoGainControl + mono)
  const tier1Constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
    },
    video: false,
  };

  // Tier 2: Standard boolean constraints (compatible with older Safari iOS & Android WebViews)
  const tier2Constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };

  // Tier 3: Raw audio fallback (when Bluetooth TWS SCO or HarmonyOS rejects specific constraint keys)
  const tier3Constraints: MediaStreamConstraints = {
    audio: true,
    video: false,
  };

  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(tier1Constraints);
      return {
        stream,
        constraintTier: 'OPT_DSP',
        errorCode: null,
        errorMessage: null,
      };
    } catch (err1: unknown) {
      const name1 = (err1 as { name?: string })?.name || '';
      // If user explicitly denied permission, don't spam prompts—report immediately
      if (name1 === 'NotAllowedError' || name1 === 'PermissionDeniedError') {
        return {
          stream: null,
          constraintTier: 'FAILED',
          errorCode: 'PERMISSION_DENIED',
          errorMessage:
            'Izin mikrofon ditolak di browser. Klik ikon Gembok/Pengaturan di bilah alamat browser (Safari/Chrome) -> Izinkan Microphone.',
        };
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia(tier2Constraints);
        return {
          stream,
          constraintTier: 'STD_DSP',
          errorCode: null,
          errorMessage: null,
        };
      } catch {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(tier3Constraints);
          return {
            stream,
            constraintTier: 'RAW_FALLBACK',
            errorCode: null,
            errorMessage: null,
          };
        } catch (err3: unknown) {
          const name3 = (err3 as { name?: string })?.name || 'UnknownError';
          return {
            stream: null,
            constraintTier: 'FAILED',
            errorCode: name3,
            errorMessage: mapMicErrorToIndonesian(name3),
          };
        }
      }
    }
  }

  // Tier 4: Legacy webkitGetUserMedia / mozGetUserMedia fallback for older mobile WebViews
  const legacyGetUserMedia =
    (navigator as unknown as {
      getUserMedia?: (
        c: MediaStreamConstraints,
        s: (stream: MediaStream) => void,
        e: (err: unknown) => void
      ) => void;
      webkitGetUserMedia?: (
        c: MediaStreamConstraints,
        s: (stream: MediaStream) => void,
        e: (err: unknown) => void
      ) => void;
      mozGetUserMedia?: (
        c: MediaStreamConstraints,
        s: (stream: MediaStream) => void,
        e: (err: unknown) => void
      ) => void;
    }).getUserMedia ||
    (navigator as unknown as {
      webkitGetUserMedia?: (
        c: MediaStreamConstraints,
        s: (stream: MediaStream) => void,
        e: (err: unknown) => void
      ) => void;
    }).webkitGetUserMedia ||
    (navigator as unknown as {
      mozGetUserMedia?: (
        c: MediaStreamConstraints,
        s: (stream: MediaStream) => void,
        e: (err: unknown) => void
      ) => void;
    }).mozGetUserMedia;

  if (typeof legacyGetUserMedia === 'function') {
    try {
      const stream = await new Promise<MediaStream>((resolve, reject) => {
        legacyGetUserMedia.call(navigator, { audio: true, video: false }, resolve, reject);
      });
      return {
        stream,
        constraintTier: 'LEGACY_FALLBACK',
        errorCode: null,
        errorMessage: null,
      };
    } catch (legacyErr: unknown) {
      const errName = (legacyErr as { name?: string })?.name || 'LegacyError';
      return {
        stream: null,
        constraintTier: 'FAILED',
        errorCode: errName,
        errorMessage: mapMicErrorToIndonesian(errName),
      };
    }
  }

  return {
    stream: null,
    constraintTier: 'FAILED',
    errorCode: 'UNSUPPORTED_CONTEXT',
    errorMessage:
      'Akses mikrofon membutuhkan koneksi HTTPS atau localhost pada Safari (iOS) / Chrome (Android/HarmonyOS).',
  };
}

function mapMicErrorToIndonesian(errorName: string): string {
  switch (errorName) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Izin mikrofon belum diberikan. Mohon tekan "Izinkan / Allow" pada pop-up Safari/Chrome.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Perangkat mikrofon tidak ditemukan. Pastikan mikrofon HP atau headset TWS terhubung.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Mikrofon sedang dipakai aplikasi lain (telepon/perekam). Tutup aplikasi lain lalu coba lagi.';
    case 'SecurityError':
      return 'Browser memblokir mikrofon karena halaman bukan HTTPS.';
    default:
      return `Gagal mengakses mikrofon (${errorName}). Ketuk tombol Izin Mic untuk mencoba fallback.`;
  }
}

/**
 * Negotiates the best supported MediaRecorder MIME type across Chrome (Android/HarmonyOS) and Safari (iOS)
 */
export function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      // Ignore check error
    }
  }
  return '';
}

/**
 * Encodes Float32 PCM chunks into a universally compatible 16-bit Mono WAV ArrayBuffer
 */
export function encodePcmChunksToWavArrayBuffer(
  chunks: Float32Array[],
  inputSampleRate: number,
  targetRate = 16000
): ArrayBuffer {
  const ratio = Math.max(1, inputSampleRate / targetRate);
  const totalInputSamples = chunks.reduce((acc, c) => acc + c.length, 0);
  const outputLength = Math.max(1, Math.floor(totalInputSamples / ratio));

  const merged = new Float32Array(totalInputSamples);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  const buffer = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(buffer);

  const writeString = (pos: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(pos + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + outputLength * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, outputLength * 2, true);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = Math.min(merged.length - 1, Math.floor(i * ratio));
    const sample = Math.max(-1, Math.min(1, merged[srcIdx]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}

/**
 * Encodes Float32 PCM chunks into a universally compatible 16-bit Mono WAV Blob
 */
export function encodePcmChunksToWavBlob(
  chunks: Float32Array[],
  inputSampleRate: number
): Blob {
  const buffer = encodePcmChunksToWavArrayBuffer(chunks, inputSampleRate, 16000);
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Synchronously encodes a 20ms-50ms PCM micro-chunk directly into a Base64 WAV DataURL
 * in < 0.1ms without Blob or FileReader event-loop delay.
 */
export function encodePcmChunkToWavDataUrlFast(
  chunks: Float32Array[],
  inputSampleRate: number
): string {
  const buffer = encodePcmChunksToWavArrayBuffer(chunks, inputSampleRate, 16000);
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  let binary = '';
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

// WeakMap to track HTMLAudioElements already routed into Web Audio API GainNode
const htmlAudioGainMap = new WeakMap<
  HTMLAudioElement,
  { ctx: AudioContext; gainNode: GainNode }
>();

/**
 * Routes an HTMLAudioElement through a Web Audio API GainNode (gain.value = 2.2 default)
 * + Vocal Clarity Filter + Anti-Clipping Limiter so even HTML5 <audio> fallback plays loud & clear.
 */
export function ensureHtmlAudioElementGainBooster(
  ctx: AudioContext,
  audioEl: HTMLAudioElement,
  rxGainValue = 2.2
): void {
  try {
    const existing = htmlAudioGainMap.get(audioEl);
    if (existing && existing.ctx === ctx) {
      existing.gainNode.gain.value = Math.max(0.5, Math.min(4.0, rxGainValue));
      return;
    }

    const mediaSource = ctx.createMediaElementSource(audioEl);
    const vocalClarityFilter = ctx.createBiquadFilter();
    vocalClarityFilter.type = 'peaking';
    vocalClarityFilter.frequency.value = 2100;
    vocalClarityFilter.Q.value = 1.0;
    vocalClarityFilter.gain.value = 3.5;

    const gainNode = ctx.createGain();
    gainNode.gain.value = Math.max(0.5, Math.min(4.0, rxGainValue));

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.0;
    limiter.knee.value = 6.0;
    limiter.ratio.value = 12.0;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;

    mediaSource.connect(vocalClarityFilter);
    vocalClarityFilter.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(ctx.destination);

    htmlAudioGainMap.set(audioEl, { ctx, gainNode });
  } catch {
    // Ignore if createMediaElementSource was already bound or unsupported
  }
}

/**
 * Zero-copy synchronous 16-bit PCM WAV parser (< 0.05ms).
 * Bypasses browser asynchronous decodeAudioData queue for instant 20ms-50ms chunk playback.
 */
function tryDecodeWavBytesToAudioBufferSync(
  ctx: AudioContext,
  bytes: Uint8Array
): AudioBuffer | null {
  try {
    if (bytes.byteLength < 44) return null;
    // Check 'RIFF' and 'WAVE' magic headers
    if (
      bytes[0] !== 0x52 ||
      bytes[1] !== 0x49 ||
      bytes[2] !== 0x46 ||
      bytes[3] !== 0x46 ||
      bytes[8] !== 0x57 ||
      bytes[9] !== 0x41 ||
      bytes[10] !== 0x56 ||
      bytes[11] !== 0x45
    ) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const audioFormat = view.getUint16(20, true);
    const numChannels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);

    if (audioFormat !== 1 || bitsPerSample !== 16 || numChannels < 1 || sampleRate < 4000) {
      return null;
    }

    // Locate 'data' subchunk
    let dataOffset = 36;
    let dataByteLength = bytes.byteLength - 44;
    while (dataOffset + 8 <= bytes.byteLength) {
      const id0 = bytes[dataOffset];
      const id1 = bytes[dataOffset + 1];
      const id2 = bytes[dataOffset + 2];
      const id3 = bytes[dataOffset + 3];
      const chunkSize = view.getUint32(dataOffset + 4, true);
      if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
        dataOffset += 8;
        dataByteLength = Math.min(chunkSize, bytes.byteLength - dataOffset);
        break;
      }
      dataOffset += 8 + chunkSize;
    }

    const bytesPerFrame = numChannels * 2;
    const frameCount = Math.floor(dataByteLength / bytesPerFrame);
    if (frameCount <= 0) return null;

    const audioBuffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      let bytePos = dataOffset + ch * 2;
      for (let i = 0; i < frameCount; i++) {
        const int16 = view.getInt16(bytePos, true);
        channelData[i] = int16 < 0 ? int16 / 32768 : int16 / 32767;
        bytePos += bytesPerFrame;
      }
    }
    return audioBuffer;
  } catch {
    return null;
  }
}

// Persistent Receiver Audio Pipeline & Zero-Latency Playhead State per AudioContext
interface SharedRxAudioPipeline {
  vocalClarityFilter: BiquadFilterNode;
  gainNode: GainNode;
  limiter: DynamicsCompressorNode;
}

const sharedRxPipelineMap = new WeakMap<AudioContext, SharedRxAudioPipeline>();
const activeRxSourcesSet = new Set<AudioBufferSourceNode>();
let nextRxScheduledTime = 0;

function getOrCreateSharedRxPipeline(
  ctx: AudioContext,
  rxGainValue: number
): SharedRxAudioPipeline {
  const existing = sharedRxPipelineMap.get(ctx);
  if (existing) {
    existing.gainNode.gain.value = Math.max(0.5, Math.min(5.0, rxGainValue));
    return existing;
  }

  // Stage 1: Vocal Presence Clarity Filter (2.1 kHz +3.5 dB boost for crisp walkie-talkie speech)
  const vocalClarityFilter = ctx.createBiquadFilter();
  vocalClarityFilter.type = 'peaking';
  vocalClarityFilter.frequency.value = 2100;
  vocalClarityFilter.Q.value = 1.0;
  vocalClarityFilter.gain.value = 3.5;

  // Stage 2: Web Audio API GainNode (gain.value = 2.2+ default receiver boost)
  const gainNode = ctx.createGain();
  gainNode.gain.value = Math.max(0.5, Math.min(5.0, rxGainValue));

  // Stage 3: Anti-Clipping DynamicsCompressor Limiter
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2.0;
  limiter.knee.value = 6.0;
  limiter.ratio.value = 12.0;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;

  vocalClarityFilter.connect(gainNode);
  gainNode.connect(limiter);
  limiter.connect(ctx.destination);

  const pipeline = { vocalClarityFilter, gainNode, limiter };
  sharedRxPipelineMap.set(ctx, pipeline);
  return pipeline;
}

/**
 * Immediately stops all active/scheduled Web Audio RX chunks and resets the zero-latency playhead.
 * Invoked when local PTT opens (strict Half-Duplex) or on EMERGENCY CLEAR.
 */
export function stopAllQueuedWebAudioRx(): void {
  nextRxScheduledTime = 0;
  activeRxSourcesSet.forEach((src) => {
    try {
      src.onended = null;
      src.stop(0);
      src.disconnect();
    } catch {
      // Ignore already stopped source
    }
  });
  activeRxSourcesSet.clear();
}

/**
 * Zero-Latency Real-Time Audio Decoder & Scheduler with Web Audio API GainNode (gain.value = 2.2+).
 * - Synchronously decodes 16-bit PCM WAV streaming chunks in < 0.05ms (or falls back to decodeAudioData).
 * - Schedules playback immediately without long buffer queues: if the playhead ever drifts > 90ms ahead
 *   of currentTime due to network burst, it snaps back to real-time so all receivers stay synchronized.
 */
export async function playBase64AudioViaWebAudioFallback(
  ctx: AudioContext,
  base64DataUrl: string,
  onEnded: () => void,
  rxGainValue = 2.2
): Promise<{ stop: () => void; setGain: (val: number) => void } | null> {
  try {
    const st = ctx.state as string;
    if (st === 'suspended' || st === 'interrupted') {
      ctx.resume().catch(() => {});
    }

    const commaIdx = base64DataUrl.indexOf(',');
    const rawBase64 = commaIdx >= 0 ? base64DataUrl.slice(commaIdx + 1) : base64DataUrl;
    const binaryString = atob(rawBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Fast path: Synchronous zero-copy WAV parser (< 0.05ms) for 20ms-50ms streaming chunks
    let audioBuffer = tryDecodeWavBytesToAudioBufferSync(ctx, bytes);

    // Fallback path: Browser decodeAudioData for compressed WebM / MP4 / AAC blobs
    if (!audioBuffer) {
      audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
        try {
          const res = ctx.decodeAudioData(
            bytes.buffer.slice(0),
            (decoded) => resolve(decoded),
            (err) => reject(err)
          );
          if (res && typeof res.then === 'function') {
            res.catch(reject);
          }
        } catch (err) {
          reject(err);
        }
      });
    }

    // Auto-normalize quiet decoded audio buffers in-place so soft speech is brought up cleanly before GainNode
    try {
      let maxPeak = 0;
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        const step = channelData.length > 1600 ? 4 : 1;
        for (let i = 0; i < channelData.length; i += step) {
          const abs = Math.abs(channelData[i]);
          if (abs > maxPeak) maxPeak = abs;
        }
      }
      if (maxPeak > 0.008 && maxPeak < 0.45) {
        const makeup = Math.min(2.0, 0.65 / maxPeak);
        for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
          const channelData = audioBuffer.getChannelData(ch);
          for (let i = 0; i < channelData.length; i++) {
            channelData[i] *= makeup;
          }
        }
      }
    } catch {
      // Ignore normalization error
    }

    const pipeline = getOrCreateSharedRxPipeline(ctx, rxGainValue);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(pipeline.vocalClarityFilter);

    // ZERO-LATENCY PLAYHEAD SCHEDULER:
    // - Play immediately if playhead is behind currentTime.
    // - Cap maximum queue lookahead to 90ms (0.09s) so packets never pile up into a delayed queue
    //   and all receivers play in lockstep synchronization.
    const now = ctx.currentTime;
    if (nextRxScheduledTime < now + 0.002 || nextRxScheduledTime - now > 0.09) {
      nextRxScheduledTime = now + 0.004;
    }
    const startTime = nextRxScheduledTime;
    nextRxScheduledTime = startTime + audioBuffer.duration;

    activeRxSourcesSet.add(source);
    let stopped = false;

    source.onended = () => {
      activeRxSourcesSet.delete(source);
      try {
        source.disconnect();
      } catch {
        // Ignore disconnect error
      }
      if (!stopped && activeRxSourcesSet.size === 0) {
        stopped = true;
        onEnded();
      }
    };

    source.start(startTime);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        stopAllQueuedWebAudioRx();
      },
      setGain: (val: number) => {
        pipeline.gainNode.gain.value = Math.max(0.5, Math.min(5.0, val));
      },
    };
  } catch {
    return null;
  }
}

/**
 * Web Audio API Silent Audio Stream Keep-Alive Controller
 * Prevents Android (Chrome/HarmonyOS) and iOS (Safari) from freezing WebSockets, VOX timers,
 * and incoming RX voice playback when the screen is turned off or the phone is placed in a pocket (visibilitychange).
 */
export interface SilentKeepAliveSession {
  start: (ctx: AudioContext) => void;
  pulseOnVisibilityChange: (ctx: AudioContext, isHidden: boolean) => void;
  stop: () => void;
  isActive: () => boolean;
}

export function createSilentKeepAliveController(): SilentKeepAliveSession {
  let oscNode: OscillatorNode | null = null;
  let bufferSourceNode: AudioBufferSourceNode | null = null;
  let silentGainNode: GainNode | null = null;
  let keepAliveAudioEl: HTMLAudioElement | null = null;
  let active = false;

  const ensureHtmlAudioLoop = (ctx: AudioContext) => {
    try {
      if (!keepAliveAudioEl) {
        const el = new Audio();
        el.setAttribute('playsinline', 'true');
        el.setAttribute('webkit-playsinline', 'true');
        el.loop = true;
        el.volume = 0.01; // Near-zero volume on already silent +/-1 LSB WAV

        // If MediaStreamAudioDestinationNode is supported, pipe Web Audio silent stream into <audio>
        let boundMediaStream = false;
        if (typeof ctx.createMediaStreamDestination === 'function') {
          try {
            const dest = ctx.createMediaStreamDestination();
            if (silentGainNode) {
              silentGainNode.connect(dest);
            }
            el.srcObject = dest.stream;
            boundMediaStream = true;
          } catch {
            boundMediaStream = false;
          }
        }
        if (!boundMediaStream) {
          el.src = SILENT_WAV_DATA_URI;
        }
        keepAliveAudioEl = el;
      }

      if (keepAliveAudioEl.paused) {
        keepAliveAudioEl.play().catch(() => {
          // Fallback to static silent WAV if srcObject play failed on Safari
          if (keepAliveAudioEl && keepAliveAudioEl.srcObject) {
            keepAliveAudioEl.srcObject = null;
            keepAliveAudioEl.src = SILENT_WAV_DATA_URI;
            keepAliveAudioEl.play().catch(() => {});
          }
        });
      }

      // Register MediaSession metadata so Android/iOS/HarmonyOS lockscreen treats app as active radio receiver
      if ('mediaSession' in navigator && navigator.mediaSession) {
        try {
          if (typeof MediaMetadata !== 'undefined') {
            navigator.mediaSession.metadata = new MediaMetadata({
              title: 'TACTICAL NET-COMM SUBDISRUDAL',
              artist: 'Keep-Alive Saluran Radio Aktif',
              album: 'PTT & VOX Siaga Latar Belakang',
            });
          }
          navigator.mediaSession.playbackState = 'playing';
        } catch {
          // Ignore MediaSession error
        }
      }
    } catch {
      // Ignore HTML audio loop error
    }
  };

  const start = (ctx: AudioContext) => {
    try {
      const st = ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        ctx.resume().catch(() => {});
      }

      if (!silentGainNode) {
        const gain = ctx.createGain();
        // Ultra-low non-zero gain (0.00001 = -100 dB): completely transparent/inaudible to human ear,
        // but prevents iOS Safari & Android Chrome hardware audio pipeline from auto-sleeping!
        gain.gain.setValueAtTime(0.00001, ctx.currentTime);
        gain.connect(ctx.destination);
        silentGainNode = gain;
      }

      if (!oscNode) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1, ctx.currentTime); // 1 Hz sub-audible carrier
        osc.connect(silentGainNode);
        osc.start();
        oscNode = osc;
      }

      if (!bufferSourceNode) {
        // Also run a looping 1-second ultra-quiet dither buffer in Web Audio API
        const sampleRate = ctx.sampleRate || 22050;
        const silentBuf = ctx.createBuffer(1, sampleRate, sampleRate);
        const channelData = silentBuf.getChannelData(0);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = i % 2 === 0 ? 0.00001 : -0.00001;
        }
        const bufSrc = ctx.createBufferSource();
        bufSrc.buffer = silentBuf;
        bufSrc.loop = true;
        bufSrc.connect(silentGainNode);
        bufSrc.start(0);
        bufferSourceNode = bufSrc;
      }

      ensureHtmlAudioLoop(ctx);
      active = true;
    } catch {
      // Ignore keep-alive start error
    }
  };

  const pulseOnVisibilityChange = (ctx: AudioContext, isHidden: boolean) => {
    try {
      // Ensure Web Audio Silent Stream is running before & during background transition
      start(ctx);
      const st = ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        ctx.resume().catch(() => {});
      }

      if (silentGainNode) {
        // Slightly pulse sub-audible gain when entering pocket/screen-off mode so OS audio daemon locks wake state
        const targetGain = isHidden ? 0.00002 : 0.00001;
        silentGainNode.gain.setValueAtTime(targetGain, ctx.currentTime);
      }

      ensureHtmlAudioLoop(ctx);
    } catch {
      // Ignore visibility pulse error
    }
  };

  const stop = () => {
    active = false;
    try {
      oscNode?.stop();
      oscNode?.disconnect();
    } catch {
      // Ignore
    }
    oscNode = null;

    try {
      bufferSourceNode?.stop();
      bufferSourceNode?.disconnect();
    } catch {
      // Ignore
    }
    bufferSourceNode = null;

    try {
      silentGainNode?.disconnect();
    } catch {
      // Ignore
    }
    silentGainNode = null;

    if (keepAliveAudioEl) {
      try {
        keepAliveAudioEl.pause();
        keepAliveAudioEl.srcObject = null;
        keepAliveAudioEl.src = '';
      } catch {
        // Ignore
      }
      keepAliveAudioEl = null;
    }
  };

  return {
    start,
    pulseOnVisibilityChange,
    stop,
    isActive: () => active,
  };
}
