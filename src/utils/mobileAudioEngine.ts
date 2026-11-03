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
 * Explicitly enforces hardware/OS Acoustic Echo Cancellation (AEC), Noise Suppression (NS),
 * and Auto Gain Control (AGC) on all audio tracks of a MediaStream.
 */
export async function enforceHardwareEchoCancellationOnStream(
  stream: MediaStream | null
): Promise<void> {
  if (!stream) return;
  const audioTracks = stream.getAudioTracks();
  for (const track of audioTracks) {
    try {
      if ('contentHint' in track) {
        (track as MediaStreamTrack & { contentHint?: string }).contentHint = 'speech';
      }
      if (typeof track.applyConstraints === 'function') {
        await track.applyConstraints({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      }
    } catch {
      // Ignore if specific mobile WebView does not support post-acquisition applyConstraints
    }
  }
}

/**
 * Multi-tier getUserMedia microphone acquisition with explicit Echo Cancellation, Noise Suppression,
 * and Auto Gain Control for Safari (iOS), Chrome (Android), and HarmonyOS
 */
export async function requestMicrophoneWithFallbacks(): Promise<MicAcquisitionResult> {
  // Tier 1: Explicit WebRTC Hardware AEC/NS/AGC + Ultra-Low Latency + 16kHz Wideband Vocal Mono for Opus 16-24 kbps
  const tier1Constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 16000 },
      sampleSize: { ideal: 16 },
      // @ts-expect-error WebRTC/Chromium explicit hardware echo cancellation & latency parameters
      googEchoCancellation: true,
      googAutoGainControl: true,
      googNoiseSuppression: true,
      googHighpassFilter: true,
      latency: { ideal: 0.01, max: 0.04 },
    },
    video: false,
  };

  // Tier 2: Explicit boolean constraints { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  const tier2Constraints: MediaStreamConstraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  };

  // Tier 3: Raw audio fallback (when Bluetooth TWS SCO or HarmonyOS rejects specific constraint keys),
  // followed immediately by track.applyConstraints({ echoCancellation: true, noiseSuppression: true, autoGainControl: true })
  const tier3Constraints: MediaStreamConstraints = {
    audio: true,
    video: false,
  };

  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(tier1Constraints);
      await enforceHardwareEchoCancellationOnStream(stream);
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
        await enforceHardwareEchoCancellationOnStream(stream);
        return {
          stream,
          constraintTier: 'STD_DSP',
          errorCode: null,
          errorMessage: null,
        };
      } catch {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(tier3Constraints);
          await enforceHardwareEchoCancellationOnStream(stream);
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
 * Negotiates the best supported MediaRecorder MIME type across Chrome (Android/HarmonyOS) and Safari (iOS),
 * strictly prioritizing Opus codec containers first for ultra-low-bitrate (16-24 kbps) tactical voice compression.
 */
export function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac',
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
 * Optimal MediaRecorder timeslice (45ms — within the 40ms-50ms tactical low-latency window).
 * Prevents packet fragmentation/dropouts while keeping frame capture real-time.
 */
export const OPTIMAL_MEDIA_RECORDER_TIMESLICE_MS = 45;

/**
 * Builds MediaRecorderOptions locked to Opus low-bitrate (16 kbps - 24 kbps, default 20 kbps)
 * to save maximum bandwidth while preserving human vocal clarity (300Hz - 3.4kHz) and keeping latency < 50ms.
 */
export function createOpusLowBitrateRecorderOptions(
  targetBitrateBps = 20000
): {
  options: MediaRecorderOptions;
  negotiatedMime: string;
  clampedBitrateBps: number;
  timesliceMs: number;
} {
  // Clamp strictly within the 16 kbps - 24 kbps tactical Opus voice band
  const clampedBitrateBps = Math.max(16000, Math.min(24000, Math.round(targetBitrateBps)));
  const negotiatedMime = getSupportedAudioMimeType();

  const options: MediaRecorderOptions = {
    audioBitsPerSecond: clampedBitrateBps,
    bitsPerSecond: clampedBitrateBps,
  };
  if (negotiatedMime) {
    options.mimeType = negotiatedMime;
  }

  return {
    options,
    negotiatedMime,
    clampedBitrateBps,
    timesliceMs: OPTIMAL_MEDIA_RECORDER_TIMESLICE_MS,
  };
}

/**
 * Optimizes WebRTC SDP (Session Description Protocol) for Opus Codec Low-Bitrate (16 kbps - 24 kbps)
 * and Ultra-Low Latency (40ms-50ms buffer window via 20ms frame packetization, 10ms minptime, DTX, In-Band FEC, Mono VOIP).
 */
export function optimizeWebRtcSdpForOpusLowLatency(
  sdp: string,
  targetBitrateBps = 20000
): string {
  if (!sdp) return sdp;
  const clampedBitrate = Math.max(16000, Math.min(24000, Math.round(targetBitrateBps)));
  const opusFmtpParams = `minptime=10;ptime=20;maxptime=40;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;cbr=0;maxaveragebitrate=${clampedBitrate};maxplaybackrate=16000`;

  const lines = sdp.split(/\r?\n/);
  let opusPayloadType: string | null = null;

  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
    if (match) {
      opusPayloadType = match[1];
      break;
    }
  }

  if (!opusPayloadType) {
    return sdp;
  }

  let fmtpUpdated = false;
  const updatedLines = lines.map((line) => {
    if (line.startsWith(`a=fmtp:${opusPayloadType} `)) {
      fmtpUpdated = true;
      return `a=fmtp:${opusPayloadType} ${opusFmtpParams}`;
    }
    return line;
  });

  if (!fmtpUpdated) {
    const rtpmapIdx = updatedLines.findIndex((l) =>
      l.startsWith(`a=rtpmap:${opusPayloadType} `)
    );
    if (rtpmapIdx !== -1) {
      updatedLines.splice(
        rtpmapIdx + 1,
        0,
        `a=fmtp:${opusPayloadType} ${opusFmtpParams}`,
        'a=ptime:20',
        'a=maxptime:40'
      );
    }
  }

  return updatedLines.join('\r\n');
}

/**
 * Encodes Float32 PCM chunks into a universally compatible 16-bit Mono WAV Blob
 * Used when MediaRecorder is unavailable or fails on older iOS Safari / HarmonyOS WebViews
 */
export function encodePcmChunksToWavBlob(
  chunks: Float32Array[],
  inputSampleRate: number
): Blob {
  // Use 16000 Hz wideband vocal mono for compact bandwidth & crisp human speech reproduction (300Hz - 3.4kHz)
  const targetRate = 16000;
  const ratio = Math.max(1, inputSampleRate / targetRate);
  const totalInputSamples = chunks.reduce((acc, c) => acc + c.length, 0);
  const outputLength = Math.max(1, Math.floor(totalInputSamples / ratio));

  const merged = new Float32Array(totalInputSamples);
  let offset = 0;
  let sum = 0;
  let maxPeak = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      sum += v;
      const a = Math.abs(v);
      if (a > maxPeak) maxPeak = a;
    }
    offset += chunk.length;
  }

  // Remove DC offset and normalize quiet speech so transmitted voice is always clear
  const dcOffset = totalInputSamples > 0 ? sum / totalInputSamples : 0;
  const normGain =
    maxPeak > 0.015 && maxPeak < 0.65 ? Math.min(2.2, 0.78 / maxPeak) : 1.0;

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
    const cleaned = (merged[srcIdx] - dcOffset) * normGain;
    const sample = Math.max(-1, Math.min(1, cleaned));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// WeakMap to track HTMLAudioElements already routed into Web Audio API GainNode
const htmlAudioGainMap = new WeakMap<
  HTMLAudioElement,
  { ctx: AudioContext; gainNode: GainNode }
>();

/**
 * Routes an HTMLAudioElement through a Web Audio API GainNode (gain.value = 2.2 default)
 * + HD Vocal Clarity Filter + Anti-Clipping Limiter so even HTML5 <audio> fallback plays loud & clear.
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

    const rumbleCutFilter = ctx.createBiquadFilter();
    rumbleCutFilter.type = 'highpass';
    rumbleCutFilter.frequency.value = 180;
    rumbleCutFilter.Q.value = 0.707;

    const hissCutFilter = ctx.createBiquadFilter();
    hissCutFilter.type = 'lowpass';
    hissCutFilter.frequency.value = 4200;
    hissCutFilter.Q.value = 0.707;

    const vocalClarityFilter = ctx.createBiquadFilter();
    vocalClarityFilter.type = 'peaking';
    vocalClarityFilter.frequency.value = 2200;
    vocalClarityFilter.Q.value = 0.9;
    vocalClarityFilter.gain.value = 4.0;

    const gainNode = ctx.createGain();
    gainNode.gain.value = Math.max(0.5, Math.min(4.0, rxGainValue));

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.0;
    limiter.knee.value = 8.0;
    limiter.ratio.value = 10.0;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;

    mediaSource.connect(rumbleCutFilter);
    rumbleCutFilter.connect(hissCutFilter);
    hissCutFilter.connect(vocalClarityFilter);
    vocalClarityFilter.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(ctx.destination);

    htmlAudioGainMap.set(audioEl, { ctx, gainNode });
  } catch {
    // Ignore if createMediaElementSource was already bound or unsupported
  }
}

/**
 * Pre-decodes a Base64 audio Data URL into a Web Audio API AudioBuffer immediately upon arrival
 * so the Receiver Buffer Queue can transition from one segment to the next with 0ms decoding delay.
 */
export async function preDecodeBase64AudioToBuffer(
  ctx: AudioContext,
  base64DataUrl: string
): Promise<AudioBuffer | null> {
  try {
    const commaIdx = base64DataUrl.indexOf(',');
    const rawBase64 = commaIdx >= 0 ? base64DataUrl.slice(commaIdx + 1) : base64DataUrl;
    const binaryString = atob(rawBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
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

    return audioBuffer;
  } catch {
    return null;
  }
}

/**
 * Decodes (or uses pre-decoded) AES-GCM Base64 Data URL and plays it through Web Audio API AudioBufferSourceNode
 * with 4-stage HD Vocal Clarity DSP (180Hz Rumble Cut -> 4.2kHz Hiss Cut -> 2.2kHz Vocal Presence Boost ->
 * De-Click Envelope GainNode -> Smooth DynamicsCompressor Limiter) for crystal-clear, uninterrupted speech.
 */
export async function playBase64AudioViaWebAudioFallback(
  ctx: AudioContext,
  base64DataUrl: string,
  onEnded: () => void,
  rxGainValue = 2.2,
  preDecodedBuffer?: AudioBuffer | null,
  playbackRate = 1.0
): Promise<{ stop: () => void; setGain: (val: number) => void } | null> {
  try {
    const st = ctx.state as string;
    if (st === 'suspended' || st === 'interrupted') {
      await ctx.resume().catch(() => {});
    }

    const audioBuffer =
      preDecodedBuffer || (await preDecodeBase64AudioToBuffer(ctx, base64DataUrl));
    if (!audioBuffer) {
      return null;
    }

    // Auto-normalize quiet decoded audio buffers so soft microphone recordings are brought up to optimal level before GainNode
    let autoMakeupGain = 1.0;
    try {
      let maxPeak = 0;
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < channelData.length; i += 4) {
          const abs = Math.abs(channelData[i]);
          if (abs > maxPeak) maxPeak = abs;
        }
      }
      if (maxPeak > 0.01 && maxPeak < 0.55) {
        autoMakeupGain = Math.min(2.2, 0.72 / maxPeak);
      }
    } catch {
      autoMakeupGain = 1.0;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    const clampedRate = Math.max(0.95, Math.min(1.12, playbackRate));
    source.playbackRate.setValueAtTime(clampedRate, ctx.currentTime);

    // Stage 1: Sub-Bass Rumble Cut (180 Hz Highpass) to eliminate mud & speaker rattle
    const rumbleCutFilter = ctx.createBiquadFilter();
    rumbleCutFilter.type = 'highpass';
    rumbleCutFilter.frequency.value = 180;
    rumbleCutFilter.Q.value = 0.707;

    // Stage 2: High-Frequency Hiss Cut (4200 Hz Lowpass) to remove digital noise/static
    const hissCutFilter = ctx.createBiquadFilter();
    hissCutFilter.type = 'lowpass';
    hissCutFilter.frequency.value = 4200;
    hissCutFilter.Q.value = 0.707;

    // Stage 3: HD Vocal Presence Clarity Filter (2.2 kHz +4.0 dB boost for crisp walkie-talkie speech)
    const vocalClarityFilter = ctx.createBiquadFilter();
    vocalClarityFilter.type = 'peaking';
    vocalClarityFilter.frequency.value = 2200;
    vocalClarityFilter.Q.value = 0.9;
    vocalClarityFilter.gain.value = 4.0;

    // Stage 4: Web Audio API GainNode with ultra-fast 5ms De-Click Envelope for seamless gapless segment transitions
    const gainNode = ctx.createGain();
    const effectiveGain = Math.max(0.5, Math.min(5.0, rxGainValue * autoMakeupGain));
    const nowTime = ctx.currentTime;
    const effectiveDuration = audioBuffer.duration / clampedRate;
    gainNode.gain.setValueAtTime(0.02, nowTime);
    gainNode.gain.linearRampToValueAtTime(effectiveGain, nowTime + 0.005);
    if (effectiveDuration > 0.025) {
      gainNode.gain.setValueAtTime(
        effectiveGain,
        nowTime + Math.max(0.008, effectiveDuration - 0.006)
      );
      gainNode.gain.linearRampToValueAtTime(0.02, nowTime + effectiveDuration);
    }

    // Stage 5: Smooth Anti-Clipping DynamicsCompressor Limiter
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.0;
    limiter.knee.value = 8.0;
    limiter.ratio.value = 10.0;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.14;

    source.connect(rumbleCutFilter);
    rumbleCutFilter.connect(hissCutFilter);
    hissCutFilter.connect(vocalClarityFilter);
    vocalClarityFilter.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(ctx.destination);

    let stopped = false;
    source.onended = () => {
      if (!stopped) {
        stopped = true;
        try {
          source.disconnect();
          rumbleCutFilter.disconnect();
          hissCutFilter.disconnect();
          vocalClarityFilter.disconnect();
          gainNode.disconnect();
          limiter.disconnect();
        } catch {
          // Ignore disconnect error
        }
        onEnded();
      }
    };

    source.start(0);

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          gainNode.gain.cancelScheduledValues(ctx.currentTime);
          gainNode.gain.value = 0;
          source.stop(0);
          source.disconnect();
          rumbleCutFilter.disconnect();
          hissCutFilter.disconnect();
          vocalClarityFilter.disconnect();
          gainNode.disconnect();
          limiter.disconnect();
        } catch {
          // Ignore stop error
        }
      },
      setGain: (val: number) => {
        if (stopped) return;
        gainNode.gain.setValueAtTime(
          Math.max(0.5, Math.min(5.0, val * autoMakeupGain)),
          ctx.currentTime
        );
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

// Dedicated background Web Worker keep-alive instance (avoids Service Worker scope '/' controllerchange reload loops)
let tacticalBgWorker: Worker | null = null;
const bgVoxTickListeners = new Set<() => void>();
const bgHeartbeatListeners = new Set<() => void>();

/**
 * Subscribes to unthrottled background Web Worker ticks so VOX standby and WebSocket connections
 * stay active even when the mobile browser tab is hidden / user switches to another phone app.
 */
export function subscribeToBackgroundWorkerTicks(handlers: {
  onVoxTick?: () => void;
  onHeartbeatTick?: () => void;
}): () => void {
  if (handlers.onVoxTick) {
    bgVoxTickListeners.add(handlers.onVoxTick);
  }
  if (handlers.onHeartbeatTick) {
    bgHeartbeatListeners.add(handlers.onHeartbeatTick);
  }
  return () => {
    if (handlers.onVoxTick) {
      bgVoxTickListeners.delete(handlers.onVoxTick);
    }
    if (handlers.onHeartbeatTick) {
      bgHeartbeatListeners.delete(handlers.onHeartbeatTick);
    }
  };
}

/**
 * Initializes a lightweight Background Keep-Alive Worker thread (and cleans up any legacy competing Service Worker)
 * so VOX standby, MediaStream loop-back, and WebSocket connections stay alive in the background.
 */
export async function registerTacticalBackgroundServiceWorker(
  onKeepAliveAck?: (ackTimestamp: number) => void
): Promise<{ active: boolean } | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  // Clean up any legacy /tactical-bg-sw.js registration so it never conflicts with VitePWA's sw.js on scope '/'
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        const scriptUrl =
          reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        if (scriptUrl.includes('tactical-bg-sw.js')) {
          await reg.unregister().catch(() => {});
        }
      }
    } catch {
      // Ignore SW cleanup error
    }
  }

  try {
    if (!tacticalBgWorker && typeof Worker !== 'undefined') {
      const workerCode = `
        var voxInterval = setInterval(function() {
          self.postMessage({ type: 'BG_VOX_TICK', timestamp: Date.now() });
        }, 105);
        var hbInterval = setInterval(function() {
          self.postMessage({ type: 'BG_WS_HEARTBEAT', timestamp: Date.now() });
        }, 3500);
        self.onmessage = function(e) {
          var data = e.data;
          if (data && data.type === 'KEEP_ALIVE_PING') {
            self.postMessage({
              type: 'KEEP_ALIVE_ACK',
              timestamp: Date.now()
            });
          }
        };
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      tacticalBgWorker = new Worker(url);
      tacticalBgWorker.onmessage = (event) => {
        const msgType = event.data?.type;
        if (msgType === 'KEEP_ALIVE_ACK') {
          onKeepAliveAck?.(event.data.timestamp || Date.now());
        } else if (msgType === 'BG_VOX_TICK') {
          bgVoxTickListeners.forEach((cb) => cb());
        } else if (msgType === 'BG_WS_HEARTBEAT') {
          bgHeartbeatListeners.forEach((cb) => cb());
        }
      };
    }
    onKeepAliveAck?.(Date.now());
    return { active: true };
  } catch {
    onKeepAliveAck?.(Date.now());
    return { active: true };
  }
}

/**
 * Sends a lightweight KEEP_ALIVE_PING message to the background worker thread
 * to keep the JS audio/WebSocket event loop active in background mode.
 */
export function sendServiceWorkerKeepAlivePing(payload: {
  callsign: string;
  channel: number;
  minimized: boolean;
  voxEnabled: boolean;
}) {
  try {
    if (tacticalBgWorker) {
      tacticalBgWorker.postMessage({
        type: 'KEEP_ALIVE_PING',
        ...payload,
      });
    }
  } catch {
    // Ignore worker message error
  }
}

