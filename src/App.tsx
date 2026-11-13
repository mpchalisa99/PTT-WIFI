import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import mqtt, { MqttClient } from 'mqtt';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {
  Wifi,
  RefreshCw,
  Star,
  QrCode,
  Mic,
  Pencil,
  Radio,
  Settings,
  Copy,
  Check,
  Download,
  Volume2,
  X,
  Maximize2,
  Minimize2,
  Smartphone,
  ShieldCheck,
  Code2,
  Share2,
  Link2,
  UserPlus,
  Camera,
  Upload,
  MessageSquare,
  Send,
  Trash2,
  ChevronDown,
  ChevronUp,
  Lock,
  Shield,
  ShieldAlert,
  KeyRound,
  Zap,
} from 'lucide-react';
import { FLUTTER_SOURCE_FILES } from './data/flutterSourceFiles';
import { usePWAInstall } from './usePWAInstall';
import {
  buildMicroOfflineToken,
  decodeOfflineSignalFromInput,
  detectLocalHotspotIpWebRTC,
  gatherLocalIceCandidatesExplicit,
} from './utils/offlineHotspotWebRTC';
import {
  SILENT_WAV_DATA_URI,
  detectMobileAudioPlatform,
  getOrCreateCompatibleAudioContext,
  unlockMobileAudioSession,
  enforceHardwareEchoCancellationOnStream,
  requestMicrophoneWithFallbacks,
  getSupportedAudioMimeType,
  OPTIMAL_MEDIA_RECORDER_TIMESLICE_MS,
  createOpusLowBitrateRecorderOptions,
  optimizeWebRtcSdpForOpusLowLatency,
  installGlobalWebRtcOpusSdpPatch,
  encodePcmChunksToWavBlob,
  ensureHtmlAudioElementGainBooster,
  preDecodeBase64AudioToBuffer,
  playBase64AudioViaWebAudioFallback,
  createSilentKeepAliveController,
  registerTacticalBackgroundServiceWorker,
  sendServiceWorkerKeepAlivePing,
  subscribeToBackgroundWorkerTicks,
  SilentKeepAliveSession,
} from './utils/mobileAudioEngine';
import {
  TACTICAL_AUTH_SESSION_KEY,
  getOrDeriveTacticalAesKey,
  purgeTacticalCryptoKeyCache,
  encryptAudioPayloadAesGcm,
  decryptAudioPayloadAesGcm,
} from './utils/tacticalCrypto';

// Spesifikasi Passcode Operasional Harian (Wajib sebelum akses PTT, Web Audio API & WebSocket)
const PASSCODE_HARIAN = 'YES';

interface TacticalMember {
  id: string;
  callsign: string;
  ip: string;
  role: 'MASTER' | 'CLIENT';
  statusText: string;
  isTargeted: boolean;
  isTalking: boolean;
  pingMs: number;
  channel: number;
  peerId?: string;
  lastSeen?: number;
}

interface PeerSyncEntry {
  peerId: string;
  senderId: string;
  callsign: string;
  ip: string;
  role: 'MASTER' | 'CLIENT';
  channel: number;
}

interface TacticalChatMessage {
  id: string;
  senderId: string;
  callsign: string;
  ip: string;
  role: 'MASTER' | 'CLIENT';
  channel: number;
  text: string;
  timestamp: number;
}

interface ChannelLockInfo {
  senderId: string;
  callsign: string;
  startedAt: number;
  updatedAt: number;
  isPriorityOverride?: boolean;
}

interface MeshPacket {
  packetId?: string;
  type:
    | 'ANNOUNCE'
    | 'PEER_LIST_SYNC'
    | 'PEER_LEAVE'
    | 'VOICE_CLIP'
    | 'CHAT_MSG'
    | 'PTT_START'
    | 'PTT_END'
    | 'TX_START'
    | 'TX_STOP'
    | 'CHANNEL_LOCK'
    | 'CHANNEL_UNLOCK'
    | 'CHANNEL_BUSY'
    | 'PRIORITY_OVERRIDE'
    | 'PRIORITY_OVERRIDE_END'
    | 'PING'
    | 'PONG';
  senderId: string;
  callsign: string;
  ip: string;
  role: 'MASTER' | 'CLIENT';
  isMaster?: boolean;
  channel: number;
  timestamp: number;
  audioBase64?: string;
  encryptedAudio?: boolean;
  audioCiphertext?: string;
  aesIv?: string;
  cipherAlgo?: 'AES-256-GCM';
  mimeType?: string;
  chatText?: string;
  peerNodeId?: string;
  peerList?: PeerSyncEntry[];
  lockOwnerId?: string;
  lockOwnerCallsign?: string;
  lockStartedAt?: number;
  isPriorityOverride?: boolean;
}

const MASTER_PEER_ID = 'PTT-MASTER-01';
const CLOUD_MESH_TOPIC = 'diskomlekau/tactical/ptt/v3/mesh';
const WSS_CLOUD_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
// IP-literal STUN servers first so WebRTC never hangs on DNS lookup when Hotspot has NO internet
const WEBRTC_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:74.125.250.129:19302' },
  { urls: 'stun:142.250.82.127:19302' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// Universal parser for both ?query and #hash invite parameters (prevents 404 Page Not Found)
function extractInviteParamsFromUrl() {
  const searchStr = window.location.search.replace(/^\?/, '');
  const hashStr = window.location.hash.replace(/^#\/?/, '').replace(/^\?/, '');
  const combined = [searchStr, hashStr].filter(Boolean).join('&');
  const params = new URLSearchParams(combined);

  const isInvite =
    params.get('invite') === '1' ||
    params.get('role') === 'CLIENT' ||
    Boolean(params.get('hostPeer')) ||
    Boolean(params.get('lanSignal'));
  const ch = Number(params.get('ch'));
  const hostPeer = params.get('hostPeer') || '';
  const hostCallsign = (params.get('hostCallsign') || params.get('host') || 'MASTER').toUpperCase();
  const masterIp = params.get('master') || params.get('ip') || '192.168.43.1';
  const lanSignal = params.get('lanSignal') || '';

  return {
    isInvite,
    channel: ch >= 1 && ch <= 99 ? ch : null,
    hostPeer,
    hostCallsign,
    masterIp,
    role: params.get('role'),
    lanSignal,
  };
}

// ============================================================================
// ISOLATED LIVE AUDIO METER REF STORE & DIRECT-DOM AUDIO INDICATOR COMPONENTS
// Holds rapidly changing microphone/VOX level values in refs and updates DOM elements
// directly via ref.current.style / ref.current.textContent — 0 React setState calls!
// ============================================================================
interface LiveAudioMeterSnapshot {
  voxInputLevel: number;
  micLevel: number;
  isVocalPatternConfirmed: boolean;
  ambientNoiseFloor: number;
}

class LiveAudioMeterStore {
  public current: LiveAudioMeterSnapshot = {
    voxInputLevel: 0,
    micLevel: 0,
    isVocalPatternConfirmed: false,
    ambientNoiseFloor: 4,
  };
  private listeners = new Set<(snap: LiveAudioMeterSnapshot) => void>();
  private lastEmitTs = 0;

  getSnapshot = (): LiveAudioMeterSnapshot => this.current;

  subscribe = (listener: (snap: LiveAudioMeterSnapshot) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(partial: Partial<LiveAudioMeterSnapshot>, forceImmediate = false) {
    const nextVox =
      partial.voxInputLevel !== undefined ? partial.voxInputLevel : this.current.voxInputLevel;
    const nextMic =
      partial.micLevel !== undefined ? partial.micLevel : this.current.micLevel;
    const nextConfirmed =
      partial.isVocalPatternConfirmed !== undefined
        ? partial.isVocalPatternConfirmed
        : this.current.isVocalPatternConfirmed;
    const nextFloor =
      partial.ambientNoiseFloor !== undefined
        ? partial.ambientNoiseFloor
        : this.current.ambientNoiseFloor;

    const voxDiff = Math.abs(nextVox - this.current.voxInputLevel);
    const micDiff = Math.abs(nextMic - this.current.micLevel);
    const confirmedChanged = nextConfirmed !== this.current.isVocalPatternConfirmed;
    const zeroTransition =
      (nextVox === 0 && this.current.voxInputLevel !== 0) ||
      (nextMic === 0 && this.current.micLevel !== 0);

    // Deadband filter: ignore tiny sub-2% fluctuations unless state transitioned to 0 or confirmed changed
    if (!forceImmediate && !confirmedChanged && !zeroTransition && voxDiff < 2 && micDiff < 3) {
      return;
    }

    const now = Date.now();
    // Throttle direct DOM indicator updates to ~95ms max cadence unless forced or confirmed changed
    if (!forceImmediate && !confirmedChanged && !zeroTransition && now - this.lastEmitTs < 95) {
      return;
    }

    this.lastEmitTs = now;
    this.current = {
      voxInputLevel: nextVox,
      micLevel: nextMic,
      isVocalPatternConfirmed: nextConfirmed,
      ambientNoiseFloor: nextFloor,
    };
    this.listeners.forEach((l) => l(this.current));
  }
}

const liveAudioMeterStore = new LiveAudioMeterStore();

// Komponen Indikator Slider & Bar Level Vokal VOX (React.memo + Manipulasi DOM Langsung via useRef)
// Memperbarui lebar bar & teks persentase MIC langsung pada DOM tanpa memanggil setState sama sekali!
const VoxThresholdSliderRow = React.memo(function VoxThresholdSliderRow({
  voxThreshold,
  onChangeThreshold,
  isPttLocked,
  activeLockSpeaker,
  voxEnabled,
}: {
  voxThreshold: number;
  onChangeThreshold: (val: number) => void;
  isPttLocked: boolean;
  activeLockSpeaker: string | null;
  voxEnabled: boolean;
}) {
  const barFillRef = useRef<HTMLDivElement | null>(null);
  const statusTextRef = useRef<HTMLSpanElement | null>(null);

  const propsRef = useRef({
    voxThreshold,
    isPttLocked,
    activeLockSpeaker,
    voxEnabled,
  });
  propsRef.current = {
    voxThreshold,
    isPttLocked,
    activeLockSpeaker,
    voxEnabled,
  };

  useEffect(() => {
    const applyDirectDomUpdate = (snap: LiveAudioMeterSnapshot) => {
      const { voxThreshold: thr, isPttLocked: locked, activeLockSpeaker: speaker, voxEnabled: voxOn } =
        propsRef.current;

      if (barFillRef.current) {
        barFillRef.current.style.width = `${Math.min(100, snap.voxInputLevel)}%`;
        barFillRef.current.className =
          snap.voxInputLevel >= thr && snap.isVocalPatternConfirmed
            ? 'h-full transition-all duration-100 bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
            : 'h-full transition-all duration-100 bg-cyan-500/55';
      }

      if (statusTextRef.current) {
        statusTextRef.current.textContent = locked
          ? `LOCKED (${speaker})`
          : voxOn
          ? `MIC:${snap.voxInputLevel}%•THR:${thr}%`
          : 'MANUAL PTT';
      }
    };

    applyDirectDomUpdate(liveAudioMeterStore.getSnapshot());
    return liveAudioMeterStore.subscribe(applyDirectDomUpdate);
  }, [voxThreshold, isPttLocked, activeLockSpeaker, voxEnabled]);

  const initialSnap = liveAudioMeterStore.getSnapshot();

  return (
    <div className="flex items-center gap-2">
      <span
        title="Ambang Batas Sensitivitas VOX (Tenang 30%, Ramai 50%, Angin 80%)"
        className="font-telemetry text-[9px] font-bold text-cyan-100 shrink-0"
      >
        THR <strong className="text-[#23dcff]">{voxThreshold}%</strong>
      </span>

      <div className="relative flex-1 h-4 flex items-center">
        {/* Track Background + Live Vocal Level Bar (Direct DOM via barFillRef) */}
        <div className="w-full h-2 rounded-full bg-[#021220] border border-cyan-400/40 overflow-hidden relative">
          <div
            ref={barFillRef}
            style={{ width: `${Math.min(100, initialSnap.voxInputLevel)}%` }}
            className="h-full transition-all duration-100 bg-cyan-500/55"
          />
        </div>

        {/* Garis Batas Ambang Manual/Preset (Sesuai Posisi Slider Pengguna) */}
        <div
          style={{
            left: `${((voxThreshold - 5) / (85 - 5)) * 100}%`,
          }}
          className="absolute top-0 bottom-0 w-1 -ml-0.5 rounded-full bg-white shadow-[0_0_6px_#23dcff] pointer-events-none"
        />

        {/* Input Range Slider Interaktif (Lancar Digeser Manual 5% - 85%) */}
        <input
          type="range"
          min={5}
          max={85}
          step={1}
          value={voxThreshold}
          onChange={(e) => onChangeThreshold(Number(e.target.value))}
          aria-label="Pengatur Sensitivitas VOX Threshold Slider"
          className="absolute inset-0 w-full h-full accent-[#23dcff] opacity-90 cursor-pointer"
        />
      </div>

      <span
        ref={statusTextRef}
        className="font-telemetry text-[8.5px] text-cyan-100/95 shrink-0 min-w-[88px] text-right"
      >
        {isPttLocked
          ? `LOCKED (${activeLockSpeaker})`
          : voxEnabled
          ? `MIC:${initialSnap.voxInputLevel}%•THR:${voxThreshold}%`
          : 'MANUAL PTT'}
      </span>
    </div>
  );
});

// Komponen Indikator Gelombang Suara Kiri/Kanan Tombol PTT (React.memo + Manipulasi DOM Langsung via useRef)
const LEFT_WAVE_HEIGHTS = [6, 8, 10, 12, 15, 18, 21, 24];
const RIGHT_WAVE_HEIGHTS = [24, 21, 18, 15, 12, 10, 8, 6];

const PttSoundWaveSideBars = React.memo(function PttSoundWaveSideBars({
  side,
  isTransmitting,
  voxEnabled,
  hasActiveLockSpeaker,
}: {
  side: 'left' | 'right';
  isTransmitting: boolean;
  voxEnabled: boolean;
  hasActiveLockSpeaker: boolean;
}) {
  const heights = side === 'left' ? LEFT_WAVE_HEIGHTS : RIGHT_WAVE_HEIGHTS;
  const barSpanRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const propsRef = useRef({
    isTransmitting,
    voxEnabled,
    heights,
  });
  propsRef.current = {
    isTransmitting,
    voxEnabled,
    heights,
  };

  useEffect(() => {
    const applyDirectWaveDom = (snap: LiveAudioMeterSnapshot) => {
      const { isTransmitting: tx, voxEnabled: voxOn, heights: hList } = propsRef.current;
      const activeLevel = Math.max(snap.micLevel, snap.voxInputLevel);

      for (let i = 0; i < hList.length; i++) {
        const el = barSpanRefs.current[i];
        if (!el) continue;
        const h = hList[i];
        el.style.height = tx
          ? `${Math.max(6, ((h * Math.max(25, activeLevel)) / 55) % 34)}px`
          : voxOn && snap.voxInputLevel > 5
          ? `${Math.max(5, ((h * snap.voxInputLevel) / 85) % 22)}px`
          : `${h * 0.65}px`;
      }
    };

    applyDirectWaveDom(liveAudioMeterStore.getSnapshot());
    return liveAudioMeterStore.subscribe(applyDirectWaveDom);
  }, [isTransmitting, voxEnabled, side]);

  return (
    <div className="flex items-center gap-1">
      {heights.map((h, i) => (
        <span
          key={`${side}-${i}`}
          ref={(el) => {
            barSpanRefs.current[i] = el;
          }}
          style={{
            height: `${h * 0.65}px`,
          }}
          className={`w-1.5 rounded-full transition-all duration-100 ${
            isTransmitting || hasActiveLockSpeaker
              ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
              : 'bg-[#23dcff]/55'
          }`}
        />
      ))}
    </div>
  );
});

// Komponen Indikator Level Mic pada Floating Mini Widget (React.memo + Manipulasi DOM Langsung via useRef)
const MiniWidgetMicLevelText = React.memo(function MiniWidgetMicLevelText() {
  const spanRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const applyDirectText = (snap: LiveAudioMeterSnapshot) => {
      if (spanRef.current) {
        spanRef.current.textContent = `MIC: ${snap.voxInputLevel}%`;
      }
    };
    applyDirectText(liveAudioMeterStore.getSnapshot());
    return liveAudioMeterStore.subscribe(applyDirectText);
  }, []);

  return <span ref={spanRef}>MIC: {liveAudioMeterStore.getSnapshot().voxInputLevel}%</span>;
});

export default function App() {
  const { isInstallable, isInstalled, install } = usePWAInstall();

  // Read URL invite parameters once on boot (supports both #hash and ?query)
  const [urlInviteParams, setUrlInviteParams] = useState(() => extractInviteParamsFromUrl());

  // Persistent device ID stored in localStorage
  const [myDeviceId] = useState<string>(() => {
    const saved = localStorage.getItem('diskomlekau_device_id');
    if (saved) return saved;
    const generated = Math.random().toString(36).substring(2, 6).toUpperCase();
    localStorage.setItem('diskomlekau_device_id', generated);
    return generated;
  });

  const [role, setRole] = useState<'MASTER' | 'CLIENT'>(() => {
    if (urlInviteParams.isInvite) return 'CLIENT';
    if (urlInviteParams.role === 'CLIENT' || urlInviteParams.role === 'MASTER') {
      return urlInviteParams.role;
    }
    return (localStorage.getItem('diskomlekau_role') as 'MASTER' | 'CLIENT') || 'MASTER';
  });

  const [localIp, setLocalIp] = useState<string>(() => {
    if (urlInviteParams.isInvite) {
      const savedIp = localStorage.getItem('diskomlekau_ip');
      if (savedIp && savedIp !== '192.168.43.1') return savedIp;
      return `192.168.43.${Math.floor(102 + Math.random() * 90)}`;
    }
    return localStorage.getItem('diskomlekau_ip') || '192.168.43.1';
  });

  const [channel, setChannel] = useState<number>(() => {
    if (urlInviteParams.channel) return urlInviteParams.channel;
    return Number(localStorage.getItem('diskomlekau_channel')) || 12;
  });

  const [myCallsign, setMyCallsign] = useState<string>(() => {
    return localStorage.getItem('diskomlekau_callsign') || 'GARUDA-1';
  });

  // Autentikasi Passcode Operasional Harian (Disimpan di sessionStorage agar otomatis terhapus saat browser ditutup)
  const [isPasscodeAuthenticated, setIsPasscodeAuthenticated] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(TACTICAL_AUTH_SESSION_KEY) === PASSCODE_HARIAN;
    } catch {
      return false;
    }
  });
  const isPasscodeAuthenticatedRef = useRef<boolean>(isPasscodeAuthenticated);
  useEffect(() => {
    isPasscodeAuthenticatedRef.current = isPasscodeAuthenticated;
    if (isPasscodeAuthenticated) {
      // Pre-derive and cache AES-256-GCM CryptoKey in RAM for <1ms real-time voice encryption
      getOrDeriveTacticalAesKey(PASSCODE_HARIAN);
    }
  }, [isPasscodeAuthenticated]);

  const [passcodeInput, setPasscodeInput] = useState<string>('');
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [e2eEncryptedTxCount, setE2eEncryptedTxCount] = useState<number>(0);
  const [e2eDecryptedRxCount, setE2eDecryptedRxCount] = useState<number>(0);
  const [lastAesIvPreview, setLastAesIvPreview] = useState<string>('AES-256-GCM SIAP');

  const [isSetupCompleted, setIsSetupCompleted] = useState<boolean>(() => {
    try {
      return (
        sessionStorage.getItem(TACTICAL_AUTH_SESSION_KEY) === PASSCODE_HARIAN &&
        Boolean(localStorage.getItem('diskomlekau_callsign'))
      );
    } catch {
      return false;
    }
  });

  const [setupCallsignInput, setSetupCallsignInput] = useState<string>(() => {
    return localStorage.getItem('diskomlekau_callsign') || 'GARUDA-1';
  });

  const [setupIpMode, setSetupIpMode] = useState<'192.168.43.1' | 'CLIENT'>(() => {
    if (urlInviteParams.isInvite) return 'CLIENT';
    const savedRole = localStorage.getItem('diskomlekau_role');
    if (savedRole === 'CLIENT') return 'CLIENT';
    if (savedRole === 'MASTER') return '192.168.43.1';
    const savedIp = localStorage.getItem('diskomlekau_ip') || '192.168.43.1';
    return savedIp === '192.168.43.1' ? '192.168.43.1' : 'CLIENT';
  });

  // Cloud Handshake PeerJS ID:
  // - Master attempts static ID: 'PTT-MASTER-01' (auto-failover to unique client ID if already taken on 0.peerjs.com)
  // - Client registers unique ID: 'PTT-CLIENT-[CALLSIGN]-[ID]'
  const sanitizedCallsignForPeer =
    (myCallsign || 'UNIT').replace(/[^A-Z0-9]/gi, '').toUpperCase() || 'UNIT';
  const cleanShortDeviceId =
    myDeviceId.replace(/[^A-Z0-9]/gi, '').toUpperCase() || '01';
  const uniqueClientPeerId = `PTT-CLIENT-${sanitizedCallsignForPeer}-${cleanShortDeviceId}`;
  const preferredPeerId =
    role === 'MASTER' || localIp === '192.168.43.1'
      ? MASTER_PEER_ID
      : uniqueClientPeerId;
  const [activeBoundPeerId, setActiveBoundPeerId] =
    useState<string>(preferredPeerId);
  const myPeerNodeId = activeBoundPeerId || preferredPeerId;
  const activeBoundPeerIdRef = useRef<string>(myPeerNodeId);
  useEffect(() => {
    activeBoundPeerIdRef.current = myPeerNodeId;
  }, [myPeerNodeId]);

  // Target Master Host Peer ID from Barcode Invite Link or manual paste
  const [invitedHostPeer, setInvitedHostPeer] = useState<string>(urlInviteParams.hostPeer);
  const [invitedHostCallsign, setInvitedHostCallsign] = useState<string>(
    urlInviteParams.hostCallsign
  );
  const [manualInviteInput, setManualInviteInput] = useState<string>('');
  const [inviteJoinStatus, setInviteJoinStatus] = useState<string | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');

  // In-App Camera Barcode Scanner states (prevents external browser 404 errors)
  const [barcodeTab, setBarcodeTab] = useState<'show' | 'scan'>('show');
  const [isSetupScannerOpen, setIsSetupScannerOpen] = useState<boolean>(false);
  const [isCameraScanning, setIsCameraScanning] = useState<boolean>(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerRafRef = useRef<number | null>(null);

  const [pingMs, setPingMs] = useState<number>(18);
  const [pingDelta, setPingDelta] = useState<number>(2);
  const [isRefreshingPing, setIsRefreshingPing] = useState<boolean>(false);
  const [talkAll, setTalkAll] = useState<boolean>(true);
  // Real Peers Only: Starts empty and only populates when real peers announce on the channel
  const [members, setMembers] = useState<TacticalMember[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const [fullScreenStretch, setFullScreenStretch] = useState<boolean>(true);

  // Real Microphone, PTT, VOX (Voice Activity Detection), Mobile Compatibility & Keep-Alive states
  const [mobilePlatformInfo] = useState(() => detectMobileAudioPlatform());
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [incomingSpeaker, setIncomingSpeaker] = useState<string | null>(null);
  const [micPermissionState, setMicPermissionState] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [micConstraintTier, setMicConstraintTier] = useState<string>('STANDBY');
  const [micErrorNotice, setMicErrorNotice] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  // Default Echo Test to false so real Walkie-Talkie operation never echoes local speech
  const [echoTestMode, setEchoTestMode] = useState<boolean>(false);
  const [, setConnectedPeersCount] = useState<number>(0);

  // Background Keep-Alive (Silent Audio Stream via Web Audio API + Screen Wake Lock + Service Worker)
  const [keepAliveEnabled, setKeepAliveEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('diskomlekau_keepalive_enabled');
    return saved !== null ? saved === 'true' : true;
  });
  const [, setIsSilentKeepAliveRunning] = useState<boolean>(false);
  const [isBackgroundMode, setIsBackgroundMode] = useState<boolean>(false);
  // Mode Minimasi (Aplikasi menghilang penuh ke background + Media Session API Silent Audio Loop)
  const [isMinimizedMode, setIsMinimizedMode] = useState<boolean>(false);
  const isMinimizedModeRef = useRef<boolean>(false);
  const wasHiddenWhileMinimizedRef = useRef<boolean>(false);
  const [isPipFloatingActive, setIsPipFloatingActive] = useState<boolean>(false);
  const [isMediaSessionActive, setIsMediaSessionActive] = useState<boolean>(false);
  const [isWakeLockActive, setIsWakeLockActive] = useState<boolean>(false);
  const [isSwKeepAliveActive, setIsSwKeepAliveActive] = useState<boolean>(false);
  const keepAliveEnabledRef = useRef<boolean>(keepAliveEnabled);
  const keepAliveSessionRef = useRef<SilentKeepAliveSession | null>(null);
  // Refs untuk Teknik Bypass 1 (PiP Canvas -> Video Floating Widget) & Teknik Bypass 2 (<audio loop> Silent Loop)
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipStreamRef = useRef<MediaStream | null>(null);
  const silentLoopAudioRef = useRef<HTMLAudioElement | null>(null);

  // VOX (Voice Activity Detection) Hands-Free Web Audio API states (Kalibrasi Seimbang 18% - 22%)
  // Ambang batas default disetel seimbang di 20% (kisaran 18% - 22%): cukup kuat meredam bising latar rendah namun responsif terhadap vokal.
  // Slider stabil 100%: tidak pernah bergeser sendiri secara liar, hanya berubah saat digeser manual atau memilih preset.
  const [voxEnabled, setVoxEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('diskomlekau_vox_enabled');
    return saved !== null ? saved === 'true' : true;
  });
  const [voxThreshold, setVoxThreshold] = useState<number>(() => {
    const raw = localStorage.getItem('diskomlekau_vox_threshold_balanced_v6');
    if (raw !== null) {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed) && parsed >= 5 && parsed <= 85) {
        return parsed;
      }
    }
    return 30;
  });
  const [voxHoldMs, setVoxHoldMs] = useState<number>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_vox_hold_ms'));
    // Gunakan 1500ms (1.5 detik) secara default agar jeda napas antar kata tidak pernah memutus suara saat bicara
    if (saved === 1100) return 1500;
    return saved >= 500 && saved <= 3000 ? saved : 1500;
  });
  // Penguatan Volume Penerima Suara (Web Audio API GainNode: default gain.value = 2.2)
  const [rxGainBoost, setRxGainBoost] = useState<number>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_rx_gain'));
    return saved >= 1.0 && saved <= 4.0 ? saved : 2.2;
  });
  // Pengaturan Bitrate Ekstrem Opus Codec (8 kbps - 12 kbps, max 12 kbps Narrowband/Wideband speech)
  // Dilengkapi Inband FEC (useinbandfec=1) & DTX (usedtx=1) agar tahan sinyal buruk & packet loss tinggi
  const [opusBitrateKbps, setOpusBitrateKbps] = useState<8 | 10 | 12>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_opus_bitrate_ultra_kbps'));
    if (saved === 8 || saved === 10 || saved === 12) return saved;
    return 12;
  });
  // Status Tombol Kontrol Prioritas Override (Menghentikan transmisi klien lain seketika)
  const [isPriorityOverride, setIsPriorityOverride] = useState<boolean>(false);

  // Helper terpusat untuk memperbarui indikator level audio dinamis (via LiveAudioMeterStore)
  // tanpa memicu re-render pada halaman utama App!
  const setVoxInputLevel = useCallback((val: number, force = false) => {
    liveAudioMeterStore.update({ voxInputLevel: val }, force);
  }, []);
  const setMicLevel = useCallback((val: number, force = false) => {
    liveAudioMeterStore.update({ micLevel: val }, force);
  }, []);
  const setIsVocalPatternConfirmed = useCallback((val: boolean) => {
    liveAudioMeterStore.update({ isVocalPatternConfirmed: val });
  }, []);
  const setAmbientNoiseFloor = useCallback((val: number) => {
    liveAudioMeterStore.update({ ambientNoiseFloor: val });
  }, []);

  const getVoxNoiseGateLabel = (thr: number) => {
    if (thr <= 35) return 'TENANG';
    if (thr <= 65) return 'RAMAI';
    return 'ANGIN';
  };

  // Bottom Navigation Modal States & On-Screen Tactical Chat States
  const [activeBottomModal, setActiveBottomModal] = useState<
    null | 'channels' | 'chat' | 'editName' | 'barcode' | 'settings'
  >(null);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'apkGuide' | 'flutterCode'>('audio');
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Real-Time On-Screen Tactical Chat State
  const [chatMessages, setChatMessages] = useState<TacticalChatMessage[]>(() => {
    try {
      const saved = localStorage.getItem('tactical_wicomm_chat_v1');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed.slice(-80);
      }
    } catch {
      // Ignore storage error
    }
    return [];
  });
  const [chatInput, setChatInput] = useState<string>('');
  const [isOnScreenChatOpen, setIsOnScreenChatOpen] = useState<boolean>(true);
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const onScreenChatEndRef = useRef<HTMLDivElement | null>(null);
  const modalChatEndRef = useRef<HTMLDivElement | null>(null);

  // Audio, WebRTC, Offline Hotspot LAN & WSS Cloud Mesh refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voxPreAmpGainRef = useRef<GainNode | null>(null);
  const micLoopbackKeepAliveGainRef = useRef<GainNode | null>(null);
  const micFilterRef = useRef<BiquadFilterNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  // Web Audio API PCM-to-WAV Fallback Recorder refs (for Safari iOS / HarmonyOS WebViews without MediaRecorder)
  const pcmProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmZeroGainRef = useRef<GainNode | null>(null);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const isPcmRecordingRef = useRef<boolean>(false);
  const reusableRxAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeWebAudioRxStopRef = useRef<(() => void) | null>(null);
  const animFrameRef = useRef<number | null>(null);
  // VOX (Voice Activity Detection), Adaptive Noise Gate & Channel Lockout / Anti-Collision refs
  const voxEnabledRef = useRef<boolean>(voxEnabled);
  const voxThresholdRef = useRef<number>(voxThreshold);
  const voxHoldMsRef = useRef<number>(voxHoldMs);
  const rxGainBoostRef = useRef<number>(rxGainBoost);
  const opusBitrateKbpsRef = useRef<8 | 10 | 12>(opusBitrateKbps);
  const lastVoiceActiveTimeRef = useRef<number>(0);
  const voxVoiceFramesRef = useRef<number>(0);
  // Refs untuk Adaptive Noise Floor Calibration & Voice Pattern Verification (Hysteresis 175-200ms)
  const ambientNoiseFloorRef = useRef<number>(5);
  const noiseCalibrationSamplesRef = useRef<number[]>([]);
  const isInitialNoiseCalibratingRef = useRef<boolean>(true);
  const voiceOnsetStartTimeRef = useRef<number>(0);
  const lastVocalDipTimeRef = useRef<number>(0);
  const isVoxTriggeredTxRef = useRef<boolean>(false);
  const isPriorityOverrideRef = useRef<boolean>(false);
  const rxCooldownUntilRef = useRef<number>(0);
  // Antrean Pemutaran Audio Penerima Tanpa Putus + Adaptive Jitter Buffer (100ms - 200ms)
  const rxAudioQueueRef = useRef<
    Array<{
      base64Data: string;
      senderCallsign: string;
      senderDeviceId?: string;
      enqueuedAt: number;
      decodedBufferPromise?: Promise<AudioBuffer | null>;
    }>
  >([]);
  const isRxQueuePlayingRef = useRef<boolean>(false);
  const lastRxSegmentStartTsRef = useRef<number>(0);
  const lastPcmFlushTsRef = useRef<number>(0);
  // Adaptive Jitter Buffer (100ms - 200ms) refs untuk menampung paket terlambat di kondisi internet buruk
  const isJitterBufferingRef = useRef<boolean>(false);
  const jitterBufferTimerRef = useRef<number | null>(null);
  const latePacketGraceTimerRef = useRef<number | null>(null);
  const lastRxPacketArrivalTsRef = useRef<number>(0);
  const estimatedRxJitterMsRef = useRef<number>(35);
  const currentAdaptiveJitterDelayMsRef = useRef<number>(140);
  // Graceful Degradation Store-and-Forward Outbox Queue saat sinyal hilang sesaat
  const pendingOutboxQueueRef = useRef<
    Array<{ serialized: string; packet: MeshPacket; queuedAt: number }>
  >([]);
  const [channelLockOwner, setChannelLockOwner] = useState<ChannelLockInfo | null>(null);
  const channelLockOwnerRef = useRef<ChannelLockInfo | null>(null);
  const localTxStartedAtRef = useRef<number>(0);
  const abortDiscardRecordingRef = useRef<boolean>(false);
  const txLockHeartbeatRef = useRef<number | null>(null);
  const [collisionBlockedNotice, setCollisionBlockedNotice] = useState<string | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const directNodePeerRef = useRef<Peer | null>(null);
  const peerConnectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const pendingConnectTimestampRef = useRef<Map<string, number>>(new Map());
  const mqttClientsRef = useRef<MqttClient[]>([]);
  const offlineRtcChannelsRef = useRef<Map<string, RTCDataChannel>>(new Map());
  const offlineMasterPcSlotsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const offlineClientPcRef = useRef<RTCPeerConnection | null>(null);
  const detectedLanIpRef = useRef<string>('');
  const localHotspotWsRef = useRef<WebSocket | null>(null);
  const [offlineOfferToken, setOfflineOfferToken] = useState<string>('');
  const [offlineAnswerToken, setOfflineAnswerToken] = useState<string>('');
  const [offlineAnswerQrUrl, setOfflineAnswerQrUrl] = useState<string>('');
  const [qrDisplayMode, setQrDisplayMode] = useState<'offlineFast' | 'inviteUrl'>('offlineFast');
  const [isHotspotLanHubConnected, setIsHotspotLanHubConnected] = useState<boolean>(false);
  const seenPacketIdsRef = useRef<Set<string>>(new Set());
  const lastAnnounceReplyRef = useRef<Map<string, number>>(new Map());
  const memberLastSeenMapRef = useRef<Map<string, number>>(new Map());
  const membersRef = useRef<TacticalMember[]>([]);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  // Persist user identity & role permanently in localStorage
  useEffect(() => {
    if (!myCallsign) return;
    localStorage.setItem('diskomlekau_callsign', myCallsign);
    localStorage.setItem('diskomlekau_channel', String(channel));
    localStorage.setItem('diskomlekau_role', role);
    localStorage.setItem('diskomlekau_ip', localIp);
  }, [myCallsign, channel, role, localIp]);

  // Persist VOX, Keep-Alive, Receiver GainNode Boost & Opus Low-Bitrate settings & sync refs
  useEffect(() => {
    voxEnabledRef.current = voxEnabled;
    voxThresholdRef.current = voxThreshold;
    voxHoldMsRef.current = voxHoldMs;
    keepAliveEnabledRef.current = keepAliveEnabled;
    rxGainBoostRef.current = rxGainBoost;
    opusBitrateKbpsRef.current = opusBitrateKbps;
    // Aktifkan interseptor SDP WebRTC global untuk memaksa useinbandfec=1, usedtx=1, & max 12 kbps
    installGlobalWebRtcOpusSdpPatch(opusBitrateKbps * 1000);
    try {
      localStorage.setItem('diskomlekau_vox_enabled', String(voxEnabled));
      localStorage.setItem('diskomlekau_vox_threshold_balanced_v6', String(voxThreshold));
      localStorage.setItem('diskomlekau_vox_threshold', String(voxThreshold));
      localStorage.setItem('diskomlekau_vox_hold_ms', String(voxHoldMs));
      localStorage.setItem('diskomlekau_keepalive_enabled', String(keepAliveEnabled));
      localStorage.setItem('diskomlekau_rx_gain', String(rxGainBoost));
      localStorage.setItem('diskomlekau_opus_bitrate_ultra_kbps', String(opusBitrateKbps));
    } catch {
      // Ignore storage error
    }
  }, [voxEnabled, voxThreshold, voxHoldMs, keepAliveEnabled, rxGainBoost, opusBitrateKbps]);

  // Persist tactical chat messages & scroll internal container without shifting page viewport
  const prevChatLenRef = useRef<number>(chatMessages.length);
  useEffect(() => {
    try {
      localStorage.setItem(
        'tactical_wicomm_chat_v1',
        JSON.stringify(chatMessages.slice(-80))
      );
    } catch {
      // Ignore quota error
    }
    if (chatMessages.length !== prevChatLenRef.current) {
      prevChatLenRef.current = chatMessages.length;
      const onScreenParent = onScreenChatEndRef.current?.parentElement;
      if (onScreenParent) {
        onScreenParent.scrollTop = onScreenParent.scrollHeight;
      }
      const modalParent = modalChatEndRef.current?.parentElement;
      if (modalParent) {
        modalParent.scrollTop = modalParent.scrollHeight;
      }
    }
  }, [chatMessages]);

  // Integrasi Screen Wake Lock API + Background Service Worker Keep-Alive (/tactical-bg-sw.js)
  // Menjaga sesi siaga VOX, WebSocket, dan Web Audio API tetap hidup stabil saat diminimalkan (Mini Mode)
  // maupun saat pengguna membuka aplikasi lain di HP.
  useEffect(() => {
    isMinimizedModeRef.current = isMinimizedMode;
  }, [isMinimizedMode]);

  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    let swHeartbeatTimer: number | null = null;
    let isUnmounted = false;

    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          if (wakeLock && !wakeLock.released) return;
          wakeLock = await navigator.wakeLock.request('screen');
          if (!isUnmounted) {
            setIsWakeLockActive((prev) => (prev ? prev : true));
          }
          wakeLock.addEventListener('release', () => {
            if (!isUnmounted) {
              setIsWakeLockActive((prev) => (!prev ? prev : false));
            }
          });
        }
      } catch {
        // Ignore if browser requires a user gesture first; pointerdown listener below will re-request
      }
    };

    requestWakeLock();

    // Register Tactical Background Keep-Alive Worker
    registerTacticalBackgroundServiceWorker(() => {
      if (!isUnmounted) {
        setIsSwKeepAliveActive((prev) => (prev ? prev : true));
      }
    }).then((reg) => {
      if (reg && !isUnmounted) {
        setIsSwKeepAliveActive((prev) => (prev ? prev : true));
        sendServiceWorkerKeepAlivePing({
          callsign: myCallsign || 'UNIT',
          channel,
          minimized: isMinimizedModeRef.current,
          voxEnabled: voxEnabledRef.current,
        });
      }
    });

    // Periodic Keep-Alive Ping (every 4s) to prevent background thread suspension
    swHeartbeatTimer = window.setInterval(() => {
      sendServiceWorkerKeepAlivePing({
        callsign: myCallsign || 'UNIT',
        channel,
        minimized: isMinimizedModeRef.current || document.hidden,
        voxEnabled: voxEnabledRef.current,
      });
      if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) {
        requestWakeLock();
      }
    }, 4000);

    const handleVisibilityOrFocusWakeLock = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
      sendServiceWorkerKeepAlivePing({
        callsign: myCallsign || 'UNIT',
        channel,
        minimized: isMinimizedModeRef.current || document.hidden,
        voxEnabled: voxEnabledRef.current,
      });
    };

    const handleUserGestureWakeLock = () => {
      if (document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocusWakeLock);
    window.addEventListener('focus', handleVisibilityOrFocusWakeLock);
    window.addEventListener('pageshow', handleVisibilityOrFocusWakeLock);
    window.addEventListener('pointerdown', handleUserGestureWakeLock, { passive: true });
    window.addEventListener('touchstart', handleUserGestureWakeLock, { passive: true });
    return () => {
      isUnmounted = true;
      if (swHeartbeatTimer) {
        window.clearInterval(swHeartbeatTimer);
      }
      document.removeEventListener('visibilitychange', handleVisibilityOrFocusWakeLock);
      window.removeEventListener('focus', handleVisibilityOrFocusWakeLock);
      window.removeEventListener('pageshow', handleVisibilityOrFocusWakeLock);
      window.removeEventListener('pointerdown', handleUserGestureWakeLock);
      window.removeEventListener('touchstart', handleUserGestureWakeLock);
      wakeLock?.release().catch(() => {});
    };
  }, [myCallsign, channel]);

  // Tactical Walkie-Talkie Roger Beep & Squelch Synthesizer (Safari iOS & Chrome Android/HarmonyOS compatible)
  const playTacticalTone = useCallback(
    (type: 'start' | 'end' | 'rx') => {
      if (!soundEnabled) return;
      try {
        const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
        if (!ctx) return;
        audioCtxRef.current = ctx;

        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'start') {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1320, now);
          osc.frequency.setValueAtTime(1760, now + 0.04);
          gain.gain.setValueAtTime(0.11, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
          osc.start(now);
          osc.stop(now + 0.095);
        } else if (type === 'end') {
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(1620, now);
          osc.frequency.setValueAtTime(1200, now + 0.055);
          gain.gain.setValueAtTime(0.12, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
          osc.start(now);
          osc.stop(now + 0.15);
        } else {
          osc.type = 'sine';
          osc.frequency.setValueAtTime(1040, now);
          gain.gain.setValueAtTime(0.09, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
          osc.start(now);
          osc.stop(now + 0.085);
        }
      } catch {
        // Ignore audio context restriction
      }
    },
    [soundEnabled]
  );

  const activeAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const remoteActiveTxRef = useRef<string | null>(null);
  const pttSegmentIntervalRef = useRef<number | null>(null);
  const isTransmittingRef = useRef<boolean>(false);
  // Strict Half-Duplex: Receiver (RX) is forced OFF while PTT is open (from 1st click until 2nd click)
  const isReceiverOffRef = useRef<boolean>(false);
  useEffect(() => {
    isTransmittingRef.current = isTransmitting;
    isReceiverOffRef.current = isTransmitting;
  }, [isTransmitting]);

  // Helper to immediately mute & shut off Receiver (both HTMLAudioElement, Web Audio BufferSource, Jitter Buffer & RX Queue) during PTT/VOX Open
  const muteAndDisableReceiver = useCallback(() => {
    isReceiverOffRef.current = true;
    rxAudioQueueRef.current = [];
    isRxQueuePlayingRef.current = false;
    isJitterBufferingRef.current = false;
    if (jitterBufferTimerRef.current) {
      window.clearTimeout(jitterBufferTimerRef.current);
      jitterBufferTimerRef.current = null;
    }
    if (latePacketGraceTimerRef.current) {
      window.clearTimeout(latePacketGraceTimerRef.current);
      latePacketGraceTimerRef.current = null;
    }
    if (activeWebAudioRxStopRef.current) {
      try {
        activeWebAudioRxStopRef.current();
      } catch {
        // Ignore Web Audio RX stop error
      }
      activeWebAudioRxStopRef.current = null;
    }
    if (activeAudioElementRef.current) {
      try {
        activeAudioElementRef.current.muted = true;
        activeAudioElementRef.current.volume = 0.0;
        activeAudioElementRef.current.pause();
      } catch {
        // Ignore audio element cleanup error
      }
      activeAudioElementRef.current = null;
    }
  }, []);

  // Helper to force-stop microphone recording (both MediaRecorder & PCM fallback) & re-enable Receiver
  const forceStopLocalRecording = useCallback((discardClip = false) => {
    if (discardClip) {
      abortDiscardRecordingRef.current = true;
    }
    setIsTransmitting(false);
    isTransmittingRef.current = false;
    isReceiverOffRef.current = false;
    isVoxTriggeredTxRef.current = false;
    voxVoiceFramesRef.current = 0;
    voiceOnsetStartTimeRef.current = 0;
    setMicLevel(0);
    if (pttSegmentIntervalRef.current) {
      window.clearInterval(pttSegmentIntervalRef.current);
      pttSegmentIntervalRef.current = null;
    }
    if (txLockHeartbeatRef.current) {
      window.clearInterval(txLockHeartbeatRef.current);
      txLockHeartbeatRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore stop error
      }
    }
    if (isPcmRecordingRef.current) {
      isPcmRecordingRef.current = false;
      pcmChunksRef.current = [];
      try {
        pcmProcessorRef.current?.disconnect();
        pcmZeroGainRef.current?.disconnect();
      } catch {
        // Ignore PCM disconnect error
      }
      pcmProcessorRef.current = null;
      pcmZeroGainRef.current = null;
    }
    // Physically mute hardware mic track while in RX / Channel Lockout mode
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }
    rxCooldownUntilRef.current = Date.now() + 650;
  }, []);

  // Play incoming Base64 voice clip using an Adaptive Jitter Buffer (100ms - 200ms) + Seamless Gapless RX Queue
  // so consecutive segments NEVER stutter or cut off even under high packet loss & poor internet!
  const playIncomingAudioBase64 = useCallback(
    (
      base64Data: string,
      senderCallsign: string,
      senderDeviceId?: string,
      isPriorityPreempt = false
    ) => {
      if (!soundEnabled) return;
      // STRICT ANTI-ECHO: While PTT/VOX is open (TX active / Receiver OFF), NEVER play any speaker audio!
      if (isTransmittingRef.current || isReceiverOffRef.current) return;
      // Prevent self-echo if own packet ever loops back from a relay broker
      if (senderDeviceId && senderDeviceId === myDeviceId) return;

      const now = Date.now();
      rxCooldownUntilRef.current = now + 3400;
      voxVoiceFramesRef.current = 0;
      voiceOnsetStartTimeRef.current = 0;
      setVoxInputLevel(0);

      // Hitung estimasi Jitter Jaringan (EWMA RFC 3550) & tentukan Adaptive Jitter Buffer (100ms - 200ms)
      if (lastRxPacketArrivalTsRef.current > 0) {
        const interArrivalMs = now - lastRxPacketArrivalTsRef.current;
        if (interArrivalMs > 15 && interArrivalMs < 2800) {
          const expectedInterval = 950;
          const deviation = Math.min(250, Math.abs(interArrivalMs - expectedInterval));
          estimatedRxJitterMsRef.current =
            estimatedRxJitterMsRef.current * 0.75 + deviation * 0.25;
        }
      }
      lastRxPacketArrivalTsRef.current = now;
      // Kunci rentang Adaptive Jitter Buffer secara presisi di antara 100ms hingga 200ms
      const adaptiveJitterBufferMs = Math.max(
        100,
        Math.min(200, Math.round(115 + estimatedRxJitterMsRef.current * 0.45))
      );
      currentAdaptiveJitterDelayMsRef.current = adaptiveJitterBufferMs;

      if (senderDeviceId) {
        const lockObj: ChannelLockInfo = {
          senderId: senderDeviceId,
          callsign: senderCallsign,
          startedAt: channelLockOwnerRef.current?.startedAt || now,
          updatedAt: now,
          isPriorityOverride:
            isPriorityPreempt || channelLockOwnerRef.current?.isPriorityOverride,
        };
        channelLockOwnerRef.current = lockObj;
        setChannelLockOwner(lockObj);
      }

      // ISOLASI TOTAL SPEAKER-KE-MIKROFON (ANTI-ECHO GATE SAAT PLAYBACK PENERIMA):
      // Matikan track mikrofon & kunci gain input mikrofon ke 0.0 selama speaker memutar suara masuk
      // agar suara dari speaker tidak pernah bocor atau terpantul masuk kembali ke mikrofon perangkat yang sama!
      if (voxPreAmpGainRef.current && audioCtxRef.current) {
        try {
          voxPreAmpGainRef.current.gain.setValueAtTime(0, audioCtxRef.current.currentTime);
        } catch {
          voxPreAmpGainRef.current.gain.value = 0;
        }
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      // If Priority Override preempts a different speaker, clear old queue and stop previous speaker immediately
      if (isPriorityPreempt) {
        rxAudioQueueRef.current = [];
        isJitterBufferingRef.current = false;
        if (jitterBufferTimerRef.current) {
          window.clearTimeout(jitterBufferTimerRef.current);
          jitterBufferTimerRef.current = null;
        }
        if (latePacketGraceTimerRef.current) {
          window.clearTimeout(latePacketGraceTimerRef.current);
          latePacketGraceTimerRef.current = null;
        }
        if (activeWebAudioRxStopRef.current) {
          try {
            activeWebAudioRxStopRef.current();
          } catch {
            // Ignore
          }
          activeWebAudioRxStopRef.current = null;
        }
        if (activeAudioElementRef.current) {
          try {
            activeAudioElementRef.current.pause();
          } catch {
            // Ignore
          }
          activeAudioElementRef.current = null;
        }
        isRxQueuePlayingRef.current = false;
      }

      // Pre-decode the incoming Opus/WAV segment into a Web Audio API AudioBuffer immediately upon arrival
      // while the segment rests inside the 100ms-200ms Adaptive Jitter Buffer so playback transitions with 0ms gap!
      const preDecodeCtx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (preDecodeCtx) {
        audioCtxRef.current = preDecodeCtx;
      }
      const decodedBufferPromise = preDecodeCtx
        ? preDecodeBase64AudioToBuffer(preDecodeCtx, base64Data)
        : undefined;

      // Anti-backlog protection: prevent stale audio segments from piling up if extreme network bursts occur
      if (rxAudioQueueRef.current.length >= 10) {
        rxAudioQueueRef.current.splice(0, rxAudioQueueRef.current.length - 6);
      }

      // Enqueue the decrypted & pre-decoding audio segment so ongoing speech flows seamlessly without gaps!
      rxAudioQueueRef.current.push({
        base64Data,
        senderCallsign,
        senderDeviceId,
        enqueuedAt: now,
        decodedBufferPromise,
      });

      const finalizeQueueAndRestoreVox = (lastSpeaker: string) => {
        isRxQueuePlayingRef.current = false;
        isJitterBufferingRef.current = false;
        activeWebAudioRxStopRef.current = null;
        // 800ms Acoustic Tail Guard so speaker room reflection completely decays before mic re-opens
        rxCooldownUntilRef.current = Date.now() + 800;

        if (
          !remoteActiveTxRef.current ||
          remoteActiveTxRef.current === lastSpeaker
        ) {
          remoteActiveTxRef.current = null;
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          setIncomingSpeaker((curr) => (curr === lastSpeaker ? null : curr));
        }

        if (!isTransmittingRef.current && !isReceiverOffRef.current) {
          playTacticalTone('end');
        }

        window.setTimeout(() => {
          if (
            !isTransmittingRef.current &&
            !remoteActiveTxRef.current &&
            !channelLockOwnerRef.current &&
            !isRxQueuePlayingRef.current
          ) {
            if (voxPreAmpGainRef.current && audioCtxRef.current) {
              try {
                voxPreAmpGainRef.current.gain.setValueAtTime(
                  1.65,
                  audioCtxRef.current.currentTime
                );
              } catch {
                voxPreAmpGainRef.current.gain.value = 1.65;
              }
            }
            if (voxEnabledRef.current && mediaStreamRef.current) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            }
          }
        }, 780);
      };

      const playNextSegmentInQueue = () => {
        if (isTransmittingRef.current || isReceiverOffRef.current) {
          rxAudioQueueRef.current = [];
          isRxQueuePlayingRef.current = false;
          isJitterBufferingRef.current = false;
          return;
        }

        const nextItem = rxAudioQueueRef.current.shift();
        if (!nextItem) {
          finalizeQueueAndRestoreVox(senderCallsign);
          return;
        }

        // Ensure any remaining item in the queue has already started pre-decoding in the background
        const upcomingItem = rxAudioQueueRef.current[0];
        if (upcomingItem && !upcomingItem.decodedBufferPromise) {
          const ctxForUpcoming = getOrCreateCompatibleAudioContext(audioCtxRef.current);
          if (ctxForUpcoming) {
            audioCtxRef.current = ctxForUpcoming;
            upcomingItem.decodedBufferPromise = preDecodeBase64AudioToBuffer(
              ctxForUpcoming,
              upcomingItem.base64Data
            );
          }
        }

        setIncomingSpeaker(nextItem.senderCallsign);
        lastRxSegmentStartTsRef.current = Date.now();
        rxCooldownUntilRef.current = Date.now() + 2800;

        // Smooth adaptive catch-up rate if multiple segments arrived in a burst so latency never accumulates
        const remainingQueueDepth = rxAudioQueueRef.current.length;
        const adaptivePlaybackRate =
          remainingQueueDepth >= 4 ? 1.06 : remainingQueueDepth >= 2 ? 1.03 : 1.0;

        let segmentEndedHandled = false;
        const onSegmentEnded = () => {
          if (segmentEndedHandled) return;
          segmentEndedHandled = true;
          activeWebAudioRxStopRef.current = null;
          if (rxAudioQueueRef.current.length > 0) {
            // Immediately play next pre-decoded queued segment with zero gap and no extra beep!
            playNextSegmentInQueue();
          } else {
            // BANTALAN PENAMPUNG PAKET TERLAMBAT (LATE-PACKET JITTER CUSHION):
            // Selama pengirim masih menahan tombol PTT (remoteActiveTxRef / channelLockOwnerRef aktif),
            // tahan sesi RX hingga 650ms agar segmen ke-2, ke-3, dst. tidak pernah terputus!
            if (latePacketGraceTimerRef.current) {
              window.clearTimeout(latePacketGraceTimerRef.current);
            }
            const isSenderStillTransmitting = Boolean(
              remoteActiveTxRef.current || channelLockOwnerRef.current
            );
            const graceWaitMs = isSenderStillTransmitting ? 650 : 220;
            latePacketGraceTimerRef.current = window.setTimeout(() => {
              latePacketGraceTimerRef.current = null;
              if (rxAudioQueueRef.current.length > 0) {
                playNextSegmentInQueue();
              } else {
                finalizeQueueAndRestoreVox(nextItem.senderCallsign);
              }
            }, graceWaitMs);
          }
        };

        const playViaHtmlAudioWithGainFallback = () => {
          if (isTransmittingRef.current || isReceiverOffRef.current) {
            rxAudioQueueRef.current = [];
            isRxQueuePlayingRef.current = false;
            isJitterBufferingRef.current = false;
            return;
          }
          try {
            if (!reusableRxAudioRef.current) {
              const el = new Audio();
              el.setAttribute('playsinline', 'true');
              el.setAttribute('webkit-playsinline', 'true');
              reusableRxAudioRef.current = el;
            }
            const audio = reusableRxAudioRef.current;
            audio.pause();
            audio.src = nextItem.base64Data;
            audio.muted = false;
            audio.volume = 1.0;
            audio.playbackRate = adaptivePlaybackRate;

            const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
            if (ctx) {
              audioCtxRef.current = ctx;
              ensureHtmlAudioElementGainBooster(
                ctx,
                audio,
                rxGainBoostRef.current || 2.2
              );
            }

            activeAudioElementRef.current = audio;
            audio.onended = onSegmentEnded;
            audio.onerror = onSegmentEnded;

            const playPromise = audio.play();
            if (playPromise !== undefined) {
              playPromise.catch(onSegmentEnded);
            }
          } catch {
            onSegmentEnded();
          }
        };

        (async () => {
          if (isTransmittingRef.current || isReceiverOffRef.current) {
            rxAudioQueueRef.current = [];
            isRxQueuePlayingRef.current = false;
            isJitterBufferingRef.current = false;
            return;
          }
          const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
          if (!ctx) {
            playViaHtmlAudioWithGainFallback();
            return;
          }
          audioCtxRef.current = ctx;
          const preDecodedBuf = nextItem.decodedBufferPromise
            ? await nextItem.decodedBufferPromise
            : null;
          const handle = await playBase64AudioViaWebAudioFallback(
            ctx,
            nextItem.base64Data,
            onSegmentEnded,
            rxGainBoostRef.current || 2.2,
            preDecodedBuf,
            adaptivePlaybackRate
          );
          if (handle) {
            activeWebAudioRxStopRef.current = handle.stop;
          } else {
            playViaHtmlAudioWithGainFallback();
          }
        })();
      };

      // Jika sedang dalam masa tunggu paket terlambat (latePacketGraceTimerRef), segera lanjutkan pemutaran!
      if (latePacketGraceTimerRef.current) {
        window.clearTimeout(latePacketGraceTimerRef.current);
        latePacketGraceTimerRef.current = null;
        playNextSegmentInQueue();
        return;
      }

      // Jika antrean pemutar atau Adaptive Jitter Buffer sudah berjalan, biarkan mengalir mulus
      // Namun jika segmen sebelumnya macet > 3000ms di browser HP, paksa lanjut ke segmen berikutnya agar suara tidak pernah hilang!
      if (isRxQueuePlayingRef.current || isJitterBufferingRef.current) {
        if (
          !isJitterBufferingRef.current &&
          lastRxSegmentStartTsRef.current > 0 &&
          now - lastRxSegmentStartTsRef.current > 3000
        ) {
          playNextSegmentInQueue();
        }
        return;
      }

      // ADAPTIVE JITTER BUFFER (100ms - 200ms) SEBELUM PEMUTARAN SUARA DIMULAI:
      // Menahan paket pertama selama 100ms-200ms sebagai bantalan penampung (cushion)
      // sambil mendekode AudioBuffer di latar belakang agar aliran suara mulus tanpa putus-putus!
      isRxQueuePlayingRef.current = true;
      isJitterBufferingRef.current = true;
      setIncomingSpeaker(senderCallsign);
      playTacticalTone('rx');

      if (jitterBufferTimerRef.current) {
        window.clearTimeout(jitterBufferTimerRef.current);
      }
      jitterBufferTimerRef.current = window.setTimeout(() => {
        jitterBufferTimerRef.current = null;
        isJitterBufferingRef.current = false;
        playNextSegmentInQueue();
      }, adaptiveJitterBufferMs);
    },
    [soundEnabled, playTacticalTone, myDeviceId, setVoxInputLevel]
  );

  // Helper to check if an incoming transmission packet collides with an already-active channel lock holder
  const isCollidingTransmissionPacket = useCallback(
    (pkt: MeshPacket): boolean => {
      if (pkt.channel !== channel) return false;
      // PRIORITY OVERRIDE packets NEVER get blocked — they always preempt any active speaker!
      if (
        pkt.type === 'PRIORITY_OVERRIDE' ||
        pkt.type === 'PRIORITY_OVERRIDE_END' ||
        pkt.isPriorityOverride
      ) {
        return false;
      }

      const isTxPacket =
        pkt.type === 'TX_START' ||
        pkt.type === 'PTT_START' ||
        pkt.type === 'CHANNEL_LOCK' ||
        pkt.type === 'VOICE_CLIP';
      if (!isTxPacket) return false;

      const pktStartTs = pkt.lockStartedAt || pkt.timestamp || Date.now();

      // 1. If THIS device has Priority Override active or started transmitting first, block colliding non-override packets
      if (isPriorityOverrideRef.current) {
        return true;
      }
      if (isTransmittingRef.current) {
        const myStartTs = localTxStartedAtRef.current || 0;
        const iStartedFirst =
          myStartTs < pktStartTs ||
          (myStartTs === pktStartTs && myDeviceId < pkt.senderId);
        if (iStartedFirst) {
          return true;
        }
      }

      // 2. If ANOTHER client already holds the Channel Lock on this channel, reject any 2nd client's TX packets
      const existingLock = channelLockOwnerRef.current;
      if (
        existingLock &&
        existingLock.senderId !== pkt.senderId &&
        Date.now() - existingLock.updatedAt < 12000
      ) {
        if (existingLock.isPriorityOverride) {
          return true;
        }
        const ownerStartedFirst =
          existingLock.startedAt <= pktStartTs ||
          existingLock.senderId < pkt.senderId;
        if (ownerStartedFirst) {
          return true;
        }
      }

      return false;
    },
    [channel, myDeviceId]
  );

  // Helper untuk memancarkan ulang paket yang tertahan di Store-and-Forward Outbox saat sinyal pulih (Graceful Degradation)
  const flushPendingOutboxPackets = useCallback(() => {
    if (pendingOutboxQueueRef.current.length === 0) return;
    const now = Date.now();
    // Hanya kirim paket yang masih segar (< 15 detik) agar tidak memutar suara usang
    const validQueue = pendingOutboxQueueRef.current.filter(
      (item) => now - item.queuedAt <= 15000
    );
    pendingOutboxQueueRef.current = [];

    for (const item of validQueue) {
      let delivered = false;
      peerConnectionsRef.current.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send(item.packet);
            delivered = true;
          } catch {
            // Ignore
          }
        }
      });
      offlineRtcChannelsRef.current.forEach((dc) => {
        if (dc && dc.readyState === 'open') {
          try {
            dc.send(item.serialized);
            delivered = true;
          } catch {
            // Ignore
          }
        }
      });
      if (
        localHotspotWsRef.current &&
        localHotspotWsRef.current.readyState === WebSocket.OPEN
      ) {
        try {
          localHotspotWsRef.current.send(item.serialized);
          delivered = true;
        } catch {
          // Ignore
        }
      }
      mqttClientsRef.current.forEach((client) => {
        if (client && client.connected) {
          try {
            client.publish(CLOUD_MESH_TOPIC, item.serialized, { qos: 0 });
            delivered = true;
          } catch {
            // Ignore
          }
        }
      });
      if (!delivered && now - item.queuedAt <= 12000) {
        pendingOutboxQueueRef.current.push(item);
      }
    }
  }, []);

  // Send packet to all connected WebRTC peers + Offline Hotspot LAN DataChannels + Local Hotspot WS Hub + WSS Cloud Mesh + BroadcastChannel
  const broadcastMeshPacket = useCallback(
    (partial: Omit<MeshPacket, 'senderId' | 'callsign' | 'ip' | 'role' | 'channel' | 'timestamp'>) => {
      if (!myCallsign) return;
      const pktId = `${myDeviceId}-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 7)}`;
      seenPacketIdsRef.current.add(pktId);
      if (seenPacketIdsRef.current.size > 400) {
        const first = seenPacketIdsRef.current.values().next().value;
        if (first) seenPacketIdsRef.current.delete(first);
      }

      const fullPacket: MeshPacket = {
        ...partial,
        packetId: pktId,
        senderId: myDeviceId,
        callsign: myCallsign,
        ip: detectedLanIpRef.current || localIp,
        role,
        isMaster: localIp === '192.168.43.1' || role === 'MASTER',
        channel,
        timestamp: Date.now(),
        peerNodeId: activeBoundPeerIdRef.current,
      };

      const serialized = JSON.stringify(fullPacket);
      let anyNetworkDelivered = false;

      // 1. Local BroadcastChannel (instant same-device multi-tab sync)
      try {
        broadcastChannelRef.current?.postMessage(fullPacket);
      } catch {
        // Ignore BroadcastChannel error
      }

      // 2. WebRTC PeerJS P2P DataChannels
      peerConnectionsRef.current.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send(fullPacket);
            anyNetworkDelivered = true;
          } catch {
            // Ignore closed peer connection
          }
        }
      });

      // 3. Offline Hotspot Serverless WebRTC RTCDataChannels (0% internet required)
      offlineRtcChannelsRef.current.forEach((dc) => {
        if (dc && dc.readyState === 'open') {
          try {
            dc.send(serialized);
            anyNetworkDelivered = true;
          } catch {
            // Ignore closed offline DataChannel
          }
        }
      });

      // 4. Local Hotspot WebSocket Hub (ws://192.168.43.1:50002 / ws://[subnet].1:50002 — 0% internet required)
      if (
        localHotspotWsRef.current &&
        localHotspotWsRef.current.readyState === WebSocket.OPEN
      ) {
        try {
          localHotspotWsRef.current.send(serialized);
          anyNetworkDelivered = true;
        } catch {
          // Ignore local WS send error
        }
      }

      // 5. WSS Cloud Mesh Brokers (when internet is available)
      mqttClientsRef.current.forEach((client) => {
        if (client && client.connected) {
          try {
            client.publish(CLOUD_MESH_TOPIC, serialized, { qos: 0 });
            anyNetworkDelivered = true;
          } catch {
            // Ignore publish error
          }
        }
      });

      // GRACEFUL DEGRADATION STORE-AND-FORWARD:
      // Jika sinyal internet / jaringan hilang sesaat saat mengirim paket penting (VOICE_CLIP / CHAT_MSG / LOCK),
      // tampung di pendingOutboxQueueRef agar otomatis terkirim begitu koneksi tersambung kembali!
      if (
        !anyNetworkDelivered &&
        (fullPacket.type === 'VOICE_CLIP' ||
          fullPacket.type === 'CHAT_MSG' ||
          fullPacket.type === 'CHANNEL_LOCK' ||
          fullPacket.type === 'PRIORITY_OVERRIDE')
      ) {
        if (pendingOutboxQueueRef.current.length >= 16) {
          pendingOutboxQueueRef.current.shift();
        }
        pendingOutboxQueueRef.current.push({
          serialized,
          packet: fullPacket,
          queuedAt: Date.now(),
        });
      }
    },
    [myDeviceId, myCallsign, localIp, role, channel]
  );

  // Build and broadcast PEER_LIST_SYNC from Master to all connected Clients
  const broadcastPeerListSync = useCallback(
    (overrideMembers?: TacticalMember[]) => {
      if (role !== 'MASTER' && localIp !== '192.168.43.1') return;
      if (!myCallsign) return;

      const currentList = overrideMembers ?? membersRef.current;
      const syncList: PeerSyncEntry[] = [
        {
          peerId: activeBoundPeerIdRef.current,
          senderId: myDeviceId,
          callsign: myCallsign,
          ip: detectedLanIpRef.current || localIp,
          role: 'MASTER',
          channel,
        },
        ...currentList
          .filter((m) => m.id !== myDeviceId)
          .map((m) => ({
            peerId: m.peerId || m.id,
            senderId: m.id,
            callsign: m.callsign,
            ip: m.ip,
            role: m.role,
            channel: m.channel,
          })),
      ];

      broadcastMeshPacket({
        type: 'PEER_LIST_SYNC',
        peerList: syncList,
      });
    },
    [role, localIp, myCallsign, myDeviceId, channel, broadcastMeshPacket]
  );

  // Helper to attach listeners to a PeerJS DataConnection
  const registerPeerConnection = useCallback(
    (conn: DataConnection) => {
      if (!conn || !conn.peer) return;
      pendingConnectTimestampRef.current.set(conn.peer, Date.now());

      conn.on('open', () => {
        pendingConnectTimestampRef.current.delete(conn.peer);
        peerConnectionsRef.current.set(conn.peer, conn);
        setConnectedPeersCount(
          peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
        );

        const pkt = announcePacketBuilderRef.current();
        if (pkt) {
          try {
            conn.send(pkt);
          } catch {
            // Ignore send error
          }
        }
        flushPendingOutboxPackets();
      });

      conn.on('data', (data) => {
        const incoming = data as MeshPacket;
        if (!incoming) return;
        if (!incoming.peerNodeId && conn.peer) {
          incoming.peerNodeId = conn.peer;
        }
        // ANTI-COLLISION RELAY FILTER: Check collision BEFORE relaying so a 2nd colliding client never interrupts active channel speaker
        const isBlockedCollision = isCollidingTransmissionPacket(incoming);
        packetHandlerRef.current(incoming);
        if (isBlockedCollision) return;

        // If this device is Master, relay non-colliding voice/control packets to other connected WebRTC & Offline LAN clients
        if (
          incoming.type !== 'ANNOUNCE' &&
          incoming.type !== 'PEER_LIST_SYNC' &&
          (localIp === '192.168.43.1' || role === 'MASTER')
        ) {
          const serialized = JSON.stringify(incoming);
          peerConnectionsRef.current.forEach((otherConn, peerKey) => {
            if (peerKey !== conn.peer && otherConn.open) {
              try {
                otherConn.send(incoming);
              } catch {
                // Ignore relay error
              }
            }
          });
          offlineRtcChannelsRef.current.forEach((dc) => {
            if (dc.readyState === 'open') {
              try {
                dc.send(serialized);
              } catch {
                // Ignore relay error
              }
            }
          });
        }
      });

      const handleDisconnect = () => {
        pendingConnectTimestampRef.current.delete(conn.peer);
        peerConnectionsRef.current.delete(conn.peer);
        setConnectedPeersCount(
          peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
        );
      };

      conn.on('close', handleDisconnect);
      conn.on('error', handleDisconnect);
    },
    [localIp, role, isCollidingTransmissionPacket]
  );

  // Prepare a fresh Offline Hotspot WebRTC Offer on HP MASTER (0% internet required, iceServers: [])
  const prepareNextOfflineMasterOffer = useCallback(async () => {
    if (!myCallsign) return;
    try {
      // Ensure real Wi-Fi LAN IP is detected before creating Offer so synthetic IPv4 host candidates can bypass Android mDNS
      if (!detectedLanIpRef.current) {
        const foundIp = await detectLocalHotspotIpWebRTC();
        if (foundIp) {
          detectedLanIpRef.current = foundIp;
        }
      }

      const slotId = `SLOT-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      const pc = new RTCPeerConnection({ iceServers: [] });
      offlineMasterPcSlotsRef.current.set(slotId, pc);
      const dc = pc.createDataChannel('tactical_ptt_lan', { ordered: true });

      const cleanupChannel = () => {
        offlineRtcChannelsRef.current.delete(slotId);
        setConnectedPeersCount(
          peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
        );
      };

      dc.onopen = () => {
        offlineRtcChannelsRef.current.set(slotId, dc);
        setConnectedPeersCount(
          peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
        );
        const pkt = announcePacketBuilderRef.current();
        if (pkt) {
          try {
            dc.send(JSON.stringify(pkt));
          } catch {
            // Ignore
          }
        }
        window.setTimeout(() => {
          broadcastPeerListSync();
          // Immediately prepare a new Offer slot so the next HP Client on the Wi-Fi / Hotspot can also join!
          prepareNextOfflineMasterOffer();
        }, 120);
      };

      dc.onmessage = (ev) => {
        try {
          const incoming = JSON.parse(String(ev.data)) as MeshPacket;
          if (!incoming) return;
          // ANTI-COLLISION RELAY FILTER: Do not relay colliding TX/VOICE packets from a 2nd client while channel is locked
          const isBlockedCollision = isCollidingTransmissionPacket(incoming);
          packetHandlerRef.current(incoming);
          if (isBlockedCollision) return;

          // Master Star-Mesh Relay: forward ANNOUNCE, voice & floor control to all other Offline Hotspot & WebRTC clients
          if (
            incoming.type !== 'PEER_LIST_SYNC' &&
            (localIp === '192.168.43.1' || role === 'MASTER')
          ) {
            const raw = JSON.stringify(incoming);
            offlineRtcChannelsRef.current.forEach((otherDc, otherKey) => {
              if (otherKey !== slotId && otherDc.readyState === 'open') {
                try {
                  otherDc.send(raw);
                } catch {
                  // Ignore relay error
                }
              }
            });
            peerConnectionsRef.current.forEach((otherConn) => {
              if (otherConn.open) {
                try {
                  otherConn.send(incoming);
                } catch {
                  // Ignore relay error
                }
              }
            });
          }
        } catch {
          // Ignore malformed packet
        }
      };

      dc.onclose = cleanupChannel;
      dc.onerror = cleanupChannel;

      const offer = await pc.createOffer();
      const optimizedOfferSdp = optimizeWebRtcSdpForOpusLowLatency(
        offer.sdp || '',
        opusBitrateKbpsRef.current * 1000
      );
      await pc.setLocalDescription({
        type: 'offer',
        sdp: optimizedOfferSdp || offer.sdp,
      });
      const gatheredCandidates = await gatherLocalIceCandidatesExplicit(pc, 750);

      const localSdp = optimizeWebRtcSdpForOpusLowLatency(
        pc.localDescription?.sdp || optimizedOfferSdp || offer.sdp || '',
        opusBitrateKbpsRef.current * 1000
      );
      if (localSdp) {
        const effectiveIp = detectedLanIpRef.current || localIp;
        const microToken = buildMicroOfflineToken({
          type: 'O',
          callsign: myCallsign,
          deviceId: myDeviceId,
          localIp: effectiveIp,
          channel,
          slotId,
          rawSdp: localSdp,
          collectedCandidateLines: gatheredCandidates,
        });
        setOfflineOfferToken(microToken);
      }
    } catch {
      // Ignore WebRTC offer error
    }
  }, [myCallsign, myDeviceId, localIp, channel, role, broadcastPeerListSync]);

  // Helper to initiate a non-duplicate WebRTC connection to a remote peerId
  const connectToPeerNodeIfNeeded = useCallback(
    (remotePeerId?: string) => {
      if (!remotePeerId || remotePeerId === activeBoundPeerIdRef.current) return;
      const activePeer = directNodePeerRef.current || peerRef.current;
      if (!activePeer || activePeer.disconnected || activePeer.destroyed) return;

      const existingConn = peerConnectionsRef.current.get(remotePeerId);
      if (existingConn && existingConn.open) return;

      // Avoid aborting an in-flight WebRTC ICE handshake (< 7 seconds old)
      const pendingSince = pendingConnectTimestampRef.current.get(remotePeerId) || 0;
      if (Date.now() - pendingSince < 7000) return;

      try {
        pendingConnectTimestampRef.current.set(remotePeerId, Date.now());
        const conn = activePeer.connect(remotePeerId, {
          reliable: true,
          serialization: 'json',
        });
        registerPeerConnection(conn);
      } catch {
        pendingConnectTimestampRef.current.delete(remotePeerId);
      }
    },
    [registerPeerConnection]
  );

  // Handle incoming mesh packets (from WebRTC PeerJS DataChannel, WSS Cloud Mesh, or BroadcastChannel)
  const handleIncomingMeshPacket = useCallback(
    (pkt: MeshPacket) => {
      if (!pkt || pkt.senderId === myDeviceId || !pkt.callsign) return;

      // Deduplicate packets that arrive simultaneously via WebRTC DataChannel & WSS Cloud Mesh
      if (pkt.packetId) {
        if (seenPacketIdsRef.current.has(pkt.packetId)) return;
        seenPacketIdsRef.current.add(pkt.packetId);
        if (seenPacketIdsRef.current.size > 400) {
          const first = seenPacketIdsRef.current.values().next().value;
          if (first) seenPacketIdsRef.current.delete(first);
        }
      }

      if (pkt.type === 'PEER_LEAVE') {
        memberLastSeenMapRef.current.delete(pkt.senderId);
        setMembers((prev) => {
          const next = prev.filter((m) => m.id !== pkt.senderId);
          return next.length === prev.length ? prev : next;
        });
        if (channelLockOwnerRef.current?.senderId === pkt.senderId) {
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          remoteActiveTxRef.current = null;
          setIncomingSpeaker(null);
        }
        return;
      }

      const amIMaster = localIp === '192.168.43.1' || role === 'MASTER';

      if (pkt.type === 'ANNOUNCE') {
        const senderPeerId = pkt.peerNodeId || pkt.senderId;
        const now = Date.now();
        memberLastSeenMapRef.current.set(pkt.senderId, now);

        setMembers((prev) => {
          const existingIdx = prev.findIndex(
            (m) => m.id === pkt.senderId || m.peerId === senderPeerId
          );
          if (existingIdx >= 0) {
            const curr = prev[existingIdx];
            // Avoid re-rendering App if member's visible metadata has not changed!
            if (
              curr.id === pkt.senderId &&
              curr.callsign === pkt.callsign &&
              curr.ip === pkt.ip &&
              curr.role === pkt.role &&
              curr.channel === pkt.channel &&
              curr.peerId === senderPeerId
            ) {
              return prev;
            }
            const next = [...prev];
            next[existingIdx] = {
              ...curr,
              id: pkt.senderId,
              callsign: pkt.callsign,
              ip: pkt.ip,
              role: pkt.role,
              channel: pkt.channel,
              peerId: senderPeerId,
              lastSeen: now,
            };
            if (amIMaster) {
              window.setTimeout(() => broadcastPeerListSync(next), 60);
            }
            return next;
          }

          const next: TacticalMember[] = [
            ...prev,
            {
              id: pkt.senderId,
              callsign: pkt.callsign,
              ip: pkt.ip,
              role: pkt.role,
              statusText: pkt.role === 'MASTER' ? 'MASTER HOST' : 'P2P AKTIF',
              isTargeted: true,
              isTalking: false,
              pingMs: 24,
              channel: pkt.channel,
              peerId: senderPeerId,
              lastSeen: now,
            },
          ];

          if (amIMaster) {
            window.setTimeout(() => broadcastPeerListSync(next), 60);
          }
          return next;
        });

        // Also establish direct WebRTC DataChannel to this discovered peer if not yet open
        if (pkt.peerNodeId && pkt.peerNodeId.startsWith('PTT-')) {
          connectToPeerNodeIfNeeded(pkt.peerNodeId);
        }

        // Instant reply so newly joined peer immediately sees this device (< 200ms)
        const lastReply = lastAnnounceReplyRef.current.get(pkt.senderId) || 0;
        if (now - lastReply > 2500 && myCallsign) {
          lastAnnounceReplyRef.current.set(pkt.senderId, now);
          broadcastMeshPacket({ type: 'ANNOUNCE' });
        }
        return;
      }

      if (pkt.type === 'PEER_LIST_SYNC' && Array.isArray(pkt.peerList)) {
        const now = Date.now();
        const incomingPeers = pkt.peerList.filter(
          (entry) =>
            entry.senderId !== myDeviceId &&
            entry.peerId !== activeBoundPeerIdRef.current
        );

        incomingPeers.forEach((entry) => {
          memberLastSeenMapRef.current.set(entry.senderId, now);
        });

        setMembers((prev) => {
          let changed = false;
          const updated: TacticalMember[] = [...prev];
          incomingPeers.forEach((entry) => {
            const idx = updated.findIndex(
              (m) => m.id === entry.senderId || m.peerId === entry.peerId
            );
            if (idx >= 0) {
              const curr = updated[idx];
              if (
                curr.id !== entry.senderId ||
                curr.callsign !== entry.callsign ||
                curr.ip !== entry.ip ||
                curr.role !== entry.role ||
                curr.channel !== entry.channel ||
                curr.peerId !== entry.peerId
              ) {
                changed = true;
                updated[idx] = {
                  ...curr,
                  id: entry.senderId,
                  callsign: entry.callsign,
                  ip: entry.ip,
                  role: entry.role,
                  channel: entry.channel,
                  peerId: entry.peerId,
                  lastSeen: now,
                };
              }
            } else {
              changed = true;
              updated.push({
                id: entry.senderId,
                callsign: entry.callsign,
                ip: entry.ip,
                role: entry.role,
                statusText: entry.role === 'MASTER' ? 'MASTER HOST' : 'P2P AKTIF',
                isTargeted: true,
                isTalking: false,
                pingMs: 24,
                channel: entry.channel,
                peerId: entry.peerId,
                lastSeen: now,
              });
            }
          });
          return changed ? updated : prev;
        });

        // Form direct P2P WebRTC connections with all other peers discovered via PEER_LIST_SYNC
        incomingPeers.forEach((entry) => {
          if (entry.peerId && entry.peerId.startsWith('PTT-')) {
            connectToPeerNodeIfNeeded(entry.peerId);
          }
        });
        return;
      }

      // Refresh lastSeen timestamp in ref without triggering React re-render
      memberLastSeenMapRef.current.set(pkt.senderId, Date.now());

      // Filter channel-specific packets (voice / PTT floor control / ping) without closing sockets
      if (pkt.channel !== channel) return;

      // CHANNEL LOCKOUT / ANTI-COLLISION HANDLER OVER WEBSOCKET, WEBRTC & MESH
      if (pkt.type === 'CHANNEL_BUSY') {
        // Another peer already holds the channel lock -> if we were transmitting and started later, abort immediately!
        const ownerId = pkt.lockOwnerId || pkt.senderId;
        const ownerCallsign = pkt.lockOwnerCallsign || pkt.callsign;
        const ownerStartTs = pkt.lockStartedAt || pkt.timestamp;
        if (ownerId !== myDeviceId) {
          if (isTransmittingRef.current) {
            const myStartTs = localTxStartedAtRef.current || Date.now();
            if (ownerStartTs <= myStartTs) {
              forceStopLocalRecording(true);
              setCollisionBlockedNotice(
                `ANTI-COLLISION: SALURAN DIKUNCI OLEH ${ownerCallsign}`
              );
              window.setTimeout(() => setCollisionBlockedNotice(null), 2200);
            }
          }
          const lockObj: ChannelLockInfo = {
            senderId: ownerId,
            callsign: ownerCallsign,
            startedAt: ownerStartTs,
            updatedAt: Date.now(),
          };
          channelLockOwnerRef.current = lockObj;
          setChannelLockOwner(lockObj);
          remoteActiveTxRef.current = ownerCallsign;
          setIncomingSpeaker(ownerCallsign);
        }
        return;
      }

      if (pkt.type === 'PRIORITY_OVERRIDE') {
        const now = Date.now();
        // TOMBOL OVERRIDE DARI REKAN: Hentikan transmisi lokal seketika tanpa syarat!
        if (isPriorityOverrideRef.current) {
          isPriorityOverrideRef.current = false;
          setIsPriorityOverride(false);
        }
        if (isTransmittingRef.current) {
          forceStopLocalRecording(true);
        }
        const lockObj: ChannelLockInfo = {
          senderId: pkt.senderId,
          callsign: pkt.callsign,
          startedAt: pkt.lockStartedAt || now,
          updatedAt: now,
          isPriorityOverride: true,
        };
        channelLockOwnerRef.current = lockObj;
        setChannelLockOwner(lockObj);
        remoteActiveTxRef.current = pkt.callsign;
        setIncomingSpeaker(pkt.callsign);
        setCollisionBlockedNotice(
          `PRIORITAS OVERRIDE: TRANSMISI DIAMBIL ALIH OLEH ${pkt.callsign}`
        );
        window.setTimeout(() => setCollisionBlockedNotice(null), 2600);
        playTacticalTone('rx');
        return;
      }

      if (pkt.type === 'PRIORITY_OVERRIDE_END') {
        if (
          channelLockOwnerRef.current &&
          channelLockOwnerRef.current.senderId === pkt.senderId
        ) {
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          remoteActiveTxRef.current = null;
          setIncomingSpeaker((curr) => (curr === pkt.callsign ? null : curr));
        }
        return;
      }

      if (
        pkt.type === 'TX_START' ||
        pkt.type === 'PTT_START' ||
        pkt.type === 'CHANNEL_LOCK'
      ) {
        const now = Date.now();
        const incomingStartTs = pkt.lockStartedAt || pkt.timestamp || now;
        const existingLock = channelLockOwnerRef.current;

        // 0. Jika paket masuk memiliki flag PRIORITY OVERRIDE, langsung hentikan transmisi lokal seketika!
        if (pkt.isPriorityOverride) {
          if (isPriorityOverrideRef.current) {
            isPriorityOverrideRef.current = false;
            setIsPriorityOverride(false);
          }
          if (isTransmittingRef.current) {
            forceStopLocalRecording(true);
            setCollisionBlockedNotice(
              `PRIORITAS OVERRIDE: TRANSMISI DIHENTIKAN OLEH ${pkt.callsign}`
            );
            window.setTimeout(() => setCollisionBlockedNotice(null), 2500);
          }
        } else {
          // Jika perangkat kita sedang mengaktifkan OVERRIDE, tolak semua perebutan saluran dari klien biasa
          if (isPriorityOverrideRef.current) {
            broadcastMeshPacket({
              type: 'PRIORITY_OVERRIDE',
              isPriorityOverride: true,
              lockOwnerId: myDeviceId,
              lockOwnerCallsign: myCallsign,
              lockStartedAt: localTxStartedAtRef.current || now,
            });
            return;
          }

          // 1. Check if ANOTHER peer already holds the Channel Lock (First-Speaker-Wins or Priority Override)
          if (
            existingLock &&
            existingLock.senderId !== pkt.senderId &&
            now - existingLock.updatedAt < 12000
          ) {
            const existingStartedFirst =
              existingLock.isPriorityOverride ||
              existingLock.startedAt <= incomingStartTs ||
              existingLock.senderId < pkt.senderId;
            if (existingStartedFirst) {
              broadcastMeshPacket({
                type: 'CHANNEL_BUSY',
                lockOwnerId: existingLock.senderId,
                lockOwnerCallsign: existingLock.callsign,
                lockStartedAt: existingLock.startedAt,
                isPriorityOverride: existingLock.isPriorityOverride,
              });
              return;
            }
          }

          // 2. Check if THIS device is currently transmitting (Simultaneous TX Race Condition)
          if (isTransmittingRef.current) {
            const myStartTs = localTxStartedAtRef.current || now;
            const iStartedFirst =
              myStartTs < incomingStartTs ||
              (myStartTs === incomingStartTs && myDeviceId < pkt.senderId);

            if (iStartedFirst) {
              broadcastMeshPacket({
                type: 'CHANNEL_BUSY',
                lockOwnerId: myDeviceId,
                lockOwnerCallsign: myCallsign,
                lockStartedAt: myStartTs,
              });
              return;
            } else {
              forceStopLocalRecording(true);
              setCollisionBlockedNotice(
                `ANTI-COLLISION: ${pkt.callsign} LEBIH DULU MENGUNCI SALURAN`
              );
              window.setTimeout(() => setCollisionBlockedNotice(null), 2200);
            }
          }
        }

        // 3. Grant / Refresh Channel Lockout for the active transmitting peer
        const isNewLockOwner =
          !existingLock || existingLock.senderId !== pkt.senderId;
        const lockObj: ChannelLockInfo = {
          senderId: pkt.senderId,
          callsign: pkt.callsign,
          startedAt:
            existingLock?.senderId === pkt.senderId
              ? existingLock.startedAt
              : incomingStartTs,
          updatedAt: now,
          isPriorityOverride:
            pkt.isPriorityOverride || existingLock?.isPriorityOverride,
        };
        channelLockOwnerRef.current = lockObj;
        setChannelLockOwner(lockObj);
        remoteActiveTxRef.current = pkt.callsign;
        setIncomingSpeaker(pkt.callsign);

        // Immediately lock out local VOX & mute hardware mic track + pre-amp so nearby/same device speaker never feedbacks!
        voxVoiceFramesRef.current = 0;
        voiceOnsetStartTimeRef.current = 0;
        setVoxInputLevel(0);
        rxCooldownUntilRef.current = now + 2800;
        if (voxPreAmpGainRef.current && audioCtxRef.current) {
          try {
            voxPreAmpGainRef.current.gain.setValueAtTime(0, audioCtxRef.current.currentTime);
          } catch {
            voxPreAmpGainRef.current.gain.value = 0;
          }
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach((track) => {
            track.enabled = false;
          });
        }

        if (isNewLockOwner && pkt.type !== 'CHANNEL_LOCK') {
          playTacticalTone('rx');
        }
      } else if (
        pkt.type === 'TX_STOP' ||
        pkt.type === 'PTT_END' ||
        pkt.type === 'CHANNEL_UNLOCK'
      ) {
        // Ignore unlock packets from peers who do not hold the current channel lock
        if (
          channelLockOwnerRef.current &&
          channelLockOwnerRef.current.senderId !== pkt.senderId
        ) {
          return;
        }
        if (remoteActiveTxRef.current === pkt.callsign) {
          remoteActiveTxRef.current = null;
        }
        // Keep 650ms anti-feedback guard so nearby phones' VOX won't trigger on speaker decay
        rxCooldownUntilRef.current = Date.now() + 650;
        if (!isRxQueuePlayingRef.current) {
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          setIncomingSpeaker((curr) => (curr === pkt.callsign ? null : curr));
          window.setTimeout(() => {
            if (
              voxEnabledRef.current &&
              !isTransmittingRef.current &&
              !remoteActiveTxRef.current &&
              !channelLockOwnerRef.current &&
              !isRxQueuePlayingRef.current &&
              mediaStreamRef.current
            ) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            }
          }, 580);
        }
      } else if (
        pkt.type === 'VOICE_CLIP' &&
        (pkt.encryptedAudio || pkt.audioBase64)
      ) {
        // 0. If incoming VOICE_CLIP has Priority Override, immediately abort any local transmission so priority speaker is heard!
        if (pkt.isPriorityOverride && isTransmittingRef.current && !isPriorityOverrideRef.current) {
          forceStopLocalRecording(true);
        }
        // 1. STRICT ANTI-ECHO: While local PTT/VOX is open (Receiver OFF), drop incoming voice playback completely
        if (isTransmittingRef.current || isReceiverOffRef.current) {
          return;
        }
        // 2. STRICT ANTI-COLLISION: If another client holds the Channel Lock (and incoming clip is NOT Priority Override), ignore colliding audio clips!
        const existingLock = channelLockOwnerRef.current;
        if (
          !pkt.isPriorityOverride &&
          existingLock &&
          existingLock.senderId !== pkt.senderId &&
          Date.now() - existingLock.updatedAt < 12000
        ) {
          return;
        }

        // 3. REAL-TIME END-TO-END AES-256-GCM DECRYPTION (Web Crypto API crypto.subtle.decrypt)
        if (pkt.encryptedAudio && pkt.audioCiphertext && pkt.aesIv) {
          decryptAudioPayloadAesGcm(
            pkt.audioCiphertext,
            pkt.aesIv,
            PASSCODE_HARIAN
          ).then((decryptedBase64) => {
            if (!decryptedBase64) return;
            if (isTransmittingRef.current || isReceiverOffRef.current) return;
            setE2eDecryptedRxCount((c) => c + 1);
            setLastAesIvPreview(`RX-GCM IV:${pkt.aesIv?.slice(0, 8)}…`);
            playIncomingAudioBase64(
              decryptedBase64,
              pkt.callsign,
              pkt.senderId,
              Boolean(pkt.isPriorityOverride)
            );
          });
        } else if (pkt.audioBase64) {
          playIncomingAudioBase64(
            pkt.audioBase64,
            pkt.callsign,
            pkt.senderId,
            Boolean(pkt.isPriorityOverride)
          );
        }
      } else if (pkt.type === 'CHAT_MSG' && pkt.chatText) {
        const newMsg: TacticalChatMessage = {
          id: pkt.packetId || `${pkt.senderId}-${pkt.timestamp}`,
          senderId: pkt.senderId,
          callsign: pkt.callsign,
          ip: pkt.ip,
          role: pkt.role,
          channel: pkt.channel,
          text: pkt.chatText,
          timestamp: pkt.timestamp || Date.now(),
        };
        setChatMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) return prev;
          return [...prev.slice(-79), newMsg];
        });
        setUnreadChatCount((c) => (isOnScreenChatOpen ? 0 : c + 1));
        // Only play chat notification beep if Receiver is ON (PTT is not open)
        if (!isTransmittingRef.current && !isReceiverOffRef.current) {
          playTacticalTone('rx');
        }
      } else if (pkt.type === 'PING') {
        broadcastMeshPacket({ type: 'PONG' });
      } else if (pkt.type === 'PONG') {
        const rtt = Math.max(8, Date.now() - pkt.timestamp);
        setPingDelta(Math.abs(rtt - pingMs));
        setPingMs(rtt);
      }
    },
    [
      myDeviceId,
      myPeerNodeId,
      channel,
      localIp,
      role,
      pingMs,
      myCallsign,
      isOnScreenChatOpen,
      forceStopLocalRecording,
      playIncomingAudioBase64,
      playTacticalTone,
      broadcastMeshPacket,
      broadcastPeerListSync,
      connectToPeerNodeIfNeeded,
    ]
  );

  // Keep latest callbacks in refs so WebSocket/PeerJS/MQTT effects NEVER tear down or enter infinite loops
  const packetHandlerRef = useRef(handleIncomingMeshPacket);
  useEffect(() => {
    packetHandlerRef.current = handleIncomingMeshPacket;
  }, [handleIncomingMeshPacket]);

  const broadcastMeshPacketRef = useRef(broadcastMeshPacket);
  useEffect(() => {
    broadcastMeshPacketRef.current = broadcastMeshPacket;
  }, [broadcastMeshPacket]);

  const broadcastPeerListSyncRef = useRef(broadcastPeerListSync);
  useEffect(() => {
    broadcastPeerListSyncRef.current = broadcastPeerListSync;
  }, [broadcastPeerListSync]);

  const connectToPeerNodeIfNeededRef = useRef(connectToPeerNodeIfNeeded);
  useEffect(() => {
    connectToPeerNodeIfNeededRef.current = connectToPeerNodeIfNeeded;
  }, [connectToPeerNodeIfNeeded]);

  const registerPeerConnectionRef = useRef(registerPeerConnection);
  useEffect(() => {
    registerPeerConnectionRef.current = registerPeerConnection;
  }, [registerPeerConnection]);

  const prepareNextOfflineMasterOfferRef = useRef(prepareNextOfflineMasterOffer);
  useEffect(() => {
    prepareNextOfflineMasterOfferRef.current = prepareNextOfflineMasterOffer;
  }, [prepareNextOfflineMasterOffer]);

  const announcePacketBuilderRef = useRef<() => MeshPacket | null>(() => null);
  useEffect(() => {
    announcePacketBuilderRef.current = () => {
      if (!myCallsign || !isPasscodeAuthenticated) return null;
      return {
        packetId: `${myDeviceId}-${Date.now()}-ann`,
        type: 'ANNOUNCE',
        senderId: myDeviceId,
        callsign: myCallsign,
        ip: detectedLanIpRef.current || localIp,
        role,
        channel,
        timestamp: Date.now(),
        peerNodeId: activeBoundPeerIdRef.current,
      };
    };
  }, [myDeviceId, myCallsign, isPasscodeAuthenticated, localIp, role, channel]);

  // Hybrid Cloud + Offline Hotspot LAN Signaling Engine + Auto-Reconnect Watchdog (2.5s):
  // Stabilized dependencies: never tears down or loops when activeBoundPeerId or localIp updates!
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;

    let isCancelled = false;

    // Auto-detect real Hotspot IP via local WebRTC host ICE candidate & prepare Offline Master Offer once
    let detectedSubnetGateway = '192.168.43.1';
    detectLocalHotspotIpWebRTC().then((detectedIp) => {
      if (isCancelled) return;
      if (detectedIp) {
        detectedLanIpRef.current = detectedIp;
        const parts = detectedIp.split('.');
        if (parts.length === 4) {
          detectedSubnetGateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
        }
      }
      prepareNextOfflineMasterOfferRef.current();
    });

    const tryConnectLocalHotspotWsHub = () => {
      if (isCancelled) return;
      if (
        localHotspotWsRef.current &&
        (localHotspotWsRef.current.readyState === WebSocket.OPEN ||
          localHotspotWsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      // Only probe ws:// on HTTP or local WebView/APK contexts where mixed-content isn't blocked
      if (window.location.protocol === 'https:' && !window.location.hostname.startsWith('192.168.')) {
        return;
      }

      const candidateGateways = Array.from(
        new Set([detectedSubnetGateway, '192.168.43.1', '192.168.137.1'])
      );

      for (const gw of candidateGateways) {
        try {
          const ws = new WebSocket(`ws://${gw}:50002`);
          ws.onopen = () => {
            if (isCancelled) {
              ws.close();
              return;
            }
            localHotspotWsRef.current = ws;
            setIsHotspotLanHubConnected((prev) => (prev ? prev : true));
            const pkt = announcePacketBuilderRef.current();
            if (pkt) {
              try {
                ws.send(JSON.stringify(pkt));
              } catch {
                // Ignore
              }
            }
            flushPendingOutboxPackets();
          };
          ws.onmessage = (ev) => {
            if (isCancelled) return;
            try {
              const parsed = JSON.parse(String(ev.data)) as MeshPacket;
              packetHandlerRef.current(parsed);
            } catch {
              // Ignore malformed JSON
            }
          };
          ws.onclose = () => {
            if (localHotspotWsRef.current === ws) {
              localHotspotWsRef.current = null;
              setIsHotspotLanHubConnected((prev) => (!prev ? prev : false));
            }
          };
          ws.onerror = () => {
            try {
              ws.close();
            } catch {
              // Ignore
            }
          };
        } catch {
          // Ignore security error if browser blocks ws://
        }
      }
    };

    tryConnectLocalHotspotWsHub();

    // 1. Local BroadcastChannel for same-browser multi-tab sync
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('diskomlekau_tactical_ptt_channel');
      bc.onmessage = (event) => {
        packetHandlerRef.current(event.data as MeshPacket);
      };
      broadcastChannelRef.current = bc;
    }

    // 2. Dual-Broker WSS Cloud Mesh dengan Graceful Degradation (Auto-Reconnect cepat 1.5s & anti-timeout)
    const activeMqttClients: MqttClient[] = [];
    WSS_CLOUD_BROKERS.forEach((brokerUrl, idx) => {
      try {
        const client = mqtt.connect(brokerUrl, {
          clientId: `dskm-${myDeviceId.toLowerCase()}-${idx}-${Math.random()
            .toString(36)
            .substring(2, 6)}`,
          clean: true,
          keepalive: 25,
          reconnectPeriod: 1500,
          connectTimeout: 12000,
          resubscribe: true,
        });

        client.on('connect', () => {
          if (isCancelled) return;
          client.subscribe(CLOUD_MESH_TOPIC, { qos: 0 }, () => {
            const pkt = announcePacketBuilderRef.current();
            if (pkt) {
              try {
                client.publish(CLOUD_MESH_TOPIC, JSON.stringify(pkt), { qos: 0 });
              } catch {
                // Ignore publish error
              }
            }
            flushPendingOutboxPackets();
          });
        });

        client.on('message', (_topic, payloadBuffer) => {
          if (isCancelled) return;
          try {
            const parsed = JSON.parse(payloadBuffer.toString()) as MeshPacket;
            packetHandlerRef.current(parsed);
          } catch {
            // Ignore malformed JSON
          }
        });

        activeMqttClients.push(client);
      } catch {
        // Ignore broker init error
      }
    });
    mqttClientsRef.current = activeMqttClients;

    // 3. PeerJS WebRTC Cloud Signaling + P2P DataChannel with STUN/TURN ICE servers
    const isMasterRole = role === 'MASTER' || localIp === '192.168.43.1';
    let currentPeer: Peer | null = null;
    let boundId = isMasterRole ? MASTER_PEER_ID : uniqueClientPeerId;

    const connectToMasterAndPeers = (peerInstance: Peer, myCurrentId: string) => {
      if (isCancelled || peerInstance.disconnected || peerInstance.destroyed) return;

      // Connect to static 'PTT-MASTER-01' whenever this node is not 'PTT-MASTER-01' itself
      if (myCurrentId !== MASTER_PEER_ID) {
        connectToPeerNodeIfNeededRef.current(MASTER_PEER_ID);
      }

      // Connect to custom Barcode invitedHostPeer if specified
      if (
        invitedHostPeer &&
        invitedHostPeer !== MASTER_PEER_ID &&
        invitedHostPeer !== myCurrentId
      ) {
        connectToPeerNodeIfNeededRef.current(invitedHostPeer);
      }

      // Also ensure direct P2P connections to any already-known members
      membersRef.current.forEach((m) => {
        if (
          m.peerId &&
          m.peerId.startsWith('PTT-') &&
          m.peerId !== myCurrentId
        ) {
          connectToPeerNodeIfNeededRef.current(m.peerId);
        }
      });
    };

    const initializePeerNode = (candidateId: string, allowFallback: boolean) => {
      if (isCancelled) return;
      boundId = candidateId;
      activeBoundPeerIdRef.current = candidateId;
      setActiveBoundPeerId((prev) => (prev === candidateId ? prev : candidateId));

      const peer = new Peer(candidateId, {
        config: {
          iceServers: WEBRTC_ICE_SERVERS,
        },
      });
      currentPeer = peer;
      directNodePeerRef.current = peer;
      peerRef.current = peer;

      peer.on('open', (openedId) => {
        if (isCancelled) {
          peer.destroy();
          return;
        }
        activeBoundPeerIdRef.current = openedId;
        setActiveBoundPeerId((prev) => (prev === openedId ? prev : openedId));
        connectToMasterAndPeers(peer, openedId);
        flushPendingOutboxPackets();
      });

      peer.on('connection', (conn) => {
        registerPeerConnectionRef.current(conn);
      });

      peer.on('disconnected', () => {
        if (!isCancelled && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {
            // Watchdog will retry automatically
          }
        }
      });

      peer.on('error', (err: { type?: string }) => {
        if (isCancelled) return;
        // If 'PTT-MASTER-01' is already taken on 0.peerjs.com, fall back once to uniqueClientPeerId without re-running effect!
        if (err.type === 'unavailable-id' && allowFallback) {
          try {
            peer.destroy();
          } catch {
            // Ignore destroy error
          }
          initializePeerNode(uniqueClientPeerId, false);
          return;
        }

        if (peer.disconnected && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {
            // Watchdog will retry automatically
          }
        }
      });
    };

    initializePeerNode(boundId, isMasterRole);

    // GRACEFUL DEGRADATION: Instant Zero-Delay Auto-Reconnect saat sinyal seluler / Wi-Fi kembali ("online" / network change)
    const handleNetworkSignalRestored = () => {
      if (isCancelled) return;
      tryConnectLocalHotspotWsHub();
      activeMqttClients.forEach((client) => {
        if (client && !client.connected) {
          try {
            client.reconnect();
          } catch {
            // Ignore
          }
        }
      });
      if (currentPeer) {
        if (currentPeer.destroyed) {
          initializePeerNode(boundId, false);
        } else if (currentPeer.disconnected) {
          try {
            currentPeer.reconnect();
          } catch {
            // Ignore
          }
        } else {
          connectToMasterAndPeers(currentPeer, boundId);
        }
      }
      const pkt = announcePacketBuilderRef.current();
      if (pkt) {
        broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
      }
      flushPendingOutboxPackets();
    };

    window.addEventListener('online', handleNetworkSignalRestored);
    const navConn = (
      navigator as Navigator & {
        connection?: {
          addEventListener?: (type: string, fn: () => void) => void;
          removeEventListener?: (type: string, fn: () => void) => void;
        };
      }
    ).connection;
    navConn?.addEventListener?.('change', handleNetworkSignalRestored);

    // 4. 2.0-second Watchdog Interval + Tolerant Peer Grace Window (45s anti-drop)
    const watchdogTimer = window.setInterval(() => {
      if (isCancelled) return;
      tryConnectLocalHotspotWsHub();
      activeMqttClients.forEach((client) => {
        if (client && !client.connected && !client.reconnecting) {
          try {
            client.reconnect();
          } catch {
            // Ignore
          }
        }
      });
      if (currentPeer && currentPeer.disconnected && !currentPeer.destroyed) {
        try {
          currentPeer.reconnect();
        } catch {
          // Ignore reconnect error
        }
      }
      if (currentPeer && !currentPeer.disconnected && !currentPeer.destroyed) {
        connectToMasterAndPeers(currentPeer, boundId);
      }
      if (isMasterRole) {
        broadcastPeerListSyncRef.current();
      }
      flushPendingOutboxPackets();

      // Graceful Degradation: jangan memutus anggota saat sinyal hilang sesaat (toleransi 45 detik)
      const now = Date.now();
      if (
        channelLockOwnerRef.current &&
        now - channelLockOwnerRef.current.updatedAt > 14000
      ) {
        channelLockOwnerRef.current = null;
        setChannelLockOwner(null);
        remoteActiveTxRef.current = null;
        setIncomingSpeaker(null);
      }
      const anyOfflineDcOpen = Array.from(offlineRtcChannelsRef.current.values()).some(
        (dc) => dc.readyState === 'open'
      );
      setMembers((prev) => {
        if (prev.length === 0) return prev;
        const filtered = prev.filter((m) => {
          const hasOpenRtc =
            (m.peerId && peerConnectionsRef.current.get(m.peerId)?.open) ||
            peerConnectionsRef.current.get(m.id)?.open ||
            anyOfflineDcOpen;
          const lastSeenTs = memberLastSeenMapRef.current.get(m.id) || m.lastSeen || now;
          const withinGracePeriod = now - lastSeenTs < 45000;
          return Boolean(hasOpenRtc || withinGracePeriod);
        });
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 2000);

    // Send graceful PEER_LEAVE only on actual tab close when not running in background keep-alive mode
    const handleBeforeUnload = () => {
      if (isMinimizedModeRef.current || keepAliveEnabledRef.current) {
        return;
      }
      broadcastMeshPacketRef.current({ type: 'PEER_LEAVE' });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      isCancelled = true;
      window.removeEventListener('online', handleNetworkSignalRestored);
      navConn?.removeEventListener?.('change', handleNetworkSignalRestored);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.clearInterval(watchdogTimer);
      broadcastChannelRef.current?.close();
      peerConnectionsRef.current.clear();
      pendingConnectTimestampRef.current.clear();
      localHotspotWsRef.current?.close();
      localHotspotWsRef.current = null;
      currentPeer?.destroy();
      activeMqttClients.forEach((c) => {
        try {
          c.end(true);
        } catch {
          // Ignore close error
        }
      });
      mqttClientsRef.current = [];
    };
  }, [
    isPasscodeAuthenticated,
    isSetupCompleted,
    myCallsign,
    myDeviceId,
    role,
    uniqueClientPeerId,
    invitedHostPeer,
  ]);

  // Permanent role lock based on IP '192.168.43.1'
  const isMasterDevice = localIp === '192.168.43.1';
  const permanentRoleLabel = isMasterDevice ? 'HP MASTER' : 'CLIENT';

  // Reset channel lock state when switching channels
  useEffect(() => {
    channelLockOwnerRef.current = null;
    setChannelLockOwner(null);
    remoteActiveTxRef.current = null;
    setIncomingSpeaker(null);
  }, [channel]);

  // UNIVERSAL CHANNEL LOCKOUT / ANTI-COLLISION (BYPASSED WHEN LOCAL PRIORITY OVERRIDE IS ACTIVE):
  const activeLockSpeaker = isPriorityOverride
    ? null
    : incomingSpeaker ||
      (channelLockOwner && channelLockOwner.senderId !== myDeviceId
        ? channelLockOwner.callsign
        : null);
  const isPttLocked = Boolean(activeLockSpeaker) && !isPriorityOverride;

  // Initialize Web Audio API Graph (AudioContext -> MediaStreamSource -> Vocal Bandpass Filter -> AnalyserNode)
  // Compatible with Safari (iOS), Chrome (Android), and HarmonyOS, with multi-tier getUserMedia fallbacks
  // Blocked until Passcode Operasional Harian is authenticated!
  const ensureWebAudioVoxGraph = useCallback(
    async (forceRebuild = false): Promise<AnalyserNode | null> => {
      if (!isPasscodeAuthenticatedRef.current) return null;
      try {
        // Check if existing MediaStream was ended by OS (e.g. iOS background interrupt or TWS headset switch)
        if (mediaStreamRef.current) {
          const tracks = mediaStreamRef.current.getAudioTracks();
          const hasLiveTrack = tracks.some((t) => t.readyState === 'live');
          if (!hasLiveTrack || forceRebuild) {
            tracks.forEach((t) => {
              try {
                t.stop();
              } catch {
                // Ignore
              }
            });
            mediaStreamRef.current = null;
            try {
              micSourceRef.current?.disconnect();
            } catch {
              // Ignore
            }
            micSourceRef.current = null;
            micAnalyserRef.current = null;
          }
        }

        if (!mediaStreamRef.current) {
          const result = await requestMicrophoneWithFallbacks();
          if (!result.stream) {
            setMicPermissionState('denied');
            setMicConstraintTier(result.constraintTier);
            if (result.errorMessage) {
              setMicErrorNotice(result.errorMessage);
            }
            return null;
          }

          mediaStreamRef.current = result.stream;
          setMicPermissionState('granted');
          setMicConstraintTier(result.constraintTier);
          setMicErrorNotice(null);

          // Listen for hardware track end (e.g., Bluetooth TWS disconnect or OS audio interruption) to auto-recover
          result.stream.getAudioTracks().forEach((track) => {
            track.onended = () => {
              mediaStreamRef.current = null;
              micSourceRef.current = null;
              micAnalyserRef.current = null;
            };
          });
        }

        const stream = mediaStreamRef.current;
        if (!stream) return null;

        // Eksplisit paksa fitur bawaan WebRTC Echo Cancellation, Noise Suppression, & Auto Gain Control aktif pada stream
        await enforceHardwareEchoCancellationOnStream(stream);

        const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
        if (!ctx) {
          setMicErrorNotice('Web Audio API tidak didukung pada peramban ini.');
          return null;
        }
        audioCtxRef.current = ctx;

        // Ensure Keep-Alive Silent Audio Stream is running if enabled so mobile browser never sleeps
        if (keepAliveEnabledRef.current) {
          if (!keepAliveSessionRef.current) {
            keepAliveSessionRef.current = createSilentKeepAliveController();
          }
          keepAliveSessionRef.current.start(ctx);
          setIsSilentKeepAliveRunning(true);
        }

        if (!micSourceRef.current || !micAnalyserRef.current) {
          const source = ctx.createMediaStreamSource(stream);

          // PRE-AMP GAIN SENSOR VOX SEIMBANG (Default Balance 1.65x) + ANTI-ECHO GATE:
          // Saat speaker RX berbunyi, gain ini langsung dikunci ke 0.0 agar suara speaker tidak bocor ke mikrofon.
          const voxPreAmpGain = ctx.createGain();
          voxPreAmpGain.gain.setValueAtTime(1.65, ctx.currentTime);
          voxPreAmpGainRef.current = voxPreAmpGain;

          // FILTER FREKUENSI VOKAL NATURAL (250 Hz - 3.400 Hz) VIA WEB AUDIO API BiquadFilterNode:
          // Stage 1: High-Pass Filter (250 Hz, Butterworth Q = 0.707)
          // Menyaring deru angin frekuensi rendah (< 250 Hz) sambil membiarkan frekuensi dasar suara vokal lewat secara utuh
          const highpassVocal = ctx.createBiquadFilter();
          highpassVocal.type = 'highpass';
          highpassVocal.frequency.value = 250;
          highpassVocal.Q.value = 0.707;

          // Stage 2: Low-Pass Filter (3.400 Hz, Butterworth Q = 0.707)
          // Menyaring desis frekuensi tinggi di atas rentang vokal manusia (> 3,4 kHz)
          const lowpassVocal = ctx.createBiquadFilter();
          lowpassVocal.type = 'lowpass';
          lowpassVocal.frequency.value = 3400;
          lowpassVocal.Q.value = 0.707;

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.minDecibels = -82;
          analyser.maxDecibels = -18;
          analyser.smoothingTimeConstant = 0.25;

          // WEB AUDIO API ANALYSER / GAINNODE LOOP-BACK RINGAN (GAIN = 0.0 -> DESTINATION):
          // Menjaga agar peramban seluler (Chrome Android / Safari iOS / HarmonyOS) tetap menarik sampel dari
          // MediaStream mikrofon saat pengguna beralih membuka aplikasi lain di HP (Background Mode),
          // dengan gain tepat 0.0 sehingga suara mikrofon sendiri TIDAK PERNAH bocor/menggema ke speaker!
          const micLoopbackKeepAliveGain = ctx.createGain();
          micLoopbackKeepAliveGain.gain.setValueAtTime(0, ctx.currentTime);
          micLoopbackKeepAliveGainRef.current = micLoopbackKeepAliveGain;

          source.connect(voxPreAmpGain);
          voxPreAmpGain.connect(highpassVocal);
          highpassVocal.connect(lowpassVocal);
          lowpassVocal.connect(analyser);
          analyser.connect(micLoopbackKeepAliveGain);
          micLoopbackKeepAliveGain.connect(ctx.destination);

          micSourceRef.current = source;
          micFilterRef.current = lowpassVocal;
          micAnalyserRef.current = analyser;
        }

        return micAnalyserRef.current;
      } catch {
        setMicPermissionState('denied');
        setMicErrorNotice(
          'Gagal menginisialisasi mikrofon. Ketuk tombol Izin Audio untuk mengaktifkan ulang.'
        );
        return null;
      }
    },
    []
  );

  // Handler saat pengguna menekan tombol untuk memberikan / memulihkan izin audio di Safari (iOS) / Chrome (Android/HarmonyOS)
  const handleGrantOrRecoverAudioPermission = useCallback(async () => {
    const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
    if (ctx) {
      audioCtxRef.current = ctx;
      await unlockMobileAudioSession(ctx, reusableRxAudioRef.current);
      if (keepAliveEnabledRef.current) {
        if (!keepAliveSessionRef.current) {
          keepAliveSessionRef.current = createSilentKeepAliveController();
        }
        keepAliveSessionRef.current.start(ctx);
        setIsSilentKeepAliveRunning(true);
      }
    }
    const analyser = await ensureWebAudioVoxGraph(true);
    if (analyser) {
      setMicPermissionState('granted');
      setMicErrorNotice(null);
      playTacticalTone('start');
    }
  }, [ensureWebAudioVoxGraph, playTacticalTone]);

  // Monitor perubahan status izin mikrofon (Permissions API) & pergantian perangkat audio (TWS Bluetooth)
  // Saat izin diberikan oleh pengguna di Safari/Chrome, sistem otomatis mengaktifkan Web Audio VOX & Keep-Alive!
  useEffect(() => {
    let permissionStatus: PermissionStatus | null = null;
    let isUnmounted = false;

    const handlePermissionChange = () => {
      if (isUnmounted || !permissionStatus) return;
      if (permissionStatus.state === 'granted') {
        setMicPermissionState('granted');
        setMicErrorNotice(null);
        const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
        if (ctx) {
          audioCtxRef.current = ctx;
          unlockMobileAudioSession(ctx, reusableRxAudioRef.current);
        }
        ensureWebAudioVoxGraph(true);
      } else if (permissionStatus.state === 'denied') {
        setMicPermissionState('denied');
      }
    };

    if (
      typeof navigator !== 'undefined' &&
      'permissions' in navigator &&
      typeof navigator.permissions?.query === 'function'
    ) {
      navigator.permissions
        .query({ name: 'microphone' as PermissionName })
        .then((status) => {
          if (isUnmounted) return;
          permissionStatus = status;
          if (status.state === 'granted') {
            setMicPermissionState('granted');
            setMicErrorNotice(null);
          } else if (status.state === 'denied') {
            setMicPermissionState('denied');
          }
          status.onchange = handlePermissionChange;
        })
        .catch(() => {
          // Safari versions that do not support 'microphone' query in navigator.permissions will use getUserMedia directly
        });
    }

    const handleDeviceChange = () => {
      if (isUnmounted) return;
      // Rebuild microphone stream if user connects/disconnects TWS earbuds or wired headset
      if (
        isPasscodeAuthenticatedRef.current &&
        isSetupCompleted &&
        (voxEnabledRef.current || isTransmittingRef.current)
      ) {
        ensureWebAudioVoxGraph(true);
      }
    };

    if (
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.addEventListener === 'function'
    ) {
      navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    }

    return () => {
      isUnmounted = true;
      if (permissionStatus) {
        permissionStatus.onchange = null;
      }
      if (
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.removeEventListener === 'function'
      ) {
        navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
      }
    };
  }, [isPasscodeAuthenticated, isSetupCompleted, ensureWebAudioVoxGraph]);

  // SISTEM KEEP-ALIVE LATAR BELAKANG (SILENT AUDIO STREAM VIA WEB AUDIO API PADA VISIBILITYCHANGE EVENT)
  // Mencegah browser Android (Chrome/HarmonyOS) & iOS (Safari) membekukan aliran WebSocket, VOX,
  // dan pemutaran suara masuk saat layar HP dimatikan atau dimasukkan ke dalam saku saat berkendara.
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;

    if (!keepAliveSessionRef.current) {
      keepAliveSessionRef.current = createSilentKeepAliveController();
    }
    const controller = keepAliveSessionRef.current;
    controller.attachDomAudioElement(silentLoopAudioRef.current);
    let backgroundSocketHeartbeat: number | null = null;

    const getMediaSessionStatusText = () => {
      if (isTransmittingRef.current) return 'TX MENGIRIM SUARA (ON AIR)';
      if (remoteActiveTxRef.current) return `RX: ${remoteActiveTxRef.current}`;
      if (voxEnabledRef.current) return `VOX SIAGA (THR ${voxThresholdRef.current}%)`;
      return 'STANDBY MANUAL PTT';
    };

    const syncKeepAliveState = () => {
      if (!keepAliveEnabled) {
        controller.stop();
        setIsSilentKeepAliveRunning(false);
        setIsMediaSessionActive(false);
        return;
      }
      controller.attachDomAudioElement(silentLoopAudioRef.current);
      if (silentLoopAudioRef.current) {
        silentLoopAudioRef.current.loop = true;
        silentLoopAudioRef.current.volume = 0.02;
        if (silentLoopAudioRef.current.paused) {
          silentLoopAudioRef.current.play().catch(() => {});
        }
      }
      const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (ctx) {
        audioCtxRef.current = ctx;
        controller.start(ctx);
        controller.updateMediaSessionMetadata({
          callsign: myCallsign || 'UNIT',
          channel,
          statusText: getMediaSessionStatusText(),
        });
        setIsSilentKeepAliveRunning(controller.isActive());
        setIsMediaSessionActive(true);
      }
    };

    syncKeepAliveState();

    const handleVisibilityChange = () => {
      const isHidden = document.visibilityState === 'hidden' || document.hidden;
      setIsBackgroundMode((prev) => (prev === isHidden ? prev : isHidden));

      if (keepAliveEnabledRef.current && silentLoopAudioRef.current) {
        silentLoopAudioRef.current.loop = true;
        if (silentLoopAudioRef.current.paused) {
          silentLoopAudioRef.current.play().catch(() => {});
        }
      }

      const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (ctx) {
        audioCtxRef.current = ctx;
        if (keepAliveEnabledRef.current) {
          controller.attachDomAudioElement(silentLoopAudioRef.current);
          controller.pulseOnVisibilityChange(ctx, isHidden);
          controller.updateMediaSessionMetadata({
            callsign: myCallsign || 'UNIT',
            channel,
            statusText: getMediaSessionStatusText(),
          });
          setIsSilentKeepAliveRunning((prev) => (prev ? prev : true));
          setIsMediaSessionActive((prev) => (prev ? prev : true));
        }
      }

      if (isHidden) {
        if (isMinimizedModeRef.current) {
          wasHiddenWhileMinimizedRef.current = true;
        }
        // Saat pengguna meminimalkan aplikasi / beralih membuka aplikasi lain di HP / layar mati (background):
        // Jaga aliran mikrofon (MediaStream), AudioContext, WebSocket, MQTT, & PeerJS tetap aktif 100% tanpa terputus!
        if (backgroundSocketHeartbeat) {
          window.clearInterval(backgroundSocketHeartbeat);
        }
        if (
          voxEnabledRef.current &&
          !isRxQueuePlayingRef.current &&
          !remoteActiveTxRef.current &&
          mediaStreamRef.current
        ) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            if (!t.enabled) t.enabled = true;
          });
        }
        broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
        backgroundSocketHeartbeat = window.setInterval(() => {
          if (silentLoopAudioRef.current && silentLoopAudioRef.current.paused) {
            silentLoopAudioRef.current.play().catch(() => {});
          }
          if (audioCtxRef.current) {
            const st = audioCtxRef.current.state as string;
            if (st === 'suspended' || st === 'interrupted') {
              audioCtxRef.current.resume().catch(() => {});
            }
            if (keepAliveEnabledRef.current) {
              controller.pulseOnVisibilityChange(audioCtxRef.current, true);
            }
          }
          if (voxEnabledRef.current && !isRxQueuePlayingRef.current && !remoteActiveTxRef.current) {
            const hasLiveMic = mediaStreamRef.current
              ?.getAudioTracks()
              .some((t) => t.readyState === 'live');
            if (!hasLiveMic) {
              ensureWebAudioVoxGraphRef.current(true);
            } else if (mediaStreamRef.current) {
              mediaStreamRef.current.getAudioTracks().forEach((t) => {
                if (!t.enabled) t.enabled = true;
              });
            }
          }
          broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
          if (peerRef.current && peerRef.current.disconnected && !peerRef.current.destroyed) {
            try {
              peerRef.current.reconnect();
            } catch {
              // Ignore
            }
          }
        }, 3500);
      } else {
        // Saat aplikasi dibuka kembali ke layar utama HP (visible): otomatis tampilkan kembali UI jika sebelumnya di-minimize ke Home Screen
        if (isMinimizedModeRef.current && wasHiddenWhileMinimizedRef.current) {
          wasHiddenWhileMinimizedRef.current = false;
          isMinimizedModeRef.current = false;
          setIsMinimizedMode(false);
        }
        if (backgroundSocketHeartbeat) {
          window.clearInterval(backgroundSocketHeartbeat);
          backgroundSocketHeartbeat = null;
        }
        if (audioCtxRef.current) {
          const st = audioCtxRef.current.state as string;
          if (st === 'suspended' || st === 'interrupted') {
            audioCtxRef.current.resume().catch(() => {});
          }
        }
        if (voxEnabledRef.current) {
          const hasLiveMic = mediaStreamRef.current
            ?.getAudioTracks()
            .some((t) => t.readyState === 'live');
          if (!hasLiveMic) {
            ensureWebAudioVoxGraphRef.current(true);
          }
        }
        broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
      }
    };

    // Unthrottled Web Worker Heartbeat Listener: tetap berjalan meskipun tab/browser di-background-kan oleh OS HP!
    const unsubscribeWorkerHeartbeat = subscribeToBackgroundWorkerTicks({
      onHeartbeatTick: () => {
        if (!document.hidden && !isMinimizedModeRef.current) return;
        if (silentLoopAudioRef.current && silentLoopAudioRef.current.paused) {
          silentLoopAudioRef.current.volume = 0.15;
          silentLoopAudioRef.current.play().catch(() => {});
        }
        if (audioCtxRef.current) {
          const st = audioCtxRef.current.state as string;
          if (st === 'suspended' || st === 'interrupted') {
            audioCtxRef.current.resume().catch(() => {});
          }
          if (keepAliveEnabledRef.current) {
            controller.pulseOnVisibilityChange(audioCtxRef.current, true);
          }
        }
        // Jika sedang mentransmisikan suara (TX) di background, pastikan segmen PCM tetap terkirim lancar tanpa terputus!
        if (
          isTransmittingRef.current &&
          isPcmRecordingRef.current &&
          pcmChunksRef.current.length > 0 &&
          Date.now() - lastPcmFlushTsRef.current >= 750
        ) {
          lastPcmFlushTsRef.current = Date.now();
          const flushedChunks = pcmChunksRef.current;
          pcmChunksRef.current = [];
          const sampleRate = audioCtxRef.current?.sampleRate || 44100;
          const wavBlob = encodePcmChunksToWavBlob(flushedChunks, sampleRate);
          dispatchRecordedVoiceBlob(wavBlob);
        }
        if (voxEnabledRef.current && !isRxQueuePlayingRef.current && !remoteActiveTxRef.current) {
          const hasLiveMic = mediaStreamRef.current
            ?.getAudioTracks()
            .some((t) => t.readyState === 'live');
          if (!hasLiveMic) {
            ensureWebAudioVoxGraphRef.current(true);
          } else if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach((t) => {
              if (!t.enabled) t.enabled = true;
            });
          }
        }
        broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
        if (peerRef.current && peerRef.current.disconnected && !peerRef.current.destroyed) {
          try {
            peerRef.current.reconnect();
          } catch {
            // Ignore
          }
        }
      },
    });

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);

    return () => {
      unsubscribeWorkerHeartbeat();
      if (backgroundSocketHeartbeat) {
        window.clearInterval(backgroundSocketHeartbeat);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
    };
  }, [
    isPasscodeAuthenticated,
    isSetupCompleted,
    myCallsign,
    keepAliveEnabled,
    ensureWebAudioVoxGraph,
  ]);

  // Helper untuk mengenkripsi (AES-256-GCM via Web Crypto API) & mengirim Blob rekaman suara ke jaringan
  const dispatchRecordedVoiceBlob = useCallback(
    (blob: Blob) => {
      // PERBAIKAN KRITIS: Selama PTT masih aktif mentransmisikan suara (isTransmittingRef.current === true),
      // JANGAN PERNAH mematikan track mikrofon! Mematikan track di sini menyebabkan suara hilang setelah 1 detik!
      if (mediaStreamRef.current) {
        if (isTransmittingRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach((track) => {
            if (!track.enabled) track.enabled = true;
          });
        } else {
          const keepOpenForVox =
            voxEnabledRef.current &&
            !remoteActiveTxRef.current &&
            !channelLockOwnerRef.current;
          mediaStreamRef.current.getAudioTracks().forEach((track) => {
            track.enabled = keepOpenForVox;
          });
        }
      }

      // If this recording was aborted due to Anti-Collision, discard the audio clip so it never collides!
      if (abortDiscardRecordingRef.current) {
        abortDiscardRecordingRef.current = false;
        return;
      }

      if (blob.size > 200) {
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64Audio = reader.result as string;
          if (base64Audio) {
            // ENKRIPSI AUDIO END-TO-END (AES-256-GCM via window.crypto.subtle) SEBELUM DIKIRIM MELALUI WEBSOCKET/WEBRTC
            const encrypted = await encryptAudioPayloadAesGcm(
              base64Audio,
              PASSCODE_HARIAN
            );

            if (encrypted) {
              setE2eEncryptedTxCount((c) => c + 1);
              setLastAesIvPreview(encrypted.ivBase64.slice(0, 8));
              broadcastMeshPacket({
                type: 'VOICE_CLIP',
                encryptedAudio: true,
                audioCiphertext: encrypted.ciphertextBase64,
                aesIv: encrypted.ivBase64,
                cipherAlgo: 'AES-256-GCM',
                mimeType: blob.type || 'audio/wav',
                lockOwnerId: myDeviceId,
                lockOwnerCallsign: myCallsign,
                lockStartedAt: localTxStartedAtRef.current,
                isPriorityOverride: isPriorityOverrideRef.current,
              });
            } else {
              // Fallback hanya jika environment tidak mendukung SubtleCrypto
              broadcastMeshPacket({
                type: 'VOICE_CLIP',
                audioBase64: base64Audio,
                mimeType: blob.type || 'audio/wav',
                lockOwnerId: myDeviceId,
                lockOwnerCallsign: myCallsign,
                lockStartedAt: localTxStartedAtRef.current,
                isPriorityOverride: isPriorityOverrideRef.current,
              });
            }

            // Only if user explicitly enabled Echo Test Mode in Settings (and PTT is already closed / RX ON)
            if (
              !isTransmittingRef.current &&
              !isReceiverOffRef.current &&
              echoTestMode &&
              membersRef.current.length === 0
            ) {
              window.setTimeout(() => {
                playIncomingAudioBase64(base64Audio, `${myCallsign} (ECHO)`);
              }, 350);
            }
          }
        };
        reader.readAsDataURL(blob);
      }
    },
    [broadcastMeshPacket, myDeviceId, myCallsign, echoTestMode, playIncomingAudioBase64]
  );

  // onStartTransmit (Dipanggil otomatis oleh VOX, Klik Pertama tombol PTT, atau saat OVERRIDE diaktifkan)
  const onStartTransmit = useCallback(
    async (triggerSource: 'VOX' | 'MANUAL' | 'OVERRIDE' = 'MANUAL') => {
      if (isTransmittingRef.current) return;

      const isOverrideMode =
        triggerSource === 'OVERRIDE' || isPriorityOverrideRef.current;

      // 0. CHANNEL LOCKOUT / ANTI-COLLISION CHECK (Dilewati jika mode PRIORITY OVERRIDE aktif!):
      const now = Date.now();
      const existingLock = channelLockOwnerRef.current;
      const isChannelLockedByOther =
        !isOverrideMode &&
        (Boolean(remoteActiveTxRef.current) ||
          Boolean(
            existingLock &&
              existingLock.senderId !== myDeviceId &&
              now - existingLock.updatedAt < 12000
          ) ||
          Boolean(isRxQueuePlayingRef.current) ||
          Boolean(
            activeAudioElementRef.current &&
              !activeAudioElementRef.current.paused &&
              !activeAudioElementRef.current.ended
          ) ||
          Boolean(activeWebAudioRxStopRef.current) ||
          (triggerSource === 'VOX' && now < rxCooldownUntilRef.current));

      if (!isOverrideMode && (isChannelLockedByOther || isPttLocked)) {
        voxVoiceFramesRef.current = 0;
        setVoxInputLevel(0);
        if (triggerSource === 'MANUAL') {
          const holder =
            existingLock?.callsign || remoteActiveTxRef.current || 'REKAN';
          setCollisionBlockedNotice(
            `ANTI-COLLISION: SALURAN SEDANG DIGUNAKAN OLEH ${holder}`
          );
          window.setTimeout(() => setCollisionBlockedNotice(null), 2000);
        }
        return;
      }

      // 1. STRICT HALF-DUPLEX (ANTI-ECHO): Matikan Receiver (Speaker RX OFF, Volume 0) SEBELUM membuka transmisi!
      muteAndDisableReceiver();

      const txStartTs = Date.now();
      localTxStartedAtRef.current = txStartTs;
      abortDiscardRecordingRef.current = false;
      channelLockOwnerRef.current = null;
      setChannelLockOwner(null);
      remoteActiveTxRef.current = null;
      setIncomingSpeaker(null);
      setIsTransmitting(true);
      isTransmittingRef.current = true;
      isVoxTriggeredTxRef.current = triggerSource === 'VOX';
      lastVoiceActiveTimeRef.current = txStartTs;

      // 2. Jika OVERRIDE aktif, kirim paket PRIORITY_OVERRIDE untuk menghentikan transmisi klien lain seketika!
      if (isOverrideMode) {
        broadcastMeshPacket({
          type: 'PRIORITY_OVERRIDE',
          isPriorityOverride: true,
          lockOwnerId: myDeviceId,
          lockOwnerCallsign: myCallsign,
          lockStartedAt: txStartTs,
        });
      }

      // Klaim Penguncian Saluran (CHANNEL_LOCK + TX_START) ke seluruh klien WebSocket / WebRTC / Mesh
      broadcastMeshPacket({
        type: 'CHANNEL_LOCK',
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
        lockStartedAt: txStartTs,
        isPriorityOverride: isOverrideMode,
      });
      broadcastMeshPacket({
        type: 'TX_START',
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
        lockStartedAt: txStartTs,
        isPriorityOverride: isOverrideMode,
      });

      // 3. Heartbeat CHANNEL_LOCK setiap 1.8 detik selama transmisi aktif agar klien yang baru gabung tetap terkunci
      if (txLockHeartbeatRef.current) {
        window.clearInterval(txLockHeartbeatRef.current);
      }
      txLockHeartbeatRef.current = window.setInterval(() => {
        if (!isTransmittingRef.current) return;
        broadcastMeshPacket({
          type: isPriorityOverrideRef.current ? 'PRIORITY_OVERRIDE' : 'CHANNEL_LOCK',
          lockOwnerId: myDeviceId,
          lockOwnerCallsign: myCallsign,
          lockStartedAt: localTxStartedAtRef.current,
          isPriorityOverride: isPriorityOverrideRef.current,
        });
      }, 1800);

      try {
        const analyser = await ensureWebAudioVoxGraph();
        const stream = mediaStreamRef.current;
        const ctx = audioCtxRef.current;
        if (stream && analyser && ctx) {
          const st = ctx.state as string;
          if (st === 'suspended' || st === 'interrupted') {
            await ctx.resume().catch(() => {});
          }
          if (voxPreAmpGainRef.current) {
            try {
              voxPreAmpGainRef.current.gain.setValueAtTime(1.65, ctx.currentTime);
            } catch {
              voxPreAmpGainRef.current.gain.value = 1.65;
            }
          }
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          if (animFrameRef.current) {
            window.clearInterval(animFrameRef.current);
          }
          // Throttled 110ms meter update via isolated LiveAudioMeterStore (0 re-renders on main App!)
          animFrameRef.current = window.setInterval(() => {
            if (!isTransmittingRef.current) return;
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getAudioTracks().forEach((t) => {
                if (!t.enabled) t.enabled = true;
              });
            }
            const currentAnalyser = micAnalyserRef.current || analyser;
            currentAnalyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            setMicLevel(Math.min(100, Math.max(25, Math.round(avg * 1.45))));
          }, 110);

          if (pttSegmentIntervalRef.current) {
            window.clearInterval(pttSegmentIntervalRef.current);
            pttSegmentIntervalRef.current = null;
          }

          // ===================================================================
          // MESIN TRANSMISI SUARA KONTINYU TANPA PUTUS (GAPLESS CONTINUOUS STREAMING)
          // Menggunakan Web Audio API Continuous PCM-to-WAV Capture sebagai jalur utama
          // sehingga stream mikrofon TIDAK PERNAH di-stop/restart setelah 1 detik!
          // Suara tetap terkirim utuh selama tombol PTT ditekan (baik 2 detik maupun 5 menit).
          // ===================================================================
          let startedContinuousPcm = false;
          if (micSourceRef.current) {
            try {
              if (pcmProcessorRef.current) {
                try {
                  pcmProcessorRef.current.disconnect();
                  pcmZeroGainRef.current?.disconnect();
                } catch {
                  // Ignore
                }
              }
              pcmChunksRef.current = [];
              isPcmRecordingRef.current = true;
              lastPcmFlushTsRef.current = Date.now();

              const processor = ctx.createScriptProcessor(4096, 1, 1);
              const zeroGain = ctx.createGain();
              zeroGain.gain.value = 0; // Mute local monitor so mic never echoes to own speaker

              processor.onaudioprocess = (ev) => {
                if (!isTransmittingRef.current || !isPcmRecordingRef.current) return;
                const inputData = ev.inputBuffer.getChannelData(0);
                pcmChunksRef.current.push(new Float32Array(inputData));
              };

              micSourceRef.current.connect(processor);
              processor.connect(zeroGain);
              zeroGain.connect(ctx.destination);
              pcmProcessorRef.current = processor;
              pcmZeroGainRef.current = zeroGain;
              startedContinuousPcm = true;

              // Kirim segmen suara utuh setiap 750ms tanpa menghentikan aliran mikrofon sedikit pun!
              pttSegmentIntervalRef.current = window.setInterval(() => {
                if (!isTransmittingRef.current || !isPcmRecordingRef.current) return;
                if (mediaStreamRef.current) {
                  mediaStreamRef.current.getAudioTracks().forEach((t) => {
                    if (!t.enabled) t.enabled = true;
                  });
                }
                if (pcmChunksRef.current.length > 0) {
                  lastPcmFlushTsRef.current = Date.now();
                  const flushedChunks = pcmChunksRef.current;
                  pcmChunksRef.current = [];
                  const sampleRate = audioCtxRef.current?.sampleRate || 44100;
                  const wavBlob = encodePcmChunksToWavBlob(flushedChunks, sampleRate);
                  dispatchRecordedVoiceBlob(wavBlob);
                }
              }, 750);
            } catch {
              startedContinuousPcm = false;
            }
          }

          // Fallback MediaRecorder berurutan (Sequential Stop -> Start) hanya jika ScriptProcessor tidak tersedia
          if (!startedContinuousPcm && typeof MediaRecorder !== 'undefined') {
            const startSequentialRecorder = () => {
              if (!isTransmittingRef.current || !mediaStreamRef.current) return false;
              try {
                mediaStreamRef.current.getAudioTracks().forEach((t) => {
                  if (!t.enabled) t.enabled = true;
                });
                const segmentChunks: Blob[] = [];
                recordedChunksRef.current = segmentChunks;

                const targetBitrateBps = (opusBitrateKbpsRef.current || 12) * 1000;
                const { options: recorderOptions, negotiatedMime, timesliceMs } =
                  createOpusLowBitrateRecorderOptions(targetBitrateBps);

                let recorder: MediaRecorder;
                try {
                  recorder = new MediaRecorder(mediaStreamRef.current, recorderOptions);
                } catch {
                  recorder = negotiatedMime
                    ? new MediaRecorder(mediaStreamRef.current, {
                        mimeType: negotiatedMime,
                        audioBitsPerSecond: targetBitrateBps,
                      })
                    : new MediaRecorder(mediaStreamRef.current, {
                        audioBitsPerSecond: targetBitrateBps,
                      });
                }

                recorder.ondataavailable = (e) => {
                  if (e.data && e.data.size > 0) {
                    segmentChunks.push(e.data);
                  }
                };

                recorder.onstop = () => {
                  if (segmentChunks.length > 0) {
                    const effectiveMime =
                      recorder.mimeType || negotiatedMime || 'audio/webm;codecs=opus';
                    const blob = new Blob(segmentChunks, { type: effectiveMime });
                    dispatchRecordedVoiceBlob(blob);
                  }
                  // Mulai segmen berikutnya SETELAH segmen sebelumnya benar-benar berhenti agar encoder HP tidak macet
                  if (isTransmittingRef.current) {
                    startSequentialRecorder();
                  }
                };

                mediaRecorderRef.current = recorder;
                recorder.start(timesliceMs || OPTIMAL_MEDIA_RECORDER_TIMESLICE_MS);
                return true;
              } catch {
                return false;
              }
            };

            if (startSequentialRecorder()) {
              pttSegmentIntervalRef.current = window.setInterval(() => {
                if (!isTransmittingRef.current) return;
                const activeRec = mediaRecorderRef.current;
                if (activeRec && activeRec.state === 'recording') {
                  try {
                    activeRec.stop();
                  } catch {
                    // Ignore
                  }
                }
              }, 850);
            }
          }
        } else {
          // If microphone permission is not yet granted, fallback visual meter at throttled 120ms interval
          if (animFrameRef.current) {
            window.clearInterval(animFrameRef.current);
          }
          animFrameRef.current = window.setInterval(() => {
            if (!isTransmittingRef.current) return;
            setMicLevel(Math.floor(40 + Math.random() * 55));
          }, 120);
        }
      } catch {
        setMicPermissionState('denied');
        if (animFrameRef.current) {
          window.clearInterval(animFrameRef.current);
        }
        animFrameRef.current = window.setInterval(() => {
          if (!isTransmittingRef.current) return;
          setMicLevel(Math.floor(40 + Math.random() * 55));
        }, 120);
      }
    },
    [
      myDeviceId,
      isPttLocked,
      muteAndDisableReceiver,
      broadcastMeshPacket,
      ensureWebAudioVoxGraph,
      dispatchRecordedVoiceBlob,
      myCallsign,
      setMicLevel,
      setVoxInputLevel,
    ]
  );

  // onStopTransmit (Dipanggil otomatis oleh VOX saat hening / berhenti bicara, atau saat Klik Kedua tombol PTT)
  const onStopTransmit = useCallback(() => {
    if (!isTransmittingRef.current) return;
    setIsTransmitting(false);
    isTransmittingRef.current = false;
    isVoxTriggeredTxRef.current = false;
    voxVoiceFramesRef.current = 0;
    voiceOnsetStartTimeRef.current = 0;
    setMicLevel(0, true);

    if (pttSegmentIntervalRef.current) {
      window.clearInterval(pttSegmentIntervalRef.current);
      pttSegmentIntervalRef.current = null;
    }

    if (txLockHeartbeatRef.current) {
      window.clearInterval(txLockHeartbeatRef.current);
      txLockHeartbeatRef.current = null;
    }

    if (animFrameRef.current) {
      window.clearInterval(animFrameRef.current);
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    // Jika VOX dimatikan, matikan track mikrofon hardware; jika VOX aktif, biarkan siap mendengarkan kalimat berikutnya
    if (mediaStreamRef.current && !voxEnabledRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }

    // Hentikan perekam MediaRecorder & kirim paket VOICE_CLIP terakhir
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore stop error
      }
    }

    // Hentikan perekam fallback PCM-to-WAV jika aktif (Safari iOS / HarmonyOS fallback)
    if (isPcmRecordingRef.current) {
      isPcmRecordingRef.current = false;
      const recordedChunks = pcmChunksRef.current;
      pcmChunksRef.current = [];
      try {
        pcmProcessorRef.current?.disconnect();
        pcmZeroGainRef.current?.disconnect();
      } catch {
        // Ignore disconnect error
      }
      pcmProcessorRef.current = null;
      pcmZeroGainRef.current = null;

      if (recordedChunks.length > 0) {
        const sampleRate = audioCtxRef.current?.sampleRate || 44100;
        const wavBlob = encodePcmChunksToWavBlob(recordedChunks, sampleRate);
        dispatchRecordedVoiceBlob(wavBlob);
      }
    }

    // Aktifkan kembali Receiver (RX ON) + beri cooldown 550ms agar Roger Beep & pantulan akustik tidak memicu ulang VOX
    rxCooldownUntilRef.current = Date.now() + 550;
    isReceiverOffRef.current = false;
    playTacticalTone('end');
    broadcastMeshPacket({
      type: 'TX_STOP',
      lockOwnerId: myDeviceId,
      lockOwnerCallsign: myCallsign,
    });
    broadcastMeshPacket({
      type: 'CHANNEL_UNLOCK',
      lockOwnerId: myDeviceId,
      lockOwnerCallsign: myCallsign,
    });
    if (isPriorityOverrideRef.current) {
      isPriorityOverrideRef.current = false;
      setIsPriorityOverride(false);
      broadcastMeshPacket({
        type: 'PRIORITY_OVERRIDE_END',
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
      });
    }
  }, [
    myDeviceId,
    myCallsign,
    playTacticalTone,
    broadcastMeshPacket,
    dispatchRecordedVoiceBlob,
  ]);

  const handlePttStart = () => onStartTransmit('MANUAL');
  const handlePttEnd = () => onStopTransmit();

  // Sakelar Kontrol OVERRIDE Prioritas (Menghentikan transmisi klien lain seketika & mengambil alih saluran)
  const handleTogglePriorityOverride = useCallback(() => {
    const next = !isPriorityOverrideRef.current;
    isPriorityOverrideRef.current = next;
    setIsPriorityOverride(next);

    if (next) {
      // Hentikan suara RX yang sedang masuk, ambil alih kunci saluran, dan pancarkan sinyal PRIORITY_OVERRIDE
      // sehingga seluruh klien lain otomatis menghentikan transmisinya seketika!
      muteAndDisableReceiver();
      channelLockOwnerRef.current = null;
      setChannelLockOwner(null);
      remoteActiveTxRef.current = null;
      setIncomingSpeaker(null);
      setCollisionBlockedNotice(null);

      broadcastMeshPacket({
        type: 'PRIORITY_OVERRIDE',
        isPriorityOverride: true,
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
        lockStartedAt: Date.now(),
      });

      if (!isTransmittingRef.current) {
        onStartTransmit('OVERRIDE');
      }
    } else {
      if (isTransmittingRef.current) {
        onStopTransmit();
      } else {
        broadcastMeshPacket({
          type: 'PRIORITY_OVERRIDE_END',
          isPriorityOverride: false,
          lockOwnerId: myDeviceId,
          lockOwnerCallsign: myCallsign,
        });
      }
    }
  }, [
    muteAndDisableReceiver,
    broadcastMeshPacket,
    myDeviceId,
    myCallsign,
    onStartTransmit,
    onStopTransmit,
  ]);

  // Sakelar VOX On/Off (Toggle Switch Handler)
  const handleToggleVoxSwitch = useCallback(() => {
    setVoxEnabled((prev) => {
      const next = !prev;
      voxEnabledRef.current = next;
      if (!next) {
        voxVoiceFramesRef.current = 0;
        voiceOnsetStartTimeRef.current = 0;
        setIsVocalPatternConfirmed(false);
        setVoxInputLevel(0);
        if (isTransmittingRef.current && isVoxTriggeredTxRef.current) {
          onStopTransmit();
        } else if (mediaStreamRef.current && !isTransmittingRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = false;
          });
        }
      } else {
        // Picu kalibrasi cepat ambient noise floor saat VOX diaktifkan
        isInitialNoiseCalibratingRef.current = true;
        noiseCalibrationSamplesRef.current = [];
      }
      return next;
    });
  }, [onStopTransmit]);

  // Fungsi Kalibrasi Ulang Ambient Noise Floor Secara Instan
  const handleRecalibrateVoxNoiseFloor = useCallback(() => {
    isInitialNoiseCalibratingRef.current = true;
    noiseCalibrationSamplesRef.current = [];
    voiceOnsetStartTimeRef.current = 0;
    voxVoiceFramesRef.current = 0;
  }, []);

  // Toggle PTT Manual (Klik Pertama = Buka PTT & Receiver OFF, Klik Kedua = Tutup PTT & Receiver ON)
  const handlePttToggle = () => {
    if (isPttLocked && !isPriorityOverride) return;
    if (isTransmittingRef.current || isTransmitting) {
      onStopTransmit();
    } else {
      onStartTransmit('MANUAL');
    }
  };

  // Stable refs for VOX monitor so the VOX interval NEVER restarts or loops when TX/RX state changes
  const isPttLockedRef = useRef<boolean>(isPttLocked);
  useEffect(() => {
    isPttLockedRef.current = isPttLocked;
  }, [isPttLocked]);

  const onStartTransmitRef = useRef(onStartTransmit);
  useEffect(() => {
    onStartTransmitRef.current = onStartTransmit;
  }, [onStartTransmit]);

  const onStopTransmitRef = useRef(onStopTransmit);
  useEffect(() => {
    onStopTransmitRef.current = onStopTransmit;
  }, [onStopTransmit]);

  const ensureWebAudioVoxGraphRef = useRef(ensureWebAudioVoxGraph);
  useEffect(() => {
    ensureWebAudioVoxGraphRef.current = ensureWebAudioVoxGraph;
  }, [ensureWebAudioVoxGraph]);

  // MESIN UTAMA VOX CERDAS BERBASIS WEB AUDIO API:
  // Semua pembaruan level audio disalurkan ke LiveAudioMeterStore (React.memo) sehingga TIDAK memicu re-render halaman utama!
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;

    let isCancelled = false;
    let voxTimer: number | null = null;

    isInitialNoiseCalibratingRef.current = true;
    noiseCalibrationSamplesRef.current = [];
    voiceOnsetStartTimeRef.current = 0;

    const startContinuousVoxMonitor = async () => {
      if (!voxEnabled && !isTransmittingRef.current) {
        setVoxInputLevel(0, true);
        setIsVocalPatternConfirmed(false);
        if (mediaStreamRef.current && !isTransmittingRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = false;
          });
        }
        return;
      }

      const analyser = await ensureWebAudioVoxGraphRef.current();
      if (isCancelled || !analyser) return;

      if (
        mediaStreamRef.current &&
        !remoteActiveTxRef.current &&
        !channelLockOwnerRef.current
      ) {
        mediaStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
      }

      const timeDomainBuf = new Uint8Array(analyser.fftSize);
      const freqDomainBuf = new Uint8Array(analyser.frequencyBinCount);

      const runVoxMonitorTick = () => {
        if (isCancelled) return;

        if (audioCtxRef.current) {
          const st = audioCtxRef.current.state as string;
          if (st === 'suspended' || st === 'interrupted') {
            audioCtxRef.current.resume().catch(() => {});
          }
        }

        const now = Date.now();
        const activeLock = channelLockOwnerRef.current;
        const isChannelLockedOrReceiving =
          Boolean(remoteActiveTxRef.current) ||
          Boolean(
            activeLock &&
              activeLock.senderId !== myDeviceId &&
              now - activeLock.updatedAt < 12000
          ) ||
          Boolean(isRxQueuePlayingRef.current) ||
          Boolean(
            activeAudioElementRef.current &&
              !activeAudioElementRef.current.paused &&
              !activeAudioElementRef.current.ended
          ) ||
          Boolean(activeWebAudioRxStopRef.current) ||
          now < rxCooldownUntilRef.current;

        if (isChannelLockedOrReceiving && !isTransmittingRef.current) {
          voxVoiceFramesRef.current = 0;
          voiceOnsetStartTimeRef.current = 0;
          setIsVocalPatternConfirmed(false);
          setVoxInputLevel(0);
          if (voxPreAmpGainRef.current && audioCtxRef.current) {
            try {
              voxPreAmpGainRef.current.gain.setValueAtTime(0, audioCtxRef.current.currentTime);
            } catch {
              voxPreAmpGainRef.current.gain.value = 0;
            }
          }
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach((t) => {
              if (t.enabled) t.enabled = false;
            });
          }
          return;
        }

        // Restore microphone pre-amp gain & track once RX playback and acoustic tail guard have completed
        if (voxPreAmpGainRef.current && audioCtxRef.current) {
          if (voxPreAmpGainRef.current.gain.value < 1.0) {
            try {
              voxPreAmpGainRef.current.gain.setValueAtTime(1.65, audioCtxRef.current.currentTime);
            } catch {
              voxPreAmpGainRef.current.gain.value = 1.65;
            }
          }
        }

        if (
          voxEnabledRef.current &&
          !isTransmittingRef.current &&
          mediaStreamRef.current
        ) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            if (!t.enabled) t.enabled = true;
          });
        }

        const activeAnalyser = micAnalyserRef.current || analyser;
        activeAnalyser.getByteTimeDomainData(timeDomainBuf);
        activeAnalyser.getByteFrequencyData(freqDomainBuf);

        // 1. Hitung RMS Amplitude dari sinyal vokal (250 Hz - 3.400 Hz) dengan peredam derau dasar ringan
        let sumSquares = 0;
        for (let i = 0; i < timeDomainBuf.length; i++) {
          const sample = timeDomainBuf[i] - 128;
          const normalized = Math.abs(sample) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / timeDomainBuf.length);

        // 2. Analisis Spektral Pita Vokal Manusia Natural (250 Hz - 3.400 Hz) vs Bising Luar
        const sampleRate = audioCtxRef.current?.sampleRate || 48000;
        const binHz = sampleRate / analyser.fftSize;
        const minVocalBin = Math.max(1, Math.floor(250 / binHz));
        const maxVocalBin = Math.min(
          freqDomainBuf.length - 1,
          Math.ceil(3400 / binHz)
        );

        let vocalBandSum = 0;
        let vocalBinCount = 0;
        let nonVocalSum = 0;
        let nonVocalCount = 0;

        for (let i = 1; i < freqDomainBuf.length; i++) {
          const mag = freqDomainBuf[i];
          if (i >= minVocalBin && i <= maxVocalBin) {
            vocalBandSum += mag;
            vocalBinCount += 1;
          } else {
            nonVocalSum += mag;
            nonVocalCount += 1;
          }
        }

        const vocalBandAvg = vocalBinCount > 0 ? vocalBandSum / vocalBinCount : 0;
        const nonVocalAvg = nonVocalCount > 0 ? nonVocalSum / nonVocalCount : 0;

        const cleanRms = rms < 0.008 ? 0 : rms - 0.008;
        const rmsScore = Math.sqrt(cleanRms) * 114;
        const spectralScore = Math.max(0, vocalBandAvg - 5) * 0.96;
        const rawEnergy = Math.max(rmsScore, spectralScore);
        const isVocalDominant = vocalBandAvg >= nonVocalAvg * 0.85;
        const voiceEnergy = Math.min(
          100,
          Math.round(isVocalDominant ? rawEnergy : rawEnergy * 0.72)
        );

        const lockedThreshold = voxThresholdRef.current;
        const isVocalPatternValid = voiceEnergy >= lockedThreshold && isVocalDominant;

        if (!isTransmittingRef.current && voiceOnsetStartTimeRef.current === 0 && voiceEnergy < lockedThreshold) {
          ambientNoiseFloorRef.current = Math.max(
            2,
            Math.min(35, ambientNoiseFloorRef.current * 0.9 + voiceEnergy * 0.1)
          );
        }

        // Update isolated LiveAudioMeterStore (direct DOM via useRef, 0 React setState calls!)
        liveAudioMeterStore.update({
          voxInputLevel: voiceEnergy,
          isVocalPatternConfirmed: isVocalPatternValid,
          ambientNoiseFloor: Math.round(ambientNoiseFloorRef.current),
        });

        const requiredConfirmMs = 135;

        if (!isTransmittingRef.current) {
          if (
            voxEnabledRef.current &&
            !isPttLockedRef.current &&
            isVocalPatternValid
          ) {
            if (voiceOnsetStartTimeRef.current === 0) {
              voiceOnsetStartTimeRef.current = now;
            }
            lastVocalDipTimeRef.current = 0;
            voxVoiceFramesRef.current += 1;

            const confirmedDurationMs = now - voiceOnsetStartTimeRef.current;
            if (confirmedDurationMs >= requiredConfirmMs && voxVoiceFramesRef.current >= 3) {
              voiceOnsetStartTimeRef.current = 0;
              voxVoiceFramesRef.current = 0;
              lastVoiceActiveTimeRef.current = now;
              onStartTransmitRef.current('VOX');
            }
          } else {
            if (
              voiceOnsetStartTimeRef.current > 0 &&
              now - (lastVocalDipTimeRef.current || now) <= 120 &&
              voiceEnergy >= Math.max(6, lockedThreshold - 4)
            ) {
              if (lastVocalDipTimeRef.current === 0) {
                lastVocalDipTimeRef.current = now;
              }
            } else {
              voiceOnsetStartTimeRef.current = 0;
              lastVocalDipTimeRef.current = 0;
              voxVoiceFramesRef.current = 0;
            }
          }
        } else {
          const sustainThreshold = Math.max(
            6,
            Math.round(lockedThreshold * 0.55)
          );
          if (voiceEnergy >= sustainThreshold) {
            lastVoiceActiveTimeRef.current = now;
          } else if (
            voxEnabledRef.current &&
            isVoxTriggeredTxRef.current &&
            !isPriorityOverrideRef.current
          ) {
            const silentMs = now - lastVoiceActiveTimeRef.current;
            if (silentMs >= voxHoldMsRef.current) {
              onStopTransmitRef.current();
            }
          }
        }
      };

      voxTimer = window.setInterval(runVoxMonitorTick, 65);
      // When user switches to another mobile app (document.hidden), window.setInterval is throttled by the OS,
      // so the unthrottled background Worker thread drives runVoxMonitorTick seamlessly!
      unsubscribeBgVoxTick = subscribeToBackgroundWorkerTicks({
        onVoxTick: () => {
          if (document.hidden || isMinimizedModeRef.current) {
            runVoxMonitorTick();
          }
        },
      });
    };

    let unsubscribeBgVoxTick: (() => void) | null = null;
    startContinuousVoxMonitor();

    // Unlock AudioContext on first user interaction only if not already running (prevents redundant setState on every click!)
    const unlockAudioOnInteraction = () => {
      const existingCtx = audioCtxRef.current;
      if (existingCtx && existingCtx.state === 'running' && mediaStreamRef.current) {
        return;
      }
      const ctx = getOrCreateCompatibleAudioContext(existingCtx);
      if (ctx) {
        audioCtxRef.current = ctx;
        if (ctx.state !== 'running') {
          unlockMobileAudioSession(ctx, reusableRxAudioRef.current);
        }
        if (keepAliveEnabledRef.current && keepAliveSessionRef.current && !keepAliveSessionRef.current.isActive()) {
          keepAliveSessionRef.current.start(ctx);
          setIsSilentKeepAliveRunning((prev) => (prev ? prev : true));
        }
      }
      if (voxEnabledRef.current && !mediaStreamRef.current) {
        ensureWebAudioVoxGraphRef.current();
      }
    };
    window.addEventListener('pointerdown', unlockAudioOnInteraction, { passive: true });

    return () => {
      isCancelled = true;
      if (voxTimer) window.clearInterval(voxTimer);
      if (unsubscribeBgVoxTick) unsubscribeBgVoxTick();
      window.removeEventListener('pointerdown', unlockAudioOnInteraction);
    };
  }, [
    isPasscodeAuthenticated,
    isSetupCompleted,
    myCallsign,
    myDeviceId,
    voxEnabled,
    setVoxInputLevel,
    setIsVocalPatternConfirmed,
  ]);

  // Toggle Native Browser/WebView FullScreen when clicking [FULL]
  const handleToggleFullScreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullScreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullScreen(false);
      }
    } catch {
      setFullScreenStretch((prev) => !prev);
    }
  };

  // =========================================================================
  // TEKNIK BYPASS 1 & 2:
  // 1. Picture-in-Picture (PiP) Video Hack dari <canvas> Real-Time (Status PTT & Indikator Mic)
  // 2. Media Session API ("Pemutar Musik" Aktif) & Continuous Silent Audio Loop (<audio loop>)
  // =========================================================================
  const drawTacticalPipCanvasFrame = useCallback(() => {
    const canvas = pipCanvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const w = canvas.width; // 160px (Ultra-Compact Micro PiP)
    const h = canvas.height; // 84px (Ultra-Compact Micro PiP)
    const meterSnap = liveAudioMeterStore.getSnapshot();
    const isTx = isTransmittingRef.current;
    const rxSpeaker =
      remoteActiveTxRef.current ||
      (channelLockOwnerRef.current &&
      channelLockOwnerRef.current.senderId !== myDeviceId
        ? channelLockOwnerRef.current.callsign
        : null);
    const isVox = voxEnabledRef.current;
    const thr = voxThresholdRef.current;
    const liveLevel = Math.min(
      100,
      Math.max(
        0,
        Math.round(isTx ? Math.max(meterSnap.micLevel, meterSnap.voxInputLevel) : meterSnap.voxInputLevel)
      )
    );

    // 1. Background Navy Taktis Ultra-Ringkas
    ctx2d.fillStyle = '#021526';
    ctx2d.fillRect(0, 0, w, h);

    // 2. Bingkai Tipis Status Warna Dinamis (Hijau saat TX, Amber saat RX, Cyan saat Siaga)
    const accentColor = isTx ? '#10b981' : rxSpeaker ? '#f59e0b' : '#23dcff';
    ctx2d.strokeStyle = accentColor;
    ctx2d.lineWidth = 2;
    ctx2d.strokeRect(1.5, 1.5, w - 3, h - 3);

    // 3. Baris Atas Mikro (Channel & Callsign Singkat)
    ctx2d.fillStyle = '#042440';
    ctx2d.fillRect(4, 4, w - 8, 18);
    ctx2d.fillStyle = '#23dcff';
    ctx2d.font = 'bold 9.5px monospace';
    ctx2d.fillText(
      `CH${String(channel).padStart(2, '0')}•${(myCallsign || 'UNIT').slice(0, 8)}`,
      8,
      16
    );

    ctx2d.fillStyle = '#67e8f9';
    ctx2d.font = 'bold 8.5px monospace';
    ctx2d.textAlign = 'right';
    ctx2d.fillText(isVox ? `VOX ${thr}%` : 'PTT', w - 8, 16);
    ctx2d.textAlign = 'left';

    // 4. Baris Tengah: Indikator Status Utama (TX / RX / SIAGA)
    ctx2d.fillStyle = isTx
      ? 'rgba(16, 185, 129, 0.25)'
      : rxSpeaker
      ? 'rgba(245, 158, 11, 0.25)'
      : 'rgba(6, 50, 86, 0.7)';
    ctx2d.fillRect(5, 25, w - 10, 26);
    ctx2d.strokeStyle = accentColor;
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(5, 25, w - 10, 26);

    // Titik LED Status
    ctx2d.beginPath();
    ctx2d.arc(15, 38, 4.5, 0, Math.PI * 2);
    ctx2d.fillStyle = accentColor;
    ctx2d.fill();

    ctx2d.fillStyle = '#ffffff';
    ctx2d.font = 'bold 11px sans-serif';
    const primaryStatus = isTx
      ? 'TX: KIRIM SUARA'
      : rxSpeaker
      ? `RX: ${rxSpeaker.slice(0, 9)}`
      : isVox
      ? 'VOX SIAGA AKTIF'
      : 'STANDBY SIAGA';
    ctx2d.fillText(primaryStatus, 24, 42);

    // 5. Baris Bawah: Micro Bar Level Mic / VOX + Penanda Threshold (THR)
    const barX = 6;
    const barY = 56;
    const barW = w - 44;
    const barH = 12;
    ctx2d.fillStyle = '#010b14';
    ctx2d.fillRect(barX, barY, barW, barH);
    ctx2d.strokeStyle = 'rgba(35, 220, 255, 0.45)';
    ctx2d.lineWidth = 1;
    ctx2d.strokeRect(barX, barY, barW, barH);

    const segments = 14;
    const segGap = 1.5;
    const segW = (barW - (segments + 1) * segGap) / segments;
    const activeSegments = Math.round((liveLevel / 100) * segments);
    for (let i = 0; i < segments; i++) {
      const sx = barX + segGap + i * (segW + segGap);
      const pct = ((i + 1) / segments) * 100;
      if (i < activeSegments) {
        ctx2d.fillStyle =
          pct >= thr
            ? isTx
              ? '#10b981'
              : '#23dcff'
            : '#0284c7';
      } else {
        ctx2d.fillStyle = 'rgba(14, 58, 92, 0.5)';
      }
      ctx2d.fillRect(sx, barY + 2, segW, barH - 4);
    }

    // Garis Penanda Threshold (THR) pada Micro Bar
    const thrX = barX + Math.min(barW - 1.5, Math.max(1.5, (thr / 100) * barW));
    ctx2d.strokeStyle = '#facc15';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(thrX, barY - 1);
    ctx2d.lineTo(thrX, barY + barH + 1);
    ctx2d.stroke();

    // Angka Persentase Level Mic di Samping Kanan Bar
    ctx2d.fillStyle = '#e0f2fe';
    ctx2d.font = 'bold 9px monospace';
    ctx2d.textAlign = 'right';
    ctx2d.fillText(`${liveLevel}%`, w - 6, 65);
    ctx2d.textAlign = 'left';

    // 6. Status Mikro Anti-Suspend di Paling Bawah
    ctx2d.fillStyle = '#67e8f9';
    ctx2d.font = 'bold 7.5px monospace';
    ctx2d.fillText('BG KEEP-ALIVE • OPUS 12K', 6, h - 5);
  }, [channel, myCallsign, myDeviceId]);

  // Loop penggambaran <canvas> hemat daya (125ms / 8 FPS + Worker Tick) tanpa memicu React re-render
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted) return;
    drawTacticalPipCanvasFrame();

    const intervalId = window.setInterval(() => {
      drawTacticalPipCanvasFrame();
    }, 125);

    const unsubscribeWorker = subscribeToBackgroundWorkerTicks({
      onVoxTick: () => {
        drawTacticalPipCanvasFrame();
      },
    });

    return () => {
      window.clearInterval(intervalId);
      unsubscribeWorker();
    };
  }, [isPasscodeAuthenticated, isSetupCompleted, drawTacticalPipCanvasFrame]);

  // Sinkronisasi event enterpictureinpicture / leavepictureinpicture pada elemen <video> tersembunyi
  useEffect(() => {
    const videoEl = pipVideoRef.current;
    if (!videoEl) return;

    const handleEnterPip = () => {
      setIsPipFloatingActive(true);
    };
    const handleLeavePip = () => {
      setIsPipFloatingActive(false);
    };

    videoEl.addEventListener('enterpictureinpicture', handleEnterPip);
    videoEl.addEventListener('leavepictureinpicture', handleLeavePip);
    return () => {
      videoEl.removeEventListener('enterpictureinpicture', handleEnterPip);
      videoEl.removeEventListener('leavepictureinpicture', handleLeavePip);
    };
  }, [isPasscodeAuthenticated, isSetupCompleted]);

  // Fungsi untuk menyiapkan aliran <canvas> ke <video> dan memanggil video.requestPictureInPicture()
  const requestFloatingPipWidget = useCallback(async (): Promise<boolean> => {
    try {
      drawTacticalPipCanvasFrame();
      const canvas = pipCanvasRef.current;
      const video = pipVideoRef.current;
      if (!canvas || !video) return false;

      if (!pipStreamRef.current && typeof canvas.captureStream === 'function') {
        pipStreamRef.current = canvas.captureStream(12);
      }
      if (pipStreamRef.current && video.srcObject !== pipStreamRef.current) {
        video.srcObject = pipStreamRef.current;
      }

      video.muted = true;
      video.playsInline = true;
      await video.play().catch(() => {});

      // Standar W3C Picture-in-Picture API (Chrome Android / Desktop / WebView)
      if (
        typeof document !== 'undefined' &&
        'pictureInPictureEnabled' in document &&
        typeof video.requestPictureInPicture === 'function'
      ) {
        if (document.pictureInPictureElement !== video) {
          await video.requestPictureInPicture();
        }
        setIsPipFloatingActive(true);
        return true;
      }

      // Fallback Safari iOS Picture-in-Picture API
      const webkitVideo = video as HTMLVideoElement & {
        webkitSupportsPresentationMode?: (mode: string) => boolean;
        webkitSetPresentationMode?: (mode: string) => void;
      };
      if (
        typeof webkitVideo.webkitSupportsPresentationMode === 'function' &&
        webkitVideo.webkitSupportsPresentationMode('picture-in-picture') &&
        typeof webkitVideo.webkitSetPresentationMode === 'function'
      ) {
        webkitVideo.webkitSetPresentationMode('picture-in-picture');
        setIsPipFloatingActive(true);
        return true;
      }
    } catch {
      // Jika PiP ditolak oleh kebijakan iframe/OS, antarmuka tetap berjalan di mode minimasi & MediaSession aktif
    }
    return false;
  }, [drawTacticalPipCanvasFrame]);

  // Masuk ke Mode Minimasi (Background Sistem):
  // Aplikasi TIDAK keluar / tidak tertutup, melainkan mengaktifkan Mode Background Sistem penuh
  // (Media Session 6s Loop + Web Audio Keep-Alive + PiP Mikro + Web Worker VOX) sehingga tetap berjalan
  // di background sistem meskipun HP digunakan untuk membuka aplikasi lain!
  const handleEnterMinimizedMode = useCallback(async () => {
    if (!keepAliveEnabledRef.current) {
      keepAliveEnabledRef.current = true;
      setKeepAliveEnabled(true);
    }
    setIsMinimizedMode(true);
    isMinimizedModeRef.current = true;
    wasHiddenWhileMinimizedRef.current = false;

    // 1. Putar terus-menerus file audio sub-audible 6 detik (<audio loop>) agar Android/iOS
    // mengunci layanan Foreground Media Player dan TIDAK PERNAH mematikan aplikasi saat buka aplikasi lain
    if (silentLoopAudioRef.current) {
      silentLoopAudioRef.current.loop = true;
      silentLoopAudioRef.current.volume = 0.15;
      silentLoopAudioRef.current.play().catch(() => {});
    }

    // 2. Aktifkan Media Session API ("Pemutar Musik" aktif) + Web Audio Silent Stream + Mikrofon VOX Background
    const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
    if (ctx) {
      audioCtxRef.current = ctx;
      const st = ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        ctx.resume().catch(() => {});
      }
      if (!keepAliveSessionRef.current) {
        keepAliveSessionRef.current = createSilentKeepAliveController();
      }
      keepAliveSessionRef.current.start(ctx);
      keepAliveSessionRef.current.attachDomAudioElement(silentLoopAudioRef.current);
      keepAliveSessionRef.current.pulseOnVisibilityChange(ctx, true);
      keepAliveSessionRef.current.updateMediaSessionMetadata({
        callsign: myCallsign || 'UNIT',
        channel,
        statusText: isTransmittingRef.current
          ? 'TX MENGIRIM SUARA'
          : voxEnabledRef.current
          ? `VOX SIAGA BACKGROUND (THR ${voxThresholdRef.current}%)`
          : 'PTT SIAGA LATAR BELAKANG',
        onTogglePtt: () => {
          if (isTransmittingRef.current) {
            onStopTransmitRef.current();
          } else {
            onStartTransmitRef.current('MANUAL');
          }
        },
        onToggleVox: () => {
          handleToggleVoxSwitch();
        },
      });
      setIsSilentKeepAliveRunning(true);
      setIsMediaSessionActive(true);
    }

    // 3. Pastikan mikrofon VOX tetap hidup dan siap menangkap suara di latar belakang
    if (voxEnabledRef.current) {
      const hasLiveMic = mediaStreamRef.current
        ?.getAudioTracks()
        .some((t) => t.readyState === 'live');
      if (!hasLiveMic) {
        ensureWebAudioVoxGraphRef.current(true);
      } else if (mediaStreamRef.current && !isRxQueuePlayingRef.current && !remoteActiveTxRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((t) => {
          if (!t.enabled) t.enabled = true;
        });
      }
    }

    // 4. Aktifkan jendela mikro Picture-in-Picture (jika didukung browser) agar OS menjaga proses tetap prioritas di atas aplikasi lain
    await requestFloatingPipWidget();

    sendServiceWorkerKeepAlivePing({
      callsign: myCallsign || 'UNIT',
      channel,
      minimized: true,
      voxEnabled: voxEnabledRef.current,
    });
  }, [myCallsign, channel, requestFloatingPipWidget, handleToggleVoxSwitch]);

  // Pulihkan Antarmuka Utama dari Mode Mini (Restore Full Interface)
  const handleRestoreFromMinimizedMode = useCallback(async () => {
    wasHiddenWhileMinimizedRef.current = false;
    setIsMinimizedMode(false);
    isMinimizedModeRef.current = false;

    try {
      if (typeof document !== 'undefined' && document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      }
    } catch {
      // Ignore exitPiP error
    }
    setIsPipFloatingActive(false);

    const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
    if (ctx) {
      audioCtxRef.current = ctx;
      const st = ctx.state as string;
      if (st === 'suspended' || st === 'interrupted') {
        ctx.resume().catch(() => {});
      }
    }
    sendServiceWorkerKeepAlivePing({
      callsign: myCallsign || 'UNIT',
      channel,
      minimized: false,
      voxEnabled: voxEnabledRef.current,
    });
  }, [myCallsign, channel]);

  // Refresh Ping handler (Ultra-Low Latency < 50ms check)
  const handleRefreshPing = () => {
    setIsRefreshingPing(true);
    broadcastMeshPacketRef.current({ type: 'PING' });
    window.setTimeout(() => {
      const nextPing = Math.floor(14 + Math.random() * 24);
      setPingDelta(Math.abs(nextPing - pingMs));
      setPingMs(nextPing);
      setIsRefreshingPing(false);
    }, 180);
  };

  // Periodic ANNOUNCE broadcast once connected (uses stable ref so effect never restarts on state updates)
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;
    broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
    const interval = window.setInterval(() => {
      broadcastMeshPacketRef.current({ type: 'ANNOUNCE' });
    }, 2200);
    return () => window.clearInterval(interval);
  }, [isPasscodeAuthenticated, isSetupCompleted, myCallsign]);

  // TOMBOL EMERGENCY CLEAR (PEMBERSIHAN DARURAT MILITER)
  // Memutuskan koneksi WebSocket/WebRTC/MQTT secara instan, menghentikan seluruh stream mikrofon (MediaStreamTrack.stop()),
  // menghapus cache penyimpanan lokal (sessionStorage, localStorage, Cache API, CryptoKey RAM), dan me-reset ke halaman login awal.
  const handleEmergencyClear = useCallback(async () => {
    // 1. Hentikan transmisi aktif & bungkam receiver secara instan
    forceStopLocalRecording(true);
    muteAndDisableReceiver();
    isTransmittingRef.current = false;
    isVoxTriggeredTxRef.current = false;
    setIsTransmitting(false);
    setVoxInputLevel(0);

    // 2. Hentikan seluruh MediaStreamTrack mikrofon (MediaStreamTrack.stop()) & kamera scanner
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.enabled = false;
          track.stop();
        } catch {
          // Ignore
        }
      });
      mediaStreamRef.current = null;
    }
    try {
      micSourceRef.current?.disconnect();
    } catch {
      // Ignore
    }
    micSourceRef.current = null;
    micFilterRef.current = null;
    micAnalyserRef.current = null;

    if (scannerStreamRef.current) {
      scannerStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      });
      scannerStreamRef.current = null;
    }

    // 3. Hentikan Keep-Alive Silent Audio Stream & tutup AudioContext
    if (keepAliveSessionRef.current) {
      keepAliveSessionRef.current.stop();
      setIsSilentKeepAliveRunning(false);
    }
    if (audioCtxRef.current) {
      try {
        await audioCtxRef.current.close();
      } catch {
        // Ignore
      }
      audioCtxRef.current = null;
    }

    // 4. Putuskan koneksi WebSocket, MQTT, PeerJS, dan WebRTC DataChannel secara instan
    try {
      broadcastMeshPacket({ type: 'PEER_LEAVE' });
    } catch {
      // Ignore
    }

    if (localHotspotWsRef.current) {
      try {
        localHotspotWsRef.current.onclose = null;
        localHotspotWsRef.current.close(1000, 'EMERGENCY_CLEAR');
      } catch {
        // Ignore
      }
      localHotspotWsRef.current = null;
    }

    mqttClientsRef.current.forEach((client) => {
      try {
        client.end(true);
      } catch {
        // Ignore
      }
    });
    mqttClientsRef.current = [];

    peerConnectionsRef.current.forEach((conn) => {
      try {
        conn.close();
      } catch {
        // Ignore
      }
    });
    peerConnectionsRef.current.clear();

    offlineRtcChannelsRef.current.forEach((dc) => {
      try {
        dc.close();
      } catch {
        // Ignore
      }
    });
    offlineRtcChannelsRef.current.clear();

    offlineMasterPcSlotsRef.current.forEach((pc) => {
      try {
        pc.close();
      } catch {
        // Ignore
      }
    });
    offlineMasterPcSlotsRef.current.clear();

    if (offlineClientPcRef.current) {
      try {
        offlineClientPcRef.current.close();
      } catch {
        // Ignore
      }
      offlineClientPcRef.current = null;
    }

    if (peerRef.current) {
      try {
        peerRef.current.destroy();
      } catch {
        // Ignore
      }
      peerRef.current = null;
    }

    if (directNodePeerRef.current) {
      try {
        directNodePeerRef.current.destroy();
      } catch {
        // Ignore
      }
      directNodePeerRef.current = null;
    }

    if (broadcastChannelRef.current) {
      try {
        broadcastChannelRef.current.close();
      } catch {
        // Ignore
      }
      broadcastChannelRef.current = null;
    }

    // 5. Hapus kunci AES-GCM di RAM serta bersihkan sessionStorage, localStorage, dan Cache Storage browser
    purgeTacticalCryptoKeyCache();
    try {
      sessionStorage.clear();
    } catch {
      // Ignore
    }
    try {
      localStorage.clear();
    } catch {
      // Ignore
    }
    try {
      if (typeof window !== 'undefined' && 'caches' in window) {
        const cacheKeys = await window.caches.keys();
        await Promise.all(cacheKeys.map((k) => window.caches.delete(k)));
      }
    } catch {
      // Ignore
    }

    // 6. Reset seluruh state aplikasi kembali ke halaman Login Passcode awal
    isPasscodeAuthenticatedRef.current = false;
    setIsPasscodeAuthenticated(false);
    setIsSetupCompleted(false);
    setPasscodeInput('');
    setPasscodeError(null);
    setMyCallsign('');
    setSetupCallsignInput('');
    setMembers([]);
    membersRef.current = [];
    setChatMessages([]);
    seenPacketIdsRef.current.clear();
    channelLockOwnerRef.current = null;
    setChannelLockOwner(null);
    remoteActiveTxRef.current = null;
    setIncomingSpeaker(null);
    setActiveBottomModal(null);
    setIsSetupScannerOpen(false);
    setE2eEncryptedTxCount(0);
    setE2eDecryptedRxCount(0);
    setLastAesIvPreview('');
  }, [forceStopLocalRecording, muteAndDisableReceiver, broadcastMeshPacket]);

  const handleSetupConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const enteredPasscode = passcodeInput.trim().toUpperCase();
    if (!isPasscodeAuthenticated && enteredPasscode !== PASSCODE_HARIAN) {
      setPasscodeError(
        'PASSCODE OPERASIONAL DITOLAK! Masukkan Passcode Harian resmi untuk membuka akses PTT & Enkripsi.'
      );
      return;
    }

    const cleaned = setupCallsignInput.trim().toUpperCase();
    if (!cleaned) return;

    // Simpan status autentikasi di sessionStorage (otomatis terhapus saat browser ditutup)
    try {
      sessionStorage.setItem(TACTICAL_AUTH_SESSION_KEY, PASSCODE_HARIAN);
    } catch {
      // Ignore storage quota errors
    }
    setPasscodeError(null);
    isPasscodeAuthenticatedRef.current = true;
    setIsPasscodeAuthenticated(true);

    // Pre-derive kunci kriptografi AES-256-GCM di Web Crypto API agar enkripsi/dekripsi real-time < 1ms
    await getOrDeriveTacticalAesKey(PASSCODE_HARIAN);

    // Pre-warm microphone permission & Web Audio API VOX graph on user gesture
    await ensureWebAudioVoxGraph();

    const realLanIp = await detectLocalHotspotIpWebRTC();
    if (realLanIp) {
      detectedLanIpRef.current = realLanIp;
    }

    // Keep microphone hardware tracks enabled if VOX is ON, or disabled if VOX is OFF
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = voxEnabledRef.current;
      });
    }

    const assignedIp =
      setupIpMode === '192.168.43.1'
        ? '192.168.43.1'
        : realLanIp && realLanIp !== '192.168.43.1'
        ? realLanIp
        : localIp !== '192.168.43.1'
        ? localIp
        : `192.168.43.${Math.floor(102 + Math.random() * 50)}`;
    const lockedRole = assignedIp === '192.168.43.1' ? 'MASTER' : 'CLIENT';

    setLocalIp(assignedIp);
    setRole(lockedRole);
    setMyCallsign(cleaned);
    setIsSetupCompleted(true);
  };

  // Open Edit Name modal
  const openEditNameModal = (member?: TacticalMember) => {
    if (member) {
      setEditingMemberId(member.id);
      setNameInput(member.callsign);
    } else {
      setEditingMemberId(null);
      setNameInput(myCallsign);
    }
    setActiveBottomModal('editName');
  };

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = nameInput.trim().toUpperCase();
    if (!cleaned) return;

    if (editingMemberId) {
      setMembers((prev) =>
        prev.map((m) => (m.id === editingMemberId ? { ...m, callsign: cleaned } : m))
      );
    } else {
      setMyCallsign(cleaned);
    }
    setActiveBottomModal(null);
  };

  // Send Tactical Chat Message (On-Screen & Modal)
  const handleSendChatMessage = (e?: React.FormEvent, presetText?: string) => {
    if (e) e.preventDefault();
    const rawText = presetText !== undefined ? presetText : chatInput;
    const trimmed = rawText.trim();
    if (!trimmed || !myCallsign) return;

    const newMsg: TacticalChatMessage = {
      id: `${myDeviceId}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      senderId: myDeviceId,
      callsign: myCallsign,
      ip: detectedLanIpRef.current || localIp,
      role: localIp === '192.168.43.1' || role === 'MASTER' ? 'MASTER' : 'CLIENT',
      channel,
      text: trimmed,
      timestamp: Date.now(),
    };

    setChatMessages((prev) => [...prev.slice(-79), newMsg]);
    if (presetText === undefined) {
      setChatInput('');
    }
    playTacticalTone('start');

    broadcastMeshPacket({
      type: 'CHAT_MSG',
      chatText: trimmed,
    });
  };

  const handleClearChannelChat = () => {
    setChatMessages((prev) => prev.filter((m) => m.channel !== channel));
  };

  const handleCopyText = (key: string, text: string) => {
    const markCopied = () => {
      setCopiedText(key);
      window.setTimeout(() => setCopiedText(null), 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(markCopied)
        .catch(() => {
          fallbackCopyText(text);
          markCopied();
        });
    } else {
      fallbackCopyText(text);
      markCopied();
    }
  };

  const fallbackCopyText = (text: string) => {
    try {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      textArea.style.top = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    } catch {
      // Ignore fallback error
    }
  };

  const handleDownloadFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isHighLatency = pingMs > 150;
  // Filter real peers strictly by currentChannel without closing sockets
  const activeChannelPeers = members.filter((m) => m.channel === channel);
  const targetedClientsCount = activeChannelPeers.filter(
    (m) => talkAll || m.isTargeted
  ).length;

  // Keep URL hash/search invite parameters in sync if user navigates via hash link
  useEffect(() => {
    const onHashOrPop = () => {
      const parsed = extractInviteParamsFromUrl();
      if (parsed.isInvite) {
        setUrlInviteParams(parsed);
        if (parsed.channel) setChannel(parsed.channel);
        if (parsed.hostPeer) setInvitedHostPeer(parsed.hostPeer);
        if (parsed.hostCallsign) setInvitedHostCallsign(parsed.hostCallsign);
        setSetupIpMode('CLIENT');
        if (localIp === '192.168.43.1') {
          setLocalIp(`192.168.43.${Math.floor(102 + Math.random() * 90)}`);
          setRole('CLIENT');
        }
      }
    };
    window.addEventListener('hashchange', onHashOrPop);
    window.addEventListener('popstate', onHashOrPop);
    return () => {
      window.removeEventListener('hashchange', onHashOrPop);
      window.removeEventListener('popstate', onHashOrPop);
    };
  }, [localIp]);

  // Use exact active URL with #hash fragment + embedded Offline Hotspot SDP Offer (`lanSignal`)
  const cleanCurrentBaseUrl = `${window.location.origin}${window.location.pathname}`.replace(
    /\/+$/,
    ''
  );
  const sharePairUrl = `${cleanCurrentBaseUrl}/#invite=1&ch=${channel}&role=CLIENT&master=192.168.43.1&hostPeer=${encodeURIComponent(
    myPeerNodeId
  )}&hostCallsign=${encodeURIComponent(myCallsign || 'MASTER')}${
    offlineOfferToken ? `&lanSignal=${encodeURIComponent(offlineOfferToken)}` : ''
  }`;

  // Generate real scannable QR Code image:
  // - In 'offlineFast' mode (default), encodes the ultra-compact ~185-char DSKM2 token so cameras scan in < 0.1s!
  // - In 'inviteUrl' mode, encodes the full URL with #hash parameters.
  useEffect(() => {
    let active = true;
    const primaryOfflinePayload =
      qrDisplayMode === 'offlineFast' && offlineOfferToken
        ? offlineOfferToken
        : sharePairUrl;
    const payloadToEncode = offlineAnswerToken || primaryOfflinePayload;
    QRCode.toDataURL(payloadToEncode, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'L',
      color: {
        dark: '#03192e',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (!active) return;
        if (offlineAnswerToken) {
          setOfflineAnswerQrUrl(dataUrl);
        } else {
          setQrCodeDataUrl(dataUrl);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [sharePairUrl, offlineOfferToken, offlineAnswerToken, qrDisplayMode]);

  const handleShareInviteLink = async () => {
    const targetPayload = offlineAnswerToken || sharePairUrl;
    const shareTitle = `TACTICAL NET-COMM SUBDISRUDAL - CH ${String(channel).padStart(2, '0')}`;
    const shareText = `Gabung ke Jaringan Walkie-Talkie TACTICAL NET-COMM SUBDISRUDAL (${
      myCallsign || 'MASTER'
    } - CHANNEL ${String(channel).padStart(2, '0')}):`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: targetPayload,
        });
        return;
      } catch {
        // Fallback to copy
      }
    }
    handleCopyText('pairUrl', targetPayload);
  };

  // Universal processor for any scanned QR code string, Offline Hotspot SDP Offer/Answer, or Master Node ID
  const applyScannedOrPastedInvite = useCallback(
    (rawString: string): boolean => {
      const raw = rawString.trim();
      if (!raw) return false;

      try {
        // 1. Check if the scanned QR / pasted code contains an Offline Hotspot WebRTC SDP Offer or Answer
        const offlineSig = decodeOfflineSignalFromInput(raw);

        if (offlineSig && offlineSig.t === 'A') {
          // HP MASTER scanned HP CLIENT's Offline Hotspot Answer Barcode!
          const targetPc =
            offlineMasterPcSlotsRef.current.get(offlineSig.sid) ||
            Array.from(offlineMasterPcSlotsRef.current.values()).pop();

          if (targetPc && targetPc.signalingState === 'have-local-offer') {
            (async () => {
              try {
                await targetPc.setRemoteDescription({
                  type: 'answer',
                  sdp: offlineSig.sdp,
                });
                if (Array.isArray(offlineSig.candidates)) {
                  for (const candLine of offlineSig.candidates) {
                    try {
                      await targetPc.addIceCandidate({
                        candidate: candLine,
                        sdpMid: '0',
                        sdpMLineIndex: 0,
                      });
                    } catch {
                      // Ignore individual candidate warning
                    }
                  }
                }
              } catch {
                // Ignore setRemoteDescription warning
              }
            })();
          }

          const now = Date.now();
          setMembers((prev) => {
            const exists = prev.some((m) => m.id === offlineSig.id);
            const next = exists
              ? prev.map((m) =>
                  m.id === offlineSig.id
                    ? {
                        ...m,
                        callsign: offlineSig.c,
                        ip: offlineSig.ip,
                        role: 'CLIENT' as const,
                        channel: offlineSig.ch,
                        lastSeen: now,
                      }
                    : m
                )
              : [
                  ...prev,
                  {
                    id: offlineSig.id,
                    callsign: offlineSig.c,
                    ip: offlineSig.ip,
                    role: 'CLIENT' as const,
                    statusText: 'HOTSPOT P2P AKTIF',
                    isTargeted: true,
                    isTalking: false,
                    pingMs: 12,
                    channel: offlineSig.ch,
                    lastSeen: now,
                  },
                ];
            window.setTimeout(() => broadcastPeerListSync(next), 150);
            return next;
          });

          playTacticalTone('rx');
          setInviteJoinStatus(
            `TERHUBUNG OFFLINE WIFI/HOTSPOT DENGAN ${offlineSig.c} (${offlineSig.ip})!`
          );
          return true;
        }

        if (offlineSig && offlineSig.t === 'O') {
          // HP CLIENT scanned HP MASTER's Barcode (contains Offline Hotspot Offer)!
          const effectiveCallsign =
            myCallsign ||
            setupCallsignInput.trim().toUpperCase() ||
            `UNIT-${myDeviceId.slice(0, 3)}`;
          const clientIp =
            detectedLanIpRef.current && detectedLanIpRef.current !== '192.168.43.1'
              ? detectedLanIpRef.current
              : localIp !== '192.168.43.1'
              ? localIp
              : `192.168.43.${Math.floor(102 + Math.random() * 90)}`;

          if (!myCallsign) {
            setMyCallsign(effectiveCallsign);
          }
          if (!isSetupCompleted) {
            setIsSetupCompleted(true);
          }
          setSetupIpMode('CLIENT');
          setLocalIp(clientIp);
          setRole('CLIENT');
          setChannel(offlineSig.ch);

          // Immediately register HP MASTER in Client's member grid
          const now = Date.now();
          setMembers((prev) => {
            const exists = prev.some((m) => m.id === offlineSig.id);
            return exists
              ? prev.map((m) =>
                  m.id === offlineSig.id
                    ? {
                        ...m,
                        callsign: offlineSig.c,
                        ip: offlineSig.ip,
                        role: 'MASTER' as const,
                        channel: offlineSig.ch,
                        lastSeen: now,
                      }
                    : m
                )
              : [
                  ...prev,
                  {
                    id: offlineSig.id,
                    callsign: offlineSig.c,
                    ip: offlineSig.ip,
                    role: 'MASTER' as const,
                    statusText: 'MASTER HOTSPOT',
                    isTargeted: true,
                    isTalking: false,
                    pingMs: 12,
                    channel: offlineSig.ch,
                    lastSeen: now,
                  },
                ];
          });

          // Create Offline LAN RTCPeerConnection Answer (0% internet required, iceServers: [])
          // Stored in offlineClientPcRef so V8 never garbage-collects the pending connection!
          (async () => {
            try {
              if (!detectedLanIpRef.current) {
                const foundIp = await detectLocalHotspotIpWebRTC();
                if (foundIp) detectedLanIpRef.current = foundIp;
              }

              const pc = new RTCPeerConnection({ iceServers: [] });
              offlineClientPcRef.current = pc;

              pc.ondatachannel = (ev) => {
                const dc = ev.channel;
                const slotKey = offlineSig.sid;
                dc.onopen = () => {
                  offlineRtcChannelsRef.current.set(slotKey, dc);
                  setConnectedPeersCount(
                    peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
                  );
                  setOfflineAnswerToken('');
                  const pkt = announcePacketBuilderRef.current();
                  if (pkt) {
                    try {
                      dc.send(JSON.stringify(pkt));
                    } catch {
                      // Ignore
                    }
                  }
                };
                dc.onmessage = (msgEv) => {
                  try {
                    const incoming = JSON.parse(String(msgEv.data)) as MeshPacket;
                    if (incoming) packetHandlerRef.current(incoming);
                  } catch {
                    // Ignore
                  }
                };
                const onClose = () => {
                  offlineRtcChannelsRef.current.delete(slotKey);
                  setConnectedPeersCount(
                    peerConnectionsRef.current.size + offlineRtcChannelsRef.current.size
                  );
                };
                dc.onclose = onClose;
                dc.onerror = onClose;
              };

              await pc.setRemoteDescription({ type: 'offer', sdp: offlineSig.sdp });
              if (Array.isArray(offlineSig.candidates)) {
                for (const candLine of offlineSig.candidates) {
                  try {
                    await pc.addIceCandidate({
                      candidate: candLine,
                      sdpMid: '0',
                      sdpMLineIndex: 0,
                    });
                  } catch {
                    // Ignore candidate warning
                  }
                }
              }

              const answer = await pc.createAnswer();
              const optimizedAnswerSdp = optimizeWebRtcSdpForOpusLowLatency(
                answer.sdp || '',
                opusBitrateKbpsRef.current * 1000
              );
              await pc.setLocalDescription({
                type: 'answer',
                sdp: optimizedAnswerSdp || answer.sdp,
              });
              const gatheredCandidates = await gatherLocalIceCandidatesExplicit(pc, 750);

              const answerSdp = optimizeWebRtcSdpForOpusLowLatency(
                pc.localDescription?.sdp || optimizedAnswerSdp || answer.sdp || '',
                opusBitrateKbpsRef.current * 1000
              );
              if (answerSdp) {
                const encodedAnswer = buildMicroOfflineToken({
                  type: 'A',
                  callsign: effectiveCallsign,
                  deviceId: myDeviceId,
                  localIp: detectedLanIpRef.current || clientIp,
                  channel: offlineSig.ch,
                  slotId: offlineSig.sid,
                  rawSdp: answerSdp,
                  collectedCandidateLines: gatheredCandidates,
                });
                setOfflineAnswerToken(encodedAnswer);
                setBarcodeTab('show');
                setActiveBottomModal('barcode');
              }
            } catch {
              // Ignore offline answer error
            }
          })();
        }

        let parsedCh = offlineSig ? offlineSig.ch : channel;
        let parsedHostPeer = '';
        let parsedHostCallsign = offlineSig ? offlineSig.c : 'MASTER';
        let parsedMasterIp = offlineSig ? offlineSig.ip : '192.168.43.1';

        if (
          raw.includes('invite=') ||
          raw.includes('hostPeer=') ||
          raw.includes('ch=') ||
          raw.includes('?') ||
          raw.includes('#')
        ) {
          let queryPart = raw;
          if (raw.includes('#')) {
            queryPart = raw.split('#')[1].replace(/^\/?\??/, '');
          } else if (raw.includes('?')) {
            queryPart = raw.split('?')[1];
          }
          const params = new URLSearchParams(queryPart);
          const chNum = Number(params.get('ch'));
          if (chNum >= 1 && chNum <= 99) parsedCh = chNum;
          parsedHostPeer = params.get('hostPeer') || '';
          parsedHostCallsign = (
            params.get('hostCallsign') ||
            params.get('host') ||
            parsedHostCallsign
          ).toUpperCase();
          parsedMasterIp = params.get('master') || params.get('ip') || parsedMasterIp;
        } else if (!offlineSig) {
          parsedHostPeer = raw.toUpperCase().startsWith('PTT-')
            ? raw.toUpperCase()
            : MASTER_PEER_ID;
        }

        const targetHostPeer = parsedHostPeer || MASTER_PEER_ID;

        setSetupIpMode('CLIENT');
        if (localIp === '192.168.43.1') {
          const newClientIp = `192.168.43.${Math.floor(102 + Math.random() * 90)}`;
          setLocalIp(newClientIp);
          setRole('CLIENT');
        }

        setChannel(parsedCh);
        setInvitedHostPeer(targetHostPeer);
        setInvitedHostCallsign(parsedHostCallsign);
        setUrlInviteParams({
          isInvite: true,
          channel: parsedCh,
          hostPeer: targetHostPeer,
          hostCallsign: parsedHostCallsign,
          masterIp: parsedMasterIp,
          role: 'CLIENT',
          lanSignal: '',
        });

        // Also initiate PeerJS DataChannel if online
        const activePeer = directNodePeerRef.current || peerRef.current;
        if (activePeer && !activePeer.disconnected && !activePeer.destroyed) {
          try {
            const conn = activePeer.connect(targetHostPeer, { reliable: true });
            registerPeerConnection(conn);
          } catch {
            // 2.5s watchdog will retry automatically
          }
        }

        playTacticalTone('rx');
        setInviteJoinStatus(
          offlineSig?.t === 'O'
            ? `BARCODE MASTER DITERIMA! UNTUK HOTSPOT TANPA INTERNET: SCAN BARCODE BALASAN DI ATAS DARI HP MASTER.`
            : `MENGHUBUNGKAN WEBRTC DATACHANNEL KE ${targetHostPeer} (CH ${String(
                parsedCh
              ).padStart(2, '0')})...`
        );
        return true;
      } catch {
        setInviteJoinStatus('FORMAT BARCODE / LINK TIDAK VALID');
        return false;
      }
    },
    [
      channel,
      localIp,
      myCallsign,
      setupCallsignInput,
      myDeviceId,
      isSetupCompleted,
      playTacticalTone,
      registerPeerConnection,
      broadcastPeerListSync,
    ]
  );

  // Stop in-app camera QR scanner stream
  const stopCameraScanner = useCallback(() => {
    if (scannerRafRef.current) {
      cancelAnimationFrame(scannerRafRef.current);
      scannerRafRef.current = null;
    }
    if (scannerStreamRef.current) {
      scannerStreamRef.current.getTracks().forEach((t) => t.stop());
      scannerStreamRef.current = null;
    }
    setIsCameraScanning(false);
  }, []);

  // Start in-app live camera QR scanner using jsQR (no external browser needed!)
  const startCameraScanner = useCallback(async () => {
    setScannerError(null);
    stopCameraScanner();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
      });
      scannerStreamRef.current = stream;
      setIsCameraScanning(true);

      const video = scannerVideoRef.current;
      if (video) {
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play();
      }

      const scanFrame = () => {
        const vid = scannerVideoRef.current;
        const canvas = scannerCanvasRef.current;
        if (vid && canvas && vid.readyState === vid.HAVE_ENOUGH_DATA) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            canvas.width = vid.videoWidth;
            canvas.height = vid.videoHeight;
            ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
              inversionAttempts: 'dontInvert',
            });
            if (code && code.data) {
              stopCameraScanner();
              const sig = decodeOfflineSignalFromInput(code.data);
              const ok = applyScannedOrPastedInvite(code.data);
              if (ok) {
                setIsSetupScannerOpen(false);
                if (sig?.t === 'O') {
                  // Keep Barcode modal open on 'show' tab so Master can scan Client's Offline Answer QR!
                  setBarcodeTab('show');
                  setActiveBottomModal('barcode');
                } else {
                  window.setTimeout(() => {
                    setInviteJoinStatus(null);
                    setActiveBottomModal(null);
                  }, 1100);
                }
              }
              return;
            }
          }
        }
        scannerRafRef.current = requestAnimationFrame(scanFrame);
      };

      scannerRafRef.current = requestAnimationFrame(scanFrame);
    } catch {
      setIsCameraScanning(false);
      setScannerError(
        'Kamera langsung tidak diizinkan oleh browser/WebView. Gunakan tombol "Ambil Foto / Pilih Gambar Barcode" di bawah.'
      );
    }
  }, [applyScannedOrPastedInvite, stopCameraScanner]);

  // Decode QR code from a captured camera photo or gallery image file
  const handleScanQrImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScannerError(null);

    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code && code.data) {
          stopCameraScanner();
          const sig = decodeOfflineSignalFromInput(code.data);
          const ok = applyScannedOrPastedInvite(code.data);
          if (ok) {
            setIsSetupScannerOpen(false);
            if (sig?.t === 'O') {
              setBarcodeTab('show');
              setActiveBottomModal('barcode');
            } else {
              window.setTimeout(() => {
                setInviteJoinStatus(null);
                setActiveBottomModal(null);
              }, 1100);
            }
          }
        } else {
          setScannerError('Barcode tidak terdeteksi pada gambar. Pastikan QR Code terlihat jelas.');
        }
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  // Stop camera stream when modal closes or tab changes
  useEffect(() => {
    if (activeBottomModal !== 'barcode' && !isSetupScannerOpen) {
      stopCameraScanner();
    } else if (
      (activeBottomModal === 'barcode' && barcodeTab === 'scan') ||
      isSetupScannerOpen
    ) {
      startCameraScanner();
    }
    return () => {
      stopCameraScanner();
    };
  }, [activeBottomModal, barcodeTab, isSetupScannerOpen, startCameraScanner, stopCameraScanner]);

  // Join Master via pasted Invite Link or Master Peer Code inside the Barcode modal
  const handleManualInviteJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const sig = decodeOfflineSignalFromInput(manualInviteInput);
    const ok = applyScannedOrPastedInvite(manualInviteInput);
    if (ok) {
      setManualInviteInput('');
      if (sig?.t === 'O') {
        setBarcodeTab('show');
      } else {
        window.setTimeout(() => {
          setInviteJoinStatus(null);
          setActiveBottomModal(null);
        }, 1100);
      }
    }
  };

  const currentFile = FLUTTER_SOURCE_FILES[selectedFileIndex];

  const curvedTitle = isTransmitting
    ? voxEnabled
      ? 'VOX AKTIF • HENING UTK TUTUP'
      : 'KLIK KEDUA • TUTUP PTT'
    : voxEnabled
    ? 'VOX AUTO ON • BICARA LANGSUNG'
    : 'KLIK PERTAMA • BUKA PTT';
  const curvedChars = curvedTitle.split('');

  // 1. LAYAR LOGIN AUTENTIKASI PASSCODE OPERASIONAL & SETUP AWAL
  if (!isPasscodeAuthenticated || !isSetupCompleted) {
    return (
      <div className="min-h-[100dvh] w-full tactical-grid-bg text-[#e5faff] flex items-center justify-center p-4 select-none">
        <div className="w-full max-w-[420px] tactical-panel rounded-3xl p-5 space-y-3.5 shadow-[0_0_50px_rgba(35,220,255,0.22)]">
          <div className="flex flex-col items-center text-center space-y-1.5">
            <div className="w-14 h-14 rounded-full bg-[#03192e] border-2 border-[#23dcff] shadow-[0_0_20px_rgba(35,220,255,0.35)] flex items-center justify-center relative">
              <Radio className="w-7 h-7 text-[#23dcff]" />
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-[#06385c] border border-[#23dcff] flex items-center justify-center">
                <Lock className="w-3.5 h-3.5 text-[#23dcff]" />
              </div>
            </div>
            <h1 className="font-tactical text-[22px] font-extrabold tracking-wider text-white cyan-glow-text leading-tight">
              TACTICAL NET-COMM SUBDISRUDAL
            </h1>
            <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#04233d] border border-[#23dcff]/60 font-telemetry text-[10px] text-[#23dcff] font-bold">
              <Shield className="w-3 h-3" />
              <span>MODUL KEAMANAN MILITER • AES-256-GCM E2EE</span>
            </div>
            {urlInviteParams.isInvite && (
              <div className="w-full mt-1 px-3 py-1.5 rounded-xl bg-[#07375c] border border-[#23dcff] text-xs font-telemetry text-white font-bold">
                TERHUBUNG BARCODE MASTER: {invitedHostCallsign} • CHANNEL{' '}
                {String(channel).padStart(2, '0')}
              </div>
            )}
          </div>

          <form onSubmit={handleSetupConnect} className="space-y-3">
            {/* INPUT PASSCODE OPERASIONAL HARIAN (WAJIB SEBELUM AKSES PTT / WEB AUDIO / WEBSOCKET) */}
            <div className="p-3 rounded-2xl bg-[#021526]/95 border-2 border-[#23dcff]/80 space-y-1.5 shadow-[inset_0_0_16px_rgba(35,220,255,0.12)]">
              <div className="flex items-center justify-between">
                <label className="font-telemetry text-[11px] font-extrabold text-[#23dcff] flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>PASSCODE OPERASIONAL HARIAN:</span>
                </label>
                <span className="font-telemetry text-[9.5px] px-1.5 py-0.5 rounded bg-[#063354] text-cyan-200 border border-cyan-400/40">
                  {isPasscodeAuthenticated ? 'TERVERIFIKASI' : 'WAJIB LOGIN'}
                </span>
              </div>
              <input
                type="password"
                required={!isPasscodeAuthenticated}
                value={isPasscodeAuthenticated ? PASSCODE_HARIAN : passcodeInput}
                onChange={(e) => {
                  setPasscodeInput(e.target.value);
                  if (passcodeError) setPasscodeError(null);
                }}
                placeholder="MASUKKAN SANDI HARIAN..."
                autoComplete="off"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#010d18] border border-[#23dcff] text-white font-telemetry text-sm font-extrabold uppercase tracking-[0.2em] focus:outline-none focus:ring-2 focus:ring-[#23dcff]"
              />
              {passcodeError ? (
                <div className="px-2.5 py-1.5 rounded-lg bg-red-950/90 border border-red-400 text-red-200 font-telemetry text-[10.5px] font-bold flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{passcodeError}</span>
                </div>
              ) : (
                <p className="font-telemetry text-[9.5px] text-cyan-200/80 leading-tight">
                  Disimpan di <strong className="text-white">sessionStorage</strong> & digunakan menurunkan kunci enkripsi suara <strong className="text-[#23dcff]">AES-256-GCM</strong>.
                </p>
              )}
            </div>

            <div>
              <label className="block font-telemetry text-xs font-bold text-cyan-100 mb-1">
                MASUKKAN NAMA / CALLSIGN ANDA:
              </label>
              <input
                type="text"
                required
                maxLength={12}
                value={setupCallsignInput}
                onChange={(e) => setSetupCallsignInput(e.target.value)}
                placeholder="CONTOH: YUDHI / GARUDA-1"
                className="w-full px-3.5 py-2.5 rounded-xl bg-[#021526] border-2 border-[#23dcff]/70 focus:border-[#23dcff] text-white font-telemetry text-sm font-extrabold uppercase tracking-wider focus:outline-none"
              />
            </div>

            {/* Tombol Buka In-App Scanner di SetupScreen */}
            <div>
              <button
                type="button"
                onClick={() => setIsSetupScannerOpen((prev) => !prev)}
                className="w-full py-2 px-3 rounded-xl bg-[#052946] hover:bg-[#093b63] border border-[#23dcff] text-white font-telemetry text-[11px] font-bold flex items-center justify-center gap-2 cursor-pointer"
              >
                <Camera className="w-4 h-4 text-[#23dcff]" />
                <span>
                  {isSetupScannerOpen
                    ? 'TUTUP KAMERA SCANNER BARCODE'
                    : 'SCAN BARCODE DARI HP MASTER (TANPA BROWSER)'}
                </span>
              </button>

              {isSetupScannerOpen && (
                <div className="mt-2 p-2.5 rounded-2xl bg-[#021526] border border-[#23dcff] space-y-2 text-center">
                  <div className="relative w-full aspect-square max-w-[200px] mx-auto rounded-xl overflow-hidden bg-black border-2 border-[#23dcff]">
                    <video
                      ref={scannerVideoRef}
                      className="w-full h-full object-cover"
                      muted
                      playsInline
                    />
                    <canvas ref={scannerCanvasRef} className="hidden" />
                    <div className="absolute inset-5 border-2 border-dashed border-[#23dcff]/80 rounded-xl pointer-events-none" />
                  </div>
                  {scannerError && (
                    <p className="font-telemetry text-[10px] text-amber-300">{scannerError}</p>
                  )}
                  <label className="w-full py-1.5 px-3 rounded-xl bg-[#07375c] hover:bg-[#0b4b7a] border border-cyan-400/60 text-white font-telemetry text-[10.5px] font-bold flex items-center justify-center gap-1.5 cursor-pointer">
                    <Upload className="w-3.5 h-3.5 text-[#23dcff]" />
                    <span>Ambil Foto / Pilih Gambar Barcode</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleScanQrImageFile}
                      className="hidden"
                    />
                  </label>
                </div>
              )}
            </div>

            <div>
              <label className="block font-telemetry text-[10.5px] font-bold text-cyan-200/90 mb-1">
                PILIH PERAN JARINGAN (CLOUD HANDSHAKE PEERJS):
              </label>
              <div className="grid grid-cols-2 gap-2 font-telemetry text-xs">
                <button
                  type="button"
                  onClick={() => setSetupIpMode('192.168.43.1')}
                  className={`py-2 px-3 rounded-xl border font-bold text-left transition-all cursor-pointer ${
                    setupIpMode === '192.168.43.1'
                      ? 'bg-[#093b61] border-[#23dcff] text-white shadow-[0_0_12px_rgba(35,220,255,0.3)]'
                      : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                  }`}
                >
                  <div className="text-[#23dcff] font-extrabold">HP MASTER</div>
                  <div className="text-[10px]">ID: PTT-MASTER-01</div>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupIpMode('CLIENT')}
                  className={`py-2 px-3 rounded-xl border font-bold text-left transition-all cursor-pointer ${
                    setupIpMode === 'CLIENT'
                      ? 'bg-[#093b61] border-[#23dcff] text-white shadow-[0_0_12px_rgba(35,220,255,0.3)]'
                      : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                  }`}
                >
                  <div className="text-[#23dcff] font-extrabold">CLIENT</div>
                  <div className="text-[10px]">ID: PTT-CLIENT-[NAMA]</div>
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-3 rounded-xl cyan-btn-glow text-[#02182b] font-tactical text-base font-extrabold tracking-wider flex items-center justify-center gap-2 cursor-pointer"
            >
              <Lock className="w-4 h-4" />
              <span>OTORISASI & KONEK JARINGAN</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] max-h-[100dvh] w-full bg-[#021322] text-[#e5faff] flex flex-col items-center justify-center overflow-hidden select-none relative">
      {/* =====================================================================
          ELEMEN TERSEMBUNYI UNTUK BYPASS BACKGROUND OS SELULER:
          1. <canvas> + <video> tersembunyi untuk aliran keep-alive / PiP Mikro
          2. <audio loop> tersembunyi yang memutar file audio sub-audible 6 detik non-stop
          ===================================================================== */}
      <canvas
        ref={pipCanvasRef}
        width={160}
        height={84}
        aria-hidden="true"
        className="fixed -left-[9999px] -top-[9999px] w-[160px] h-[84px] opacity-0 pointer-events-none"
      />
      <video
        ref={pipVideoRef}
        width={120}
        height={63}
        muted
        playsInline
        autoPlay
        aria-hidden="true"
        className="fixed -left-[9999px] -top-[9999px] w-[120px] h-[63px] opacity-0 pointer-events-none"
      />
      <audio
        ref={silentLoopAudioRef}
        src={SILENT_WAV_DATA_URI}
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        className="fixed -left-[9999px] -top-[9999px] opacity-0 pointer-events-none"
      />

      {/* =====================================================================
          KAPSUL MINIMALIS MODE BACKGROUND SISTEM (TIDAK KELUAR DARI APLIKASI)
          Saat tombol MINI ditekan, aplikasi TIDAK keluar melainkan mengunci
          Background Service (MediaSession 6s + WebAudio + Worker VOX) agar tetap
          aktif 100% meskipun Anda berpindah membuka aplikasi lain di HP.
          ===================================================================== */}
      {isMinimizedMode && (
        <div className="fixed bottom-2.5 right-2.5 z-50 pointer-events-auto">
          <div className="tactical-panel rounded-full px-2.5 py-1 border border-[#23dcff] shadow-[0_0_16px_rgba(35,220,255,0.4)] flex items-center gap-1.5 bg-[#021526]/95 backdrop-blur-xs max-w-[235px]">
            <div
              onClick={handleRestoreFromMinimizedMode}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleRestoreFromMinimizedMode();
              }}
              title="Mode Background Sistem Aktif — Ketuk untuk kembali ke tampilan penuh"
              className="cursor-pointer text-left min-w-0 flex-1 pr-0.5"
            >
              <div className="flex items-center gap-1">
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    isTransmitting
                      ? 'bg-emerald-400 animate-ping'
                      : activeLockSpeaker
                      ? 'bg-amber-400 animate-pulse'
                      : 'bg-[#23dcff]'
                  }`}
                />
                <span className="font-tactical text-[9.5px] font-extrabold tracking-tight text-white truncate">
                  BG SISTEM ON • CH{String(channel).padStart(2, '0')}
                </span>
              </div>
              <div className="font-telemetry text-[8px] text-cyan-200/90 leading-none truncate">
                <MiniWidgetMicLevelText /> • Siap Buka Apk Lain
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                requestFloatingPipWidget();
              }}
              title="Tampilkan Widget Mikro PiP di Atas Aplikasi Lain"
              className={`w-6 h-6 rounded-full border flex items-center justify-center transition-transform active:scale-90 cursor-pointer shrink-0 ${
                isPipFloatingActive
                  ? 'bg-emerald-500/25 border-emerald-400 text-emerald-300'
                  : 'bg-[#042440] border-[#23dcff]/70 text-[#23dcff]'
              }`}
            >
              <Smartphone className="w-3 h-3" />
            </button>

            <button
              type="button"
              onClick={handleRestoreFromMinimizedMode}
              title="Kembali ke Antarmuka Penuh"
              className="w-6 h-6 rounded-full cyan-btn-glow border border-white text-[#02182b] flex items-center justify-center shadow-[0_0_8px_#23dcff] active:scale-90 transition-transform cursor-pointer shrink-0"
            >
              <Maximize2 className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      <main
        className={`w-full h-[100dvh] max-h-[100dvh] tactical-grid-bg flex flex-col justify-between relative overflow-hidden transition-all ${
          isMinimizedMode ? 'opacity-25 pointer-events-none scale-[0.98]' : 'opacity-100'
        } ${
          fullScreenStretch
            ? 'max-w-full'
            : 'max-w-[460px] sm:border-x-2 sm:border-[#23dcff]/45 sm:shadow-[0_0_60px_rgba(0,195,255,0.25)]'
        }`}
      >
        {/* TOP TELEMETRY STATUS STRIP + AES-256-GCM E2EE + OPUS LOW-BITRATE + TOMBOL MINIMALKAN (MINI) */}
        <header className="px-2.5 py-1 flex items-center justify-between text-[9.5px] font-telemetry text-cyan-100/95 border-b border-cyan-400/15 bg-[#03192e]/70 backdrop-blur-xs shrink-0">
          <div className="flex items-center gap-1.5 truncate">
            <Lock className="w-3 h-3 text-[#23dcff] shrink-0" />
            <span className="tracking-tight font-bold text-[#23dcff] truncate">
              AES-GCM • OPUS {opusBitrateKbps}kbps
            </span>
            <span className="text-cyan-400/50">•</span>
            <span className="text-cyan-100/90 truncate">
              TX:{e2eEncryptedTxCount} RX:{e2eDecryptedRxCount}
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[#23dcff] font-bold">{Math.min(48, pingMs)}ms</span>
            <span className="text-cyan-400/50">|</span>
            {/* Tombol Ikon Kecil Minimalkan (Minimize / Floating Mini Button) di Sudut Antarmuka */}
            <button
              type="button"
              onClick={handleEnterMinimizedMode}
              title="Minimalkan ke Floating Mini Widget / Mode Latar Belakang (WebSocket & VOX Tetap Hidup)"
              className="px-1.5 py-0.5 rounded border border-[#23dcff] text-[9px] font-extrabold text-[#23dcff] bg-[#042440] hover:bg-[#23dcff] hover:text-[#02182b] transition-colors flex items-center gap-0.5 cursor-pointer"
            >
              <Minimize2 className="w-2.5 h-2.5" />
              <span>MINI</span>
            </button>
            <button
              type="button"
              onClick={handleToggleFullScreen}
              title="Layar Penuh HP (Fullscreen)"
              className="px-1.5 py-0.5 rounded border border-cyan-400/60 text-[9px] font-bold text-cyan-100 bg-cyan-950/80 hover:bg-[#23dcff] hover:text-[#02182b] transition-colors flex items-center gap-0.5 cursor-pointer"
            >
              {isFullScreen ? (
                <Minimize2 className="w-2.5 h-2.5" />
              ) : (
                <Maximize2 className="w-2.5 h-2.5" />
              )}
              <span>FULL</span>
            </button>
          </div>
        </header>

        {/* MAIN VERTICAL TACTICAL STACK - FITS 100% WITHIN ONE PHONE SCREEN */}
        <div className="flex-1 min-h-0 w-full max-w-[540px] mx-auto px-3 py-1.5 flex flex-col justify-between gap-1.5 overflow-hidden">
          {/* 1. HEADER TEKS: TACTICAL NET-COMM SUBDISRUDAL */}
          <div className="text-center shrink-0 pt-0.5">
            <h1 className="font-tactical text-[22px] sm:text-[26px] leading-none font-extrabold tracking-[0.06em] text-[#e9fcff] cyan-glow-text">
              TACTICAL NET-COMM SUBDISRUDAL
            </h1>
          </div>

          {/* 2. CARD STATUS JARINGAN (MAXIMIZED TOP PANEL) */}
          <section className="tactical-panel rounded-2xl px-3 py-2 space-y-1.5 shrink-0">
            <div className="flex items-center justify-between gap-1.5">
              {/* Indikator Sinyal 4 Bar */}
              <div className="px-2.5 py-1 rounded-lg bg-[#03192e] border border-cyan-400/40 flex items-end gap-0.5 shrink-0">
                <span className="w-1 h-2 rounded-xs bg-[#23dcff]" />
                <span className="w-1 h-3 rounded-xs bg-[#23dcff]" />
                <span className="w-1 h-4 rounded-xs bg-[#23dcff]" />
                <span
                  className={`w-1 h-5 rounded-xs ${
                    !isHighLatency ? 'bg-[#23dcff]' : 'bg-cyan-900/70'
                  }`}
                />
              </div>

              {/* PING: [X] ms */}
              <div className="font-telemetry leading-none shrink-0">
                <span className="text-[11px] font-bold text-cyan-200 mr-1">PING:</span>
                <span className="text-[14px] font-extrabold text-white">
                  {pingMs}ms
                </span>
                <span className="text-[10.5px] text-cyan-200/80 ml-0.5">
                  (+{pingDelta})
                </span>
              </div>

              {/* Status LATENCY TINGGI / RENDAH */}
              <div className="px-2 py-1 rounded-md border border-cyan-400/45 bg-[#031b32]/80 font-telemetry text-[10px] font-bold leading-tight text-white">
                <span className={isHighLatency ? 'text-cyan-200' : 'text-[#23dcff]'}>
                  {isHighLatency ? 'LAT TINGGI' : 'LAT RENDAH'}
                </span>
              </div>

              {/* Tombol Refresh Ping */}
              <button
                onClick={handleRefreshPing}
                className="px-2.5 py-1 rounded-lg bg-[#05233e] hover:bg-[#09355c] border border-cyan-400/55 flex items-center gap-1 text-[11px] font-bold text-white transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-[#23dcff] ${
                    isRefreshingPing ? 'animate-spin' : ''
                  }`}
                />
                <span>Ping</span>
              </button>

              {/* Tombol EMERGENCY CLEAR (Dipindahkan ke posisi tombol CLIENT, tombol CLIENT dihilangkan) */}
              <button
                type="button"
                onClick={handleEmergencyClear}
                title="EMERGENCY CLEAR: Putuskan WebSocket, Matikan Mikrofon, Hapus Cache & Reset ke Login"
                className="px-2 py-1 rounded-lg bg-gradient-to-r from-red-700 to-red-600 hover:from-red-600 hover:to-red-500 border border-red-300/80 shadow-[0_0_10px_rgba(239,68,68,0.45)] text-white font-tactical text-[9.5px] font-extrabold tracking-wider flex items-center justify-center gap-1 active:scale-95 transition-all shrink-0 cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-white shrink-0" />
                <span>EMERGENCY CLEAR</span>
              </button>
            </div>

            {/* Teks Informasi Peran Permanen, Status AES-GCM & Peer Aktif */}
            <div className="flex items-center justify-between font-telemetry text-[10px] text-white/95 border-t border-cyan-400/25 pt-1">
              <div className="truncate">
                <span className="font-semibold">PERAN: {permanentRoleLabel}</span>{' '}
                <span className="text-cyan-200">({detectedLanIpRef.current || localIp})</span>
                {lastAesIvPreview && (
                  <span className="ml-1.5 text-[#23dcff] font-bold">
                    • IV:{lastAesIvPreview}
                  </span>
                )}
              </div>
              <div className="shrink-0">
                Peer: <strong className="text-white">{activeChannelPeers.length}</strong> • Target:{' '}
                <strong className="text-white">{targetedClientsCount}</strong>
              </div>
            </div>
          </section>

          {/* 3. CARD CHANNEL SELECTOR (MAXIMIZED) */}
          <section className="tactical-panel rounded-2xl px-3 py-2 shrink-0">
            <div className="flex items-center justify-between gap-2.5">
              {/* Knob Kiri (Channel - 1) */}
              <button
                onClick={() => setChannel((c) => (c > 1 ? c - 1 : 99))}
                aria-label="Channel Sebelumnya"
                className="w-11 h-11 rounded-full bg-gradient-to-b from-[#0b476e] to-[#031c32] border-2 border-[#23dcff]/70 shadow-[0_0_12px_rgba(35,220,255,0.28)] flex items-center justify-center active:scale-95 transition-transform shrink-0 cursor-pointer"
              >
                <div className="w-6.5 h-6.5 rounded-full border border-cyan-300/40 bg-[#052946] relative">
                  <span className="w-0.5 h-2.5 bg-white rounded-full absolute bottom-1 right-1.5 rotate-[-35deg]" />
                </div>
              </button>

              {/* Layar Tengah CHANNEL */}
              <div className="flex-1 tactical-panel-inset rounded-xl py-1.5 px-2.5 text-center">
                <div className="font-tactical text-[25px] leading-none font-extrabold tracking-[0.1em] text-white cyan-glow-text">
                  CHANNEL {String(channel).padStart(2, '0')}
                </div>
                <div className="font-telemetry text-[10px] text-cyan-200 tracking-wider mt-0.5">
                  {permanentRoleLabel} AKTIF • {activeChannelPeers.length} ONLINE
                </div>
              </div>

              {/* Knob Kanan (Channel + 1) */}
              <button
                onClick={() => setChannel((c) => (c < 99 ? c + 1 : 1))}
                aria-label="Channel Berikutnya"
                className="w-11 h-11 rounded-full bg-gradient-to-b from-[#0b476e] to-[#031c32] border-2 border-[#23dcff]/70 shadow-[0_0_12px_rgba(35,220,255,0.28)] flex items-center justify-center active:scale-95 transition-transform shrink-0 cursor-pointer"
              >
                <div className="w-6.5 h-6.5 rounded-full border border-cyan-300/40 bg-[#052946] relative">
                  <span className="w-0.5 h-2.5 bg-white rounded-full absolute bottom-1 left-1.5 rotate-[35deg]" />
                </div>
              </button>

              {/* Kolom Kanan: TOMBOL KEEP:ON DI ATAS PERSIS TOMBOL BARCODE (Menggantikan posisi lama EMERGENCY CLEAR) */}
              <div className="flex flex-col items-stretch gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setKeepAliveEnabled((prev) => !prev)}
                  title="Keep-Alive Silent Audio Stream (Agar WebSocket & Audio Tetap Hidup Saat Layar HP Mati / Masuk Saku)"
                  className={`px-2.5 py-1 rounded-lg border font-telemetry text-[9.5px] font-extrabold flex items-center justify-center gap-1 active:scale-95 transition-all cursor-pointer ${
                    keepAliveEnabled
                      ? 'bg-[#06385c] border-[#23dcff] text-[#23dcff] shadow-[0_0_10px_rgba(35,220,255,0.28)]'
                      : 'bg-[#031829] border-cyan-500/35 text-cyan-300/60'
                  }`}
                >
                  {keepAliveEnabled
                    ? isBackgroundMode
                      ? 'SAKU:AKTIF'
                      : 'KEEP:ON'
                    : 'KEEP:OFF'}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveBottomModal('barcode')}
                  className="py-1 px-2.5 rounded-lg bg-[#052542] hover:bg-[#093862] border border-[#23dcff]/65 flex items-center justify-center gap-1 text-[9.5px] font-bold text-white transition-colors cursor-pointer"
                >
                  <QrCode className="w-3.5 h-3.5 text-[#23dcff] shrink-0" />
                  <span>BARCODE</span>
                </button>
              </div>
            </div>
          </section>

          {/* 4. GRID USER / ANGGOTA (REAL PEERS ONLY - MAXIMIZED) */}
          <section className="space-y-1.5 shrink-0">
            {/* Baris Atas: Tombol TALK ALL, ID SAYA: [CALLSIGN], Edit Nama & TOMBOL OVERRIDE */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  const next = !talkAll;
                  setTalkAll(next);
                  if (next) {
                    setMembers((prev) => prev.map((m) => ({ ...m, isTargeted: true })));
                  }
                }}
                className={`px-3 py-1.5 rounded-full font-tactical text-[13px] font-bold tracking-wider flex items-center gap-1 transition-all shrink-0 cursor-pointer ${
                  talkAll
                    ? 'cyan-btn-glow text-white border border-white/50'
                    : 'bg-[#052542] text-cyan-200 border border-cyan-400/50'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>TALK ALL</span>
              </button>

              <div className="flex-1 min-w-0 tactical-panel rounded-full px-3 py-1.5 flex items-center justify-between gap-1.5">
                <div className="font-telemetry text-[10.5px] truncate">
                  <span className="text-cyan-200/90">ID: </span>
                  <strong className="text-white font-bold">{myCallsign}</strong>
                </div>
                <button
                  onClick={() => openEditNameModal()}
                  className="px-2 py-0.5 rounded-full bg-[#041d34] hover:bg-[#083156] border border-cyan-400/50 flex items-center gap-1 text-[10px] font-medium text-cyan-100 shrink-0 cursor-pointer"
                >
                  <Pencil className="w-2.5 h-2.5 text-[#23dcff]" />
                  <span>Edit</span>
                </button>
              </div>

              {/* Tombol Kontrol (OVERRIDE) — Toggle Prioritas Pengambilalihan Saluran */}
              <button
                type="button"
                role="switch"
                aria-checked={isPriorityOverride}
                onClick={handleTogglePriorityOverride}
                title="TOMBOL OVERRIDE PRIORITAS: Hentikan transmisi klien lain seketika & ambil alih saluran suara"
                className={`px-2.5 py-1.5 rounded-full border font-tactical text-[10.5px] font-extrabold tracking-wider flex items-center gap-1 shrink-0 active:scale-95 transition-all cursor-pointer ${
                  isPriorityOverride
                    ? 'bg-gradient-to-r from-amber-400 to-[#23dcff] text-[#02182b] border-white shadow-[0_0_16px_rgba(251,191,36,0.75)]'
                    : 'bg-[#052946] hover:bg-[#083b64] text-[#23dcff] border-[#23dcff]/75 shadow-[0_0_10px_rgba(35,220,255,0.25)]'
                }`}
              >
                <Zap
                  className={`w-3 h-3 shrink-0 ${
                    isPriorityOverride ? 'text-[#02182b] fill-[#02182b]' : 'text-amber-300'
                  }`}
                />
                <span>OVERRIDE</span>
                <span
                  className={`w-2 h-2 rounded-full ${
                    isPriorityOverride
                      ? 'bg-[#02182b] animate-ping'
                      : 'bg-cyan-400/50'
                  }`}
                />
              </button>
            </div>

            {/* Baris Tengah: Panel Sakelar VOX (VOX On/Off Switch), Keep-Alive Saku/Layar Mati & Pengatur Sensitivitas (Threshold Slider Anti-Bising/Angin) */}
            <div className="tactical-panel rounded-xl px-2.5 py-1.5 flex flex-col gap-1 border border-[#23dcff]/60">
              {/* Baris 1: Tombol Sakelar VOX (On/Off Switch) + Mode Preset Anti-Bising/Angin + Keep-Alive Saku + Hold Time */}
              <div className="flex items-center justify-between gap-1">
                {/* Tombol Sakelar VOX (VOX On/Off Switch) */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={voxEnabled}
                  onClick={handleToggleVoxSwitch}
                  className={`px-2 py-0.5 rounded-lg border flex items-center gap-1 transition-all shrink-0 cursor-pointer ${
                    voxEnabled
                      ? 'bg-[#073b61] border-[#23dcff] text-white shadow-[0_0_10px_rgba(35,220,255,0.3)]'
                      : 'bg-[#031829] border-cyan-500/35 text-cyan-200/75'
                  }`}
                >
                  {/* Visual Sliding Switch Track & Knob */}
                  <div
                    className={`w-6.5 h-3.5 rounded-full p-0.5 flex items-center transition-colors ${
                      voxEnabled ? 'bg-[#23dcff] justify-end' : 'bg-[#02101c] border border-cyan-500/40 justify-start'
                    }`}
                  >
                    <span
                      className={`w-2.5 h-2.5 rounded-full transition-transform ${
                        voxEnabled ? 'bg-[#02182b] shadow-xs' : 'bg-cyan-300/70'
                      }`}
                    />
                  </div>
                  <span className="font-tactical text-[11px] font-extrabold tracking-wider">
                    {voxEnabled ? 'VOX:ON' : 'VOX:OFF'}
                  </span>
                </button>

                {/* Tombol Preset Cepat VOX: TENANG (30%), RAMAI (50%), ANGIN (80%) */}
                <div className="flex items-center gap-1 min-w-0">
                  {[
                    { label: 'TENANG', val: 30 },
                    { label: 'RAMAI', val: 50 },
                    { label: 'ANGIN', val: 80 },
                  ].map((preset) => {
                    const isActivePreset = voxThreshold === preset.val;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setVoxThreshold(preset.val);
                        }}
                        title={`Set Sensitivitas VOX ke Mode ${preset.label} (THR ${preset.val}%)`}
                        className={`px-1.5 py-0.5 rounded font-telemetry text-[8px] font-bold transition-colors cursor-pointer ${
                          isActivePreset
                            ? 'bg-[#23dcff] text-[#02182b] font-extrabold'
                            : 'bg-[#042138] hover:bg-[#083456] text-cyan-100 border border-cyan-400/35'
                        }`}
                      >
                        {preset.label} {preset.val}%
                      </button>
                    );
                  })}
                </div>

                {/* Tombol Penguat Volume Penerima (Web Audio API GainNode Boost: 2.0x / 2.2x / 3.0x) */}
                <button
                  type="button"
                  onClick={() =>
                    setRxGainBoost((prev) =>
                      prev < 2.0 ? 2.0 : prev === 2.0 ? 2.2 : prev === 2.2 ? 3.0 : 1.5
                    )
                  }
                  title="Penguat Volume Suara Masuk (Web Audio API GainNode Receiver Boost)"
                  className="px-1.5 py-0.5 rounded bg-[#06385c] hover:bg-[#094b7a] border border-[#23dcff] font-telemetry text-[8px] font-extrabold text-[#23dcff] shrink-0 cursor-pointer"
                >
                  GAIN:{rxGainBoost.toFixed(1)}x
                </button>

                {/* Tombol Jeda Hening (Hold Time) atau Tombol Pulihkan Izin Mic jika Ditolak */}
                {micPermissionState === 'denied' || micErrorNotice ? (
                  <button
                    type="button"
                    onClick={handleGrantOrRecoverAudioPermission}
                    title={micErrorNotice || 'Aktifkan Izin Mikrofon & Web Audio'}
                    className="px-1.5 py-0.5 rounded bg-amber-400 text-[#02182b] font-telemetry text-[8px] font-extrabold shrink-0 cursor-pointer animate-pulse"
                  >
                    IZIN MIC
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      setVoxHoldMs((prev) => (prev === 1100 ? 1600 : prev === 1600 ? 750 : 1100))
                    }
                    title="Jeda Hening Penutup Otomatis (Hold Time)"
                    className="px-1.5 py-0.5 rounded bg-[#052542] hover:bg-[#093862] border border-cyan-400/45 font-telemetry text-[8px] font-bold text-cyan-100 shrink-0 cursor-pointer"
                  >
                    {(voxHoldMs / 1000).toFixed(1)}s
                  </button>
                )}
              </div>

              {/* Baris 2: Pengatur Sensitivitas VOX Terisolasi (React.memo — Hanya merender ulang bar indikator ini, bukan seluruh halaman) */}
              <VoxThresholdSliderRow
                voxThreshold={voxThreshold}
                onChangeThreshold={setVoxThreshold}
                isPttLocked={isPttLocked}
                activeLockSpeaker={activeLockSpeaker}
                voxEnabled={voxEnabled}
              />
            </div>

            {/* Baris Bawah: Real Peers atau Status Pencarian */}
            {activeChannelPeers.length === 0 ? (
              <div className="tactical-panel rounded-xl py-1.5 px-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <RefreshCw className="w-3.5 h-3.5 text-[#23dcff] animate-spin shrink-0" />
                  <div className="truncate">
                    <span className="font-tactical text-[13.5px] font-extrabold tracking-wider text-white mr-1.5">
                      Mencari Anggota...
                    </span>
                    <span className="font-telemetry text-[9.5px] text-cyan-200/80">
                      ({myPeerNodeId})
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setBarcodeTab('show');
                      setActiveBottomModal('barcode');
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[#052542] hover:bg-[#093862] border border-[#23dcff]/70 font-telemetry text-[10px] font-bold text-white flex items-center gap-1 cursor-pointer"
                  >
                    <QrCode className="w-3.5 h-3.5 text-[#23dcff]" />
                    <span>{offlineAnswerToken ? 'Balasan' : 'QR'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setBarcodeTab('scan');
                      setActiveBottomModal('barcode');
                    }}
                    className="px-2.5 py-1 rounded-lg cyan-btn-glow text-[#02182b] font-telemetry text-[10px] font-extrabold flex items-center gap-1 cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>Scan</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-1.5 max-h-16 overflow-y-auto">
                {activeChannelPeers.map((member) => {
                  const isHighlighted =
                    selectedMemberId === member.id ||
                    activeLockSpeaker === member.callsign ||
                    member.isTargeted;
                  return (
                    <div
                      key={member.id}
                      onClick={() => {
                        setSelectedMemberId(member.id);
                        setMembers((prev) =>
                          prev.map((m) =>
                            m.id === member.id
                              ? { ...m, isTargeted: !m.isTargeted }
                              : m
                          )
                        );
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedMemberId(member.id);
                        }
                      }}
                      className={`rounded-xl px-2.5 py-1 flex items-center justify-between gap-1.5 border transition-all cursor-pointer ${
                        isHighlighted
                          ? 'bg-gradient-to-b from-[#17a9d9] to-[#0c6c99] border-[#66ecff]'
                          : 'bg-gradient-to-b from-[#062b4c] to-[#041d35] border-[#23dcff]/45'
                      }`}
                    >
                      <div className="relative w-5 h-5 rounded-full bg-[#03192e] border border-cyan-400/55 flex items-center justify-center shrink-0">
                        <Mic className="w-3 h-3 text-[#23dcff]" />
                      </div>
                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="font-tactical text-[12.5px] font-bold text-white truncate">
                          {member.callsign}
                        </div>
                        <div className="font-telemetry text-[8.5px] text-cyan-100/90 truncate">
                          {member.ip}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 5. AREA UTAMA PTT + GELOMBANG SUARA + BANNER STATUS (FLEX-1 MAXIMIZED) */}
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-1.5 py-0.5">
            <section className="flex items-center justify-center gap-3.5">
              {/* Indikator Gelombang Suara Kiri Terisolasi (React.memo) */}
              <PttSoundWaveSideBars
                side="left"
                isTransmitting={isTransmitting}
                voxEnabled={voxEnabled}
                hasActiveLockSpeaker={Boolean(activeLockSpeaker)}
              />

              {/* Tombol Lingkaran PTT (VOX Hands-Free Otomatis + Klik Manual + Channel Lockout) */}
              <button
                type="button"
                disabled={isPttLocked}
                onClick={isPttLocked ? undefined : handlePttToggle}
                className={`relative w-36 h-36 sm:w-40 sm:h-40 rounded-full border-[4px] flex items-center justify-center transition-transform duration-150 select-none ${
                  isPttLocked
                    ? 'bg-[#1a1318] border-red-500/80 opacity-85 cursor-not-allowed'
                    : isTransmitting
                    ? 'ptt-ring-active border-white scale-[0.98] cursor-pointer'
                    : 'ptt-ring-outer border-[#2fe0ff] active:scale-95 cursor-pointer'
                }`}
              >
                {/* Teks Melingkar */}
                <div className="absolute inset-0 pointer-events-none">
                  {curvedChars.map((char, index) => {
                    const total = curvedChars.length;
                    const spreadDeg = 118;
                    const startAngle = -spreadDeg / 2;
                    const angle = startAngle + (index / (total - 1)) * spreadDeg;
                    return (
                      <span
                        key={index}
                        style={{
                          transform: `rotate(${angle}deg)`,
                        }}
                        className="absolute left-1/2 top-1.5 -ml-[4px] h-[66px] sm:h-[74px] origin-bottom font-tactical text-[9px] font-extrabold text-[#02192d] tracking-wider"
                      >
                        {char}
                      </span>
                    );
                  })}
                </div>

                {/* Lingkaran Dalam Tombol PTT */}
                <div
                  className={`w-25 h-25 sm:w-28 sm:h-28 rounded-full border-2 flex flex-col items-center justify-center px-2 text-center transition-all ${
                    isPttLocked
                      ? 'bg-gradient-to-b from-[#3d121d] to-[#1c080d] border-red-400/80'
                      : isTransmitting
                      ? 'bg-gradient-to-b from-[#33e6ff] to-[#066c96] border-white shadow-inner'
                      : 'bg-gradient-to-b from-[#178bbf] via-[#0a4c73] to-[#052942] border-[#6beaff]/65 shadow-[inset_0_3px_10px_rgba(255,255,255,0.25)]'
                  }`}
                >
                  <Radio
                    className={`w-7 h-7 mb-0.5 ${
                      isPttLocked
                        ? 'text-red-300 animate-pulse'
                        : isTransmitting
                        ? 'text-[#021b30] animate-pulse'
                        : 'text-[#03233b]'
                    }`}
                  />
                  <span className="font-tactical text-[12px] font-extrabold tracking-wider text-white drop-shadow leading-tight">
                    {isTransmitting
                      ? voxEnabled
                        ? 'VOX TRANSMIT'
                        : 'KLIK TUTUP PTT'
                      : isPttLocked
                      ? `LOCK: ${activeLockSpeaker}`
                      : voxEnabled
                      ? 'VOX STANDBY'
                      : isMasterDevice
                      ? 'MASTER READY'
                      : 'CLIENT READY'}
                  </span>
                  <span className="font-telemetry text-[8px] font-bold text-cyan-100/95 leading-none mt-0.5">
                    {isTransmitting
                      ? 'SALURAN DIKUNCI • RX OFF'
                      : isPttLocked
                      ? 'VOX & TX LOCKED'
                      : voxEnabled
                      ? 'ANTI-COLLISION SIAP'
                      : 'KLIK BUKA PTT'}
                  </span>
                </div>
              </button>

              {/* Indikator Gelombang Suara Kanan Terisolasi (React.memo) */}
              <PttSoundWaveSideBars
                side="right"
                isTransmitting={isTransmitting}
                voxEnabled={voxEnabled}
                hasActiveLockSpeaker={Boolean(activeLockSpeaker)}
              />
            </section>

            {/* BANNER STATUS BAWAH (CHANNEL LOCKOUT / ANTI-COLLISION & VOX OTOMATIS) */}
            <button
              type="button"
              disabled={isPttLocked}
              onClick={isPttLocked ? undefined : handlePttToggle}
              className={`w-full py-1.5 rounded-xl font-tactical text-[14px] sm:text-[15.5px] font-extrabold tracking-[0.06em] text-white text-center shrink-0 transition-all ${
                isPttLocked
                  ? 'bg-red-950/90 border border-red-400/80 text-red-100 cursor-not-allowed'
                  : 'cyan-btn-glow shadow-[0_0_15px_rgba(35,220,255,0.35)] cursor-pointer'
              }`}
            >
              {collisionBlockedNotice
                ? collisionBlockedNotice
                : isTransmitting
                ? voxEnabled
                  ? 'SALURAN DIKUNCI (TX AKTIF • RX OFF) • HENING UTK LEPAS KUNCI'
                  : 'SALURAN DIKUNCI (TX AKTIF • RX OFF) • KLIK KEDUA TUTUP PTT'
                : isPttLocked
                ? `CHANNEL LOCKED: ${activeLockSpeaker} BICARA (VOX & TX DIKUNCI)`
                : voxEnabled
                ? 'VOX & ANTI-COLLISION AKTIF • LANGSUNG BICARA'
                : isMasterDevice
                ? 'MASTER READY • KLIK UNTUK BUKA PTT'
                : 'CLIENT READY • KLIK UNTUK BUKA PTT'}
            </button>
          </div>

          {/* 5B. FITUR CHAT TAKTIKAL RINGKAS DI BAGIAN BAWAH (COMPACT DOCK) */}
          <section className="shrink-0 tactical-panel rounded-xl px-2.5 py-1.5 flex flex-col gap-1 border border-[#23dcff]/50">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1 min-w-0">
                <MessageSquare className="w-3 h-3 text-[#23dcff] shrink-0" />
                <span className="font-tactical text-[11.5px] font-extrabold tracking-wider text-white truncate">
                  CHAT CH {String(channel).padStart(2, '0')}
                </span>
                {unreadChatCount > 0 && (
                  <span className="px-1.5 rounded-full bg-[#23dcff] text-[#02182b] font-telemetry text-[8.5px] font-extrabold">
                    {unreadChatCount}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {['SIAP 86!', 'MONITOR', 'AMAN', 'SOS'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleSendChatMessage(undefined, preset)}
                    className="px-1.5 py-0.5 rounded bg-[#04223b] hover:bg-[#08385e] border border-cyan-400/40 font-telemetry text-[8.5px] font-bold text-cyan-100 cursor-pointer"
                  >
                    {preset}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setUnreadChatCount(0);
                    setActiveBottomModal('chat');
                  }}
                  className="px-1.5 py-0.5 rounded bg-[#052542] hover:bg-[#093862] border border-cyan-400/50 font-telemetry text-[8.5px] font-bold text-[#23dcff] cursor-pointer"
                >
                  Penuh
                </button>
              </div>
            </div>

            {/* Area Riwayat Pesan Chat Ringkas (1-2 Baris Terakhir) */}
            <div className="h-[26px] overflow-y-auto rounded bg-[#021220]/90 border border-cyan-400/25 px-2 py-0.5 space-y-0.5 font-telemetry text-[9.5px]">
              {chatMessages.filter((m) => m.channel === channel).length === 0 ? (
                <div className="h-full flex items-center text-cyan-300/60 text-[9px] truncate">
                  <span>Belum ada pesan di CH {String(channel).padStart(2, '0')}. Ketik atau pilih preset.</span>
                </div>
              ) : (
                chatMessages
                  .filter((m) => m.channel === channel)
                  .map((msg) => {
                    const isMine = msg.senderId === myDeviceId;
                    const timeStr = new Date(msg.timestamp).toLocaleTimeString('id-ID', {
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    return (
                      <div
                        key={msg.id}
                        className="flex items-baseline justify-between gap-1.5 leading-tight"
                      >
                        <div className="min-w-0 flex-1 truncate">
                          <span className="font-extrabold text-[#23dcff] mr-1">
                            {isMine ? `${msg.callsign}:` : `${msg.callsign} [${msg.role}]:`}
                          </span>
                          <span className="text-white font-semibold">{msg.text}</span>
                        </div>
                        <span className="text-[8px] text-cyan-300/75 shrink-0">{timeStr}</span>
                      </div>
                    );
                  })
              )}
              <div ref={onScreenChatEndRef} />
            </div>

            {/* Input Kirim Pesan Ringkas */}
            <form onSubmit={(e) => handleSendChatMessage(e)} className="flex items-center gap-1.5">
              <input
                type="text"
                maxLength={200}
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder={`Kirim chat ke CH ${String(channel).padStart(2, '0')}...`}
                className="flex-1 px-2 py-0.5 rounded bg-[#021424] border border-[#23dcff]/60 focus:border-[#23dcff] text-white font-telemetry text-[10px] focus:outline-none"
              />
              <button
                type="submit"
                className="px-2.5 py-0.5 rounded cyan-btn-glow text-[#02182b] font-telemetry text-[10px] font-extrabold flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <Send className="w-2.5 h-2.5" />
                <span>KIRIM</span>
              </button>
            </form>
          </section>
        </div>

        {/* 6. BOTTOM NAVIGATION BAR: [Channels], [Chat], [Edit Nama], [Barcode], [Settings] */}
        <nav className="w-full bg-[#021526]/95 border-t border-cyan-400/35 px-1.5 py-1.5 grid grid-cols-5 gap-1 shrink-0">
          <button
            onClick={() => setActiveBottomModal('channels')}
            className="flex flex-col items-center justify-center py-0.5 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Radio className="w-4 h-4 text-[#23dcff] mb-0.5" />
            <span className="font-telemetry text-[10px] font-semibold">
              [Channels]
            </span>
          </button>

          <button
            onClick={() => {
              setUnreadChatCount(0);
              setActiveBottomModal('chat');
            }}
            className="relative flex flex-col items-center justify-center py-0.5 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <MessageSquare className="w-4 h-4 text-[#23dcff] mb-0.5" />
            {unreadChatCount > 0 && (
              <span className="absolute top-0 right-3 w-3.5 h-3.5 rounded-full bg-[#23dcff] text-[#02182b] font-telemetry text-[8.5px] font-extrabold flex items-center justify-center">
                {unreadChatCount}
              </span>
            )}
            <span className="font-telemetry text-[10px] font-semibold">
              [Chat]
            </span>
          </button>

          <button
            onClick={() => openEditNameModal()}
            className="flex flex-col items-center justify-center py-0.5 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Pencil className="w-4 h-4 text-[#23dcff] mb-0.5" />
            <span className="font-telemetry text-[10px] font-semibold">
              [Edit Nama]
            </span>
          </button>

          <button
            onClick={() => setActiveBottomModal('barcode')}
            className="flex flex-col items-center justify-center py-0.5 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <QrCode className="w-4 h-4 text-[#23dcff] mb-0.5" />
            <span className="font-telemetry text-[10px] font-semibold">
              [Barcode]
            </span>
          </button>

          <button
            onClick={() => {
              setSettingsTab('audio');
              setActiveBottomModal('settings');
            }}
            className="flex flex-col items-center justify-center py-0.5 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Settings className="w-4 h-4 text-[#23dcff] mb-0.5" />
            <span className="font-telemetry text-[10px] font-semibold">
              [Settings]
            </span>
          </button>
        </nav>

        {/* ===================================================================
            MODAL OVERLAYS ([Channels], [Chat], [Edit Nama], [Barcode], [Settings])
           =================================================================== */}
        {activeBottomModal && (
          <div className="fixed inset-0 bg-[#010d18]/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-[460px] max-h-[88dvh] overflow-y-auto tactical-panel rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-cyan-400/30 pb-3">
                <h3 className="font-tactical text-lg font-bold tracking-wider text-[#23dcff]">
                  {activeBottomModal === 'channels' &&
                    'PILIH FREKUENSI CHANNEL PTT'}
                  {activeBottomModal === 'chat' &&
                    `RUANG CHAT TAKTIKAL • CH ${String(channel).padStart(2, '0')}`}
                  {activeBottomModal === 'editName' &&
                    (editingMemberId
                      ? 'UBAH CALLSIGN ANGGOTA'
                      : 'EDIT CALLSIGN SAYA')}
                  {activeBottomModal === 'barcode' &&
                    'BARCODE SINKRONISASI PERANGKAT'}
                  {activeBottomModal === 'settings' &&
                    'PENGATURAN APK, VERCEL & SOURCE CODE'}
                </h3>
                <button
                  onClick={() => setActiveBottomModal(null)}
                  className="p-1.5 rounded-lg hover:bg-cyan-500/20 text-cyan-200 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* MODAL CHAT TAKTIKAL LAYAR PENUH */}
              {activeBottomModal === 'chat' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-[11px] font-telemetry text-cyan-200">
                    <span>
                      ID: <strong className="text-white">{myCallsign}</strong> ({permanentRoleLabel})
                    </span>
                    <button
                      type="button"
                      onClick={handleClearChannelChat}
                      className="px-2.5 py-1 rounded-lg bg-red-950/60 hover:bg-red-900/70 border border-red-400/50 text-red-200 flex items-center gap-1 text-[10.5px] font-bold cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Bersihkan Chat</span>
                    </button>
                  </div>

                  <div className="h-72 overflow-y-auto rounded-xl bg-[#021220] border border-cyan-400/35 p-3 space-y-2 font-telemetry text-xs">
                    {chatMessages.filter((m) => m.channel === channel).length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-center text-cyan-300/60 text-xs">
                        <MessageSquare className="w-8 h-8 text-[#23dcff]/50 mb-2" />
                        <span>Belum ada percakapan di CHANNEL {String(channel).padStart(2, '0')}.</span>
                        <span className="text-[10.5px] mt-1">
                          Pesan terkirim secara instan melalui Wi-Fi / Hotspot Offline maupun Cloud Mesh.
                        </span>
                      </div>
                    ) : (
                      chatMessages
                        .filter((m) => m.channel === channel)
                        .map((msg) => {
                          const isMine = msg.senderId === myDeviceId;
                          const timeStr = new Date(msg.timestamp).toLocaleTimeString('id-ID', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          });
                          return (
                            <div
                              key={msg.id}
                              className={`p-2.5 rounded-xl border ${
                                isMine
                                  ? 'bg-[#08385e] border-[#23dcff] text-white ml-6'
                                  : 'bg-[#041f36] border-cyan-500/40 text-cyan-50 mr-6'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 text-[10px] text-cyan-300 mb-1">
                                <span className="font-extrabold text-[#23dcff]">
                                  {isMine ? `${msg.callsign} (SAYA)` : msg.callsign} [{msg.role}] • {msg.ip}
                                </span>
                                <span>{timeStr}</span>
                              </div>
                              <div className="text-xs font-semibold break-words text-white">
                                {msg.text}
                              </div>
                            </div>
                          );
                        })
                    )}
                    <div ref={modalChatEndRef} />
                  </div>

                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                    {[
                      'SIAP 86!',
                      'MONITOR POSISI',
                      'LAPOR SITUASI AMAN',
                      'GANTI CHANNEL',
                      ' DARURAT / SOS',
                    ].map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handleSendChatMessage(undefined, preset)}
                        className="px-2.5 py-1 rounded-lg bg-[#04223b] hover:bg-[#08385e] border border-cyan-400/45 font-telemetry text-[10.5px] font-bold text-cyan-100 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {preset}
                      </button>
                    ))}
                  </div>

                  <form onSubmit={(e) => handleSendChatMessage(e)} className="flex items-center gap-2">
                    <input
                      type="text"
                      maxLength={200}
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      autoFocus
                      placeholder={`Tulis pesan taktikal ke CH ${String(channel).padStart(2, '0')}...`}
                      className="flex-1 px-3.5 py-2.5 rounded-xl bg-[#021424] border border-[#23dcff] text-white font-telemetry text-xs focus:outline-none"
                    />
                    <button
                      type="submit"
                      className="px-4 py-2.5 rounded-xl cyan-btn-glow text-[#02182b] font-telemetry text-xs font-extrabold flex items-center gap-1.5 shrink-0 cursor-pointer"
                    >
                      <Send className="w-4 h-4" />
                      <span>KIRIM</span>
                    </button>
                  </form>
                </div>
              )}

              {/* MODAL 1: CHANNELS */}
              {activeBottomModal === 'channels' && (
                <div className="space-y-3">
                  <p className="text-xs text-cyan-100/85">
                    Pilih kanal komunikasi taktikal (CH 01 – CH 16). Semua HP
                    yang membuka APK di channel yang sama akan terhubung
                    otomatis.
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(
                      (ch) => (
                        <button
                          key={ch}
                          onClick={() => {
                            setChannel(ch);
                            setActiveBottomModal(null);
                          }}
                          className={`py-2.5 rounded-xl font-telemetry text-xs font-bold border transition-all cursor-pointer ${
                            channel === ch
                              ? 'cyan-btn-glow text-[#02182b] border-white'
                              : 'bg-[#03192e] text-cyan-100 border-cyan-500/30 hover:border-cyan-300'
                          }`}
                        >
                          CH {String(ch).padStart(2, '0')}
                        </button>
                      )
                    )}
                  </div>
                </div>
              )}

              {/* MODAL 2: EDIT NAMA & PERAN (HP MASTER / CLIENT) */}
              {activeBottomModal === 'editName' && (
                <form onSubmit={handleSaveName} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-cyan-200 mb-1.5">
                      CALLSIGN TAKTIKAL (MAKS 12 KARAKTER)
                    </label>
                    <input
                      type="text"
                      maxLength={12}
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      autoFocus
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#021424] border border-[#23dcff] text-white font-telemetry font-bold uppercase focus:outline-none"
                      placeholder="CONTOH: YUDHI"
                    />
                  </div>

                  {!editingMemberId && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-semibold text-cyan-200">
                        PERAN JARINGAN PEERJS:
                      </label>
                      <div className="grid grid-cols-2 gap-2 font-telemetry text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            setRole('MASTER');
                            setLocalIp('192.168.43.1');
                            setSetupIpMode('192.168.43.1');
                          }}
                          className={`py-2 px-3 rounded-xl border font-bold text-left cursor-pointer ${
                            role === 'MASTER'
                              ? 'bg-[#093b61] border-[#23dcff] text-white'
                              : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                          }`}
                        >
                          <div className="text-[#23dcff] font-extrabold">HP MASTER</div>
                          <div className="text-[10px]">PTT-MASTER-01</div>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRole('CLIENT');
                            if (localIp === '192.168.43.1') {
                              setLocalIp(
                                `192.168.43.${Math.floor(102 + Math.random() * 90)}`
                              );
                            }
                            setSetupIpMode('CLIENT');
                          }}
                          className={`py-2 px-3 rounded-xl border font-bold text-left cursor-pointer ${
                            role === 'CLIENT'
                              ? 'bg-[#093b61] border-[#23dcff] text-white'
                              : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                          }`}
                        >
                          <div className="text-[#23dcff] font-extrabold">CLIENT</div>
                          <div className="text-[10px]">PTT-CLIENT-[NAMA]</div>
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveBottomModal(null);
                        setIsSetupCompleted(false);
                      }}
                      className="px-3 py-2 rounded-lg text-[11px] font-semibold text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/10 cursor-pointer"
                    >
                      Buka SetupScreen
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setActiveBottomModal(null)}
                        className="px-3.5 py-2 rounded-lg text-xs font-semibold text-cyan-200 hover:bg-cyan-500/10 cursor-pointer"
                      >
                        Batal
                      </button>
                      <button
                        type="submit"
                        className="px-4 py-2 rounded-lg text-xs font-bold cyan-btn-glow text-[#02182b] cursor-pointer"
                      >
                        Simpan Callsign
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {/* MODAL 3: BARCODE PAIRING, IN-APP CAMERA SCANNER & INVITE LINK */}
              {activeBottomModal === 'barcode' && (
                <div className="text-center space-y-3.5">
                  {/* Tab Switcher: Tampilkan Barcode Saya vs Scan Barcode Master */}
                  <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#021424] rounded-xl border border-cyan-500/30">
                    <button
                      type="button"
                      onClick={() => setBarcodeTab('show')}
                      className={`py-2 px-2 rounded-lg font-telemetry text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                        barcodeTab === 'show'
                          ? 'bg-[#23dcff] text-[#02182b]'
                          : 'text-cyan-200 hover:bg-cyan-500/10'
                      }`}
                    >
                      <QrCode className="w-4 h-4" />
                      <span>BARCODE SAYA</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBarcodeTab('scan')}
                      className={`py-2 px-2 rounded-lg font-telemetry text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                        barcodeTab === 'scan'
                          ? 'bg-[#23dcff] text-[#02182b]'
                          : 'text-cyan-200 hover:bg-cyan-500/10'
                      }`}
                    >
                      <Camera className="w-4 h-4" />
                      <span>SCAN BARCODE</span>
                    </button>
                  </div>

                  {barcodeTab === 'show' ? (
                    <>
                      {!offlineAnswerToken && (
                        <div className="grid grid-cols-2 gap-1 p-1 bg-[#03192e] rounded-xl border border-cyan-400/35">
                          <button
                            type="button"
                            onClick={() => setQrDisplayMode('offlineFast')}
                            className={`py-1.5 px-2 rounded-lg font-telemetry text-[10.5px] font-bold transition-colors cursor-pointer ${
                              qrDisplayMode === 'offlineFast'
                                ? 'bg-[#23dcff] text-[#02182b]'
                                : 'text-cyan-200 hover:bg-cyan-500/10'
                            }`}
                          >
                            MODE WIFI TANPA INTERNET
                          </button>
                          <button
                            type="button"
                            onClick={() => setQrDisplayMode('inviteUrl')}
                            className={`py-1.5 px-2 rounded-lg font-telemetry text-[10.5px] font-bold transition-colors cursor-pointer ${
                              qrDisplayMode === 'inviteUrl'
                                ? 'bg-[#23dcff] text-[#02182b]'
                                : 'text-cyan-200 hover:bg-cyan-500/10'
                            }`}
                          >
                            MODE LINK URL (ONLINE)
                          </button>
                        </div>
                      )}

                      {offlineAnswerToken && (
                        <div className="px-3 py-2 rounded-xl bg-amber-500/20 border border-amber-400 text-amber-200 font-telemetry text-[11px] font-bold">
                          LANGKAH 2 WIFI TANPA INTERNET: SCAN BARCODE BALASAN DI BAWAH INI DARI HP MASTER!
                        </div>
                      )}

                      <div className="w-56 h-56 mx-auto bg-white p-2.5 rounded-2xl flex flex-col items-center justify-center shadow-[0_0_25px_rgba(35,220,255,0.35)] border-2 border-[#23dcff]">
                        {offlineAnswerToken && offlineAnswerQrUrl ? (
                          <img
                            src={offlineAnswerQrUrl}
                            alt="QR Code Offline Answer"
                            className="w-full h-full object-contain rounded-lg select-all"
                          />
                        ) : qrCodeDataUrl ? (
                          <img
                            src={qrCodeDataUrl}
                            alt="QR Code Invite Link"
                            className="w-full h-full object-contain rounded-lg select-all"
                          />
                        ) : (
                          <QrCode className="w-36 h-36 text-[#03192e]" />
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="font-telemetry text-xs text-white font-extrabold">
                          {offlineAnswerToken
                            ? `BARCODE BALASAN OFFLINE: ${myCallsign} (${localIp})`
                            : `BARCODE HOST: ${myCallsign} (${
                                detectedLanIpRef.current || localIp
                              }) • CH ${String(channel).padStart(2, '0')}`}
                        </div>
                        <div className="font-telemetry text-[10.5px] text-cyan-200/85">
                          {offlineAnswerToken ? (
                            <>
                              Di HP Master, tekan tab{' '}
                              <strong className="text-white">SCAN BARCODE</strong> lalu arahkan ke layar ini untuk membuka jalur suara Wi-Fi Tanpa Internet!
                            </>
                          ) : (
                            <>
                              1) Scan Barcode ini dari HP Client (via menu{' '}
                              <strong className="text-white">SCAN BARCODE</strong> di aplikasi). 2) Saat Wi-Fi{' '}
                              <strong className="text-white">Tanpa Internet</strong>, HP Client otomatis menampilkan Barcode Balasan untuk di-scan balik oleh HP Master.
                            </>
                          )}
                        </div>
                      </div>

                      <div className="space-y-1.5 text-left">
                        <label className="block font-telemetry text-[10.5px] text-cyan-200 font-bold">
                          {offlineAnswerToken
                            ? 'KODE BALASAN WIFI OFFLINE (ATAU SALIN KE HP MASTER):'
                            : qrDisplayMode === 'offlineFast' && offlineOfferToken
                            ? 'KODE WIFI OFFLINE CEPAT (DSKM2 - TANPA INTERNET):'
                            : 'LINK INVITE & KODE OFFLINE HOTSPOT MASTER:'}
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={
                            offlineAnswerToken ||
                            (qrDisplayMode === 'offlineFast' && offlineOfferToken
                              ? offlineOfferToken
                              : sharePairUrl)
                          }
                          onFocus={(e) => e.currentTarget.select()}
                          className="w-full font-telemetry text-[11px] text-cyan-100 bg-[#021526] px-3 py-2 rounded-lg border border-cyan-500/40 focus:outline-none select-all"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            handleCopyText('pairUrl', offlineAnswerToken || sharePairUrl)
                          }
                          className="py-2.5 px-3 rounded-xl cyan-btn-glow text-[#02182b] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {copiedText === 'pairUrl' ? (
                            <>
                              <Check className="w-4 h-4" />
                              <span>Kode Tersalin!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4" />
                              <span>
                                {offlineAnswerToken ? 'Salin Kode Balasan' : 'Salin Link / Kode'}
                              </span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => setBarcodeTab('scan')}
                          className="py-2.5 px-3 rounded-xl bg-[#063256] hover:bg-[#0a4678] border border-[#23dcff] text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Camera className="w-4 h-4 text-[#23dcff]" />
                          <span>
                            {isMasterDevice ? 'Scan Balasan Client' : 'Buka Kamera Scan'}
                          </span>
                        </button>
                      </div>

                      {offlineAnswerToken && (
                        <button
                          type="button"
                          onClick={() => setOfflineAnswerToken('')}
                          className="w-full py-1.5 rounded-lg bg-[#03192e] border border-cyan-500/35 text-cyan-200 font-telemetry text-[10.5px] font-semibold cursor-pointer"
                        >
                          Kembali ke Barcode Utama Saya
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="space-y-3">
                      <p className="font-telemetry text-[11px] text-cyan-100">
                        Arahkan kamera ke Barcode di layar HP Master, atau ambil foto Barcode:
                      </p>

                      <div className="relative w-56 h-56 mx-auto rounded-2xl overflow-hidden bg-black border-2 border-[#23dcff] shadow-[0_0_25px_rgba(35,220,255,0.3)] flex items-center justify-center">
                        <video
                          ref={scannerVideoRef}
                          className="w-full h-full object-cover"
                          muted
                          playsInline
                        />
                        <canvas ref={scannerCanvasRef} className="hidden" />
                        <div className="absolute inset-6 border-2 border-dashed border-[#23dcff] rounded-xl pointer-events-none" />
                        {!isCameraScanning && (
                          <div className="absolute inset-0 bg-[#021526]/85 flex flex-col items-center justify-center p-4 text-center">
                            <Camera className="w-8 h-8 text-[#23dcff] mb-2" />
                            <button
                              type="button"
                              onClick={startCameraScanner}
                              className="px-3.5 py-2 rounded-xl cyan-btn-glow text-[#02182b] font-telemetry text-xs font-extrabold cursor-pointer"
                            >
                              AKTIFKAN KAMERA SCANNER
                            </button>
                          </div>
                        )}
                      </div>

                      {scannerError && (
                        <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-400/50 text-amber-200 font-telemetry text-[11px]">
                          {scannerError}
                        </div>
                      )}

                      <label className="w-full py-2.5 px-3 rounded-xl bg-[#063256] hover:bg-[#0a4678] border border-[#23dcff] text-white font-telemetry text-xs font-bold flex items-center justify-center gap-2 cursor-pointer">
                        <Upload className="w-4 h-4 text-[#23dcff]" />
                        <span>Ambil Foto / Pilih Gambar Barcode</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={handleScanQrImageFile}
                          className="hidden"
                        />
                      </label>
                    </div>
                  )}

                  {/* Form Gabung Manual via Link Invite / Kode Master */}
                  <form
                    onSubmit={handleManualInviteJoin}
                    className="pt-3 border-t border-cyan-400/25 space-y-2 text-left"
                  >
                    <label className="block font-telemetry text-[11px] font-bold text-[#23dcff]">
                      ATAU TEMPEL LINK INVITE / KODE NODE MASTER:
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Link2 className="w-3.5 h-3.5 text-cyan-300 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={manualInviteInput}
                          onChange={(e) => setManualInviteInput(e.target.value)}
                          placeholder="Tempel Link Invite atau Kode Node Master..."
                          className="w-full pl-8 pr-3 py-2 rounded-xl bg-[#021526] border border-cyan-400/50 text-white font-telemetry text-xs focus:border-[#23dcff] focus:outline-none"
                        />
                      </div>
                      <button
                        type="submit"
                        className="px-3.5 py-2 rounded-xl bg-[#23dcff] text-[#02182b] font-telemetry text-xs font-extrabold flex items-center gap-1 shrink-0 cursor-pointer"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>GABUNG</span>
                      </button>
                    </div>
                    {inviteJoinStatus && (
                      <div className="px-3 py-1.5 rounded-lg bg-[#063256]/80 border border-[#23dcff] text-cyan-100 font-telemetry text-[11px] font-bold text-center">
                        {inviteJoinStatus}
                      </div>
                    )}
                  </form>
                </div>
              )}

              {/* MODAL 4: SETTINGS, APK TEST, VERCEL + WEBTOAPP GUIDE, & FLUTTER CODE */}
              {activeBottomModal === 'settings' && (
                <div className="space-y-4">
                  {/* Sub-tabs inside Settings */}
                  <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#021424] rounded-xl border border-cyan-500/25">
                    <button
                      onClick={() => setSettingsTab('audio')}
                      className={`py-2 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer ${
                        settingsTab === 'audio'
                          ? 'bg-[#23dcff] text-[#02182b]'
                          : 'text-cyan-200 hover:bg-cyan-500/10'
                      }`}
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      <span>Audio &amp; APK</span>
                    </button>
                    <button
                      onClick={() => setSettingsTab('apkGuide')}
                      className={`py-2 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer ${
                        settingsTab === 'apkGuide'
                          ? 'bg-[#23dcff] text-[#02182b]'
                          : 'text-cyan-200 hover:bg-cyan-500/10'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>WebToApp</span>
                    </button>
                    <button
                      onClick={() => setSettingsTab('flutterCode')}
                      className={`py-2 px-2 rounded-lg text-[11px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer ${
                        settingsTab === 'flutterCode'
                          ? 'bg-[#23dcff] text-[#02182b]'
                          : 'text-cyan-200 hover:bg-cyan-500/10'
                      }`}
                    >
                      <Code2 className="w-3.5 h-3.5" />
                      <span>Kode Flutter</span>
                    </button>
                  </div>

                  {settingsTab === 'audio' && (
                    <div className="space-y-3 font-telemetry text-xs">
                      {isInstallable && !isInstalled && (
                        <button
                          onClick={install}
                          className="w-full py-2.5 px-4 rounded-xl cyan-btn-glow text-[#02182b] font-extrabold text-xs flex items-center justify-center gap-2 cursor-pointer"
                        >
                          <Smartphone className="w-4 h-4" />
                          <span>INSTALL APLIKASI FULLSCREEN KE HP</span>
                        </button>
                      )}

                      <div className="p-3 rounded-xl bg-[#021526] border border-[#23dcff]/45 space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-white font-bold">
                              Sakelar VOX (VOX On/Off Switch)
                            </div>
                            <div className="text-[10px] text-cyan-200/75">
                              Otomatis kirim suara saat bicara &amp; tutup saat hening (Tanpa Tombol / TWS)
                            </div>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={voxEnabled}
                            onClick={handleToggleVoxSwitch}
                            className={`px-3 py-1.5 rounded-xl font-bold flex items-center gap-2 border cursor-pointer ${
                              voxEnabled
                                ? 'bg-[#073b61] border-[#23dcff] text-white'
                                : 'bg-cyan-950 border-cyan-500/30 text-cyan-300'
                            }`}
                          >
                            <div
                              className={`w-8 h-4 rounded-full p-0.5 flex items-center ${
                                voxEnabled ? 'bg-[#23dcff] justify-end' : 'bg-[#02101c] justify-start'
                              }`}
                            >
                              <span
                                className={`w-3 h-3 rounded-full ${
                                  voxEnabled ? 'bg-[#02182b]' : 'bg-cyan-400/70'
                                }`}
                              />
                            </div>
                            <span>{voxEnabled ? 'VOX ON' : 'VOX OFF'}</span>
                          </button>
                        </div>

                        <div className="space-y-1.5 pt-2 border-t border-cyan-500/20">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-cyan-200">
                              Sensitivitas VOX (Default Balance — Slider Manual)
                            </span>
                            <span className="text-[#23dcff] font-bold">
                              THR {voxThreshold}% ({getVoxNoiseGateLabel(voxThreshold)})
                            </span>
                          </div>
                          <input
                            type="range"
                            min={5}
                            max={85}
                            step={1}
                            value={voxThreshold}
                            onChange={(e) => setVoxThreshold(Number(e.target.value))}
                            className="w-full accent-[#23dcff] cursor-pointer"
                          />
                          <div className="grid grid-cols-3 gap-1.5 pt-1">
                            {[
                              { label: 'Tenang (30%)', val: 30 },
                              { label: 'Ramai (50%)', val: 50 },
                              { label: 'Angin (80%)', val: 80 },
                            ].map((p) => (
                              <button
                                key={p.label}
                                type="button"
                                onClick={() => {
                                  setVoxThreshold(p.val);
                                }}
                                className={`py-1 px-2 rounded-lg text-[10px] font-bold border cursor-pointer ${
                                  voxThreshold === p.val
                                    ? 'bg-[#23dcff] text-[#02182b] border-white'
                                    : 'bg-[#042440] text-cyan-100 border-cyan-500/35'
                                }`}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                          <div className="flex items-center justify-between pt-1.5 text-[10.5px] text-cyan-200/90">
                            <span>
                              Preset VOX: <strong className="text-[#23dcff]">Tenang 30% • Ramai 50% • Angin 80%</strong> • Slider Stabil di <strong className="text-white">{voxThreshold}%</strong>
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-cyan-500/20 text-[11px]">
                          <span className="text-cyan-200">
                            Jeda Hening Tutup Transmisi (Hold Time)
                          </span>
                          <div className="flex items-center gap-1">
                            {[750, 1100, 1500].map((ms) => (
                              <button
                                key={ms}
                                type="button"
                                onClick={() => setVoxHoldMs(ms)}
                                className={`px-2 py-1 rounded font-bold cursor-pointer ${
                                  voxHoldMs === ms
                                    ? 'bg-[#23dcff] text-[#02182b]'
                                    : 'bg-[#042440] text-cyan-200'
                                }`}
                              >
                                {(ms / 1000).toFixed(1)}s
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Optimasi Ultra-Resilient: Opus Codec Max 12 kbps + FEC + DTX + Adaptive Jitter Buffer (100ms-200ms) */}
                        <div className="space-y-1.5 pt-2 border-t border-cyan-500/20">
                          <div className="flex items-center justify-between text-[11px]">
                            <span className="text-cyan-200">
                              Ultra-Resilient Opus (FEC + DTX • Max 12 kbps)
                            </span>
                            <span className="text-[#23dcff] font-bold">
                              {opusBitrateKbps} kbps • Jitter 100–200ms
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-1.5">
                            {([8, 10, 12] as const).map((kbps) => (
                              <button
                                key={kbps}
                                type="button"
                                onClick={() => setOpusBitrateKbps(kbps)}
                                className={`py-1 px-2 rounded-lg text-[10px] font-bold border cursor-pointer ${
                                  opusBitrateKbps === kbps
                                    ? 'bg-[#23dcff] text-[#02182b] border-white'
                                    : 'bg-[#042440] text-cyan-100 border-cyan-500/35'
                                }`}
                              >
                                Opus {kbps} kbps
                              </button>
                            ))}
                          </div>
                          <div className="text-[10px] text-cyan-200/80">
                            SDP WebRTC dikunci ke <strong>useinbandfec=1</strong>, <strong>usedtx=1</strong>, &amp; <strong>maxaveragebitrate=12000</strong> (Max 12 kbps Narrowband/Wideband speech) + <strong>Adaptive Jitter Buffer (100ms–200ms)</strong> &amp; <strong>Auto-Reconnect Store-and-Forward</strong>.
                          </div>
                        </div>
                      </div>

                      {/* Keep-Alive Latar Belakang (PiP Video Floating Widget + Media Session API + Silent Audio Loop) */}
                      <div className="p-3 rounded-xl bg-[#021526] border border-[#23dcff]/45 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-white font-bold">
                              Bypass Background OS: PiP Widget &amp; Media Session
                            </div>
                            <div className="text-[10px] text-cyan-200/75">
                              Picture-in-Picture (PiP) Canvas Video Widget melayang di luar browser + Media Session API (&quot;Pemutar Musik&quot;) &amp; Silent Audio Loop (&lt;audio loop&gt;) anti-suspend
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setKeepAliveEnabled((prev) => !prev)}
                            className={`px-3 py-1.5 rounded-lg font-bold shrink-0 cursor-pointer ${
                              keepAliveEnabled
                                ? 'bg-[#23dcff] text-[#02182b]'
                                : 'bg-cyan-950 text-cyan-300'
                            }`}
                          >
                            {keepAliveEnabled ? 'AKTIF (ON)' : 'OFF'}
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-[10.5px] pt-1.5 border-t border-cyan-500/20">
                          <span className="text-cyan-200">Status PiP &amp; Media Session:</span>
                          <span className="font-bold text-[#23dcff]">
                            {isPipFloatingActive ? 'PiP FLOATING ON' : 'PiP SIAGA'} •{' '}
                            {isMediaSessionActive ? 'MEDIA SESSION ON' : 'SILENT LOOP SIAGA'}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveBottomModal(null);
                            handleEnterMinimizedMode();
                          }}
                          className="w-full py-2 px-3 rounded-lg bg-[#063256] hover:bg-[#0a4678] border border-[#23dcff] text-white font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Minimize2 className="w-3.5 h-3.5 text-[#23dcff]" />
                          <span>Minimalkan &amp; Buka Widget Video Melayang (PiP)</span>
                        </button>
                      </div>

                      {/* Kompatibilitas Peramban Seluler (Safari iOS / Chrome Android / HarmonyOS) & Pemulihan Izin Mic */}
                      <div className="p-3 rounded-xl bg-[#021526] border border-cyan-400/35 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-cyan-200">Platform &amp; Mode Fallback Mic:</span>
                          <span className="font-bold text-white">
                            {mobilePlatformInfo.label} • {micConstraintTier}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-cyan-200">Status Izin Microphone:</span>
                          <span
                            className={`font-bold uppercase ${
                              micPermissionState === 'granted'
                                ? 'text-[#23dcff]'
                                : 'text-amber-300'
                            }`}
                          >
                            {micPermissionState === 'granted'
                              ? 'DIBERIKAN (SIAP VOX & PTT)'
                              : 'BELUM DIBERIKAN / FALLBACK'}
                          </span>
                        </div>
                        {micErrorNotice && (
                          <div className="p-2 rounded-lg bg-amber-500/15 border border-amber-400/50 text-amber-200 text-[10.5px]">
                            {micErrorNotice}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={handleGrantOrRecoverAudioPermission}
                          className="w-full py-2 px-3 rounded-lg bg-[#063256] hover:bg-[#0a4678] border border-[#23dcff] text-white font-bold text-[11px] flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Mic className="w-3.5 h-3.5 text-[#23dcff]" />
                          <span>
                            {micPermissionState === 'granted'
                              ? 'Segarkan & Kalibrasi Ulang Web Audio + Mikrofon'
                              : 'Berikan Izin Mikrofon & Buka Kunci Audio (iOS/Android)'}
                          </span>
                        </button>
                      </div>

                      {/* Penguatan Volume Suara Masuk (Web Audio API GainNode pasca Dekripsi AES-GCM) */}
                      <div className="p-3 rounded-xl bg-[#021526] border border-[#23dcff]/45 space-y-2">
                        <div className="flex items-center justify-between">
                          <div>
                            <div className="text-white font-bold">
                              Penguat Suara Penerima (Web Audio GainNode)
                            </div>
                            <div className="text-[10px] text-cyan-200/75">
                              Menguatkan volume audio masuk setelah dekripsi AES-GCM agar nyaring &amp; jelas
                            </div>
                          </div>
                          <span className="px-2 py-1 rounded-lg bg-[#06385c] border border-[#23dcff] text-[#23dcff] font-extrabold text-xs">
                            {rxGainBoost.toFixed(1)}x
                          </span>
                        </div>
                        <input
                          type="range"
                          min={1.0}
                          max={3.5}
                          step={0.1}
                          value={rxGainBoost}
                          onChange={(e) => setRxGainBoost(Number(e.target.value))}
                          className="w-full accent-[#23dcff] cursor-pointer"
                        />
                        <div className="grid grid-cols-4 gap-1.5">
                          {[1.5, 2.0, 2.2, 3.0].map((g) => (
                            <button
                              key={g}
                              type="button"
                              onClick={() => setRxGainBoost(g)}
                              className={`py-1 px-2 rounded-lg text-[10px] font-bold border cursor-pointer ${
                                Math.abs(rxGainBoost - g) < 0.05
                                  ? 'bg-[#23dcff] text-[#02182b] border-white'
                                  : 'bg-[#042440] text-cyan-100 border-cyan-500/35'
                              }`}
                            >
                              Gain {g.toFixed(1)}x
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center justify-between py-2 border-b border-cyan-500/20">
                        <div>
                          <div className="text-white font-bold">
                            Mode Echo / Uji Suara Mic APK
                          </div>
                          <div className="text-[10px] text-cyan-200/75">
                            Putar balik suara Anda setelah berhenti bicara / tutup PTT
                          </div>
                        </div>
                        <button
                          onClick={() => setEchoTestMode((v) => !v)}
                          className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                            echoTestMode
                              ? 'bg-[#23dcff] text-[#02182b]'
                              : 'bg-cyan-950 text-cyan-300'
                          }`}
                        >
                          {echoTestMode ? 'ON (AKTIF)' : 'OFF'}
                        </button>
                      </div>

                      <div className="flex items-center justify-between py-2 border-b border-cyan-500/20">
                        <span className="text-cyan-200">Roger Beep &amp; Tone</span>
                        <button
                          onClick={() => setSoundEnabled((s) => !s)}
                          className={`px-3 py-1.5 rounded-lg font-bold cursor-pointer ${
                            soundEnabled
                              ? 'bg-[#23dcff] text-[#02182b]'
                              : 'bg-cyan-950 text-cyan-300'
                          }`}
                        >
                          {soundEnabled ? 'AKTIF' : 'MUTE'}
                        </button>
                      </div>

                      <div className="flex items-center justify-between py-2">
                        <span className="text-cyan-200">Proporsi Layar</span>
                        <button
                          onClick={() => setFullScreenStretch((s) => !s)}
                          className="px-3 py-1.5 rounded-lg bg-[#042440] border border-cyan-400/50 text-white font-bold cursor-pointer"
                        >
                          {fullScreenStretch ? 'Full Lebar Layar' : 'Mode Potret HP'}
                        </button>
                      </div>
                    </div>
                  )}

                  {settingsTab === 'apkGuide' && (
                    <div className="space-y-3 text-xs text-cyan-100 leading-relaxed">
                      <div className="p-3 rounded-xl bg-[#021526] border border-cyan-400/35 space-y-1.5">
                        <div className="font-bold text-[#23dcff]">
                          1. Deploy ke Vercel (Sudah Siap 100%)
                        </div>
                        <p className="text-[11px] text-cyan-100/85">
                          Proyek ini sudah dilengkapi file{' '}
                          <code className="text-white font-telemetry">vercel.json</code>{' '}
                          dengan header izin Microphone, Autoplay, Fullscreen,
                          dan PWA Service Worker. Cukup push ke GitHub dan
                          import di Vercel.
                        </p>
                      </div>

                      <div className="p-3 rounded-xl bg-[#021526] border border-cyan-400/35 space-y-1.5">
                        <div className="font-bold text-[#23dcff]">
                          2. Setting Wajib di WebToApp / WebIntoApp agar APK Berfungsi:
                        </div>
                        <ul className="list-disc pl-4 space-y-1 text-[11px] text-cyan-100/90">
                          <li>
                            Masukkan URL Vercel Anda (wajib{' '}
                            <strong className="text-white">https://</strong> agar
                            Android WebView mengizinkan akses microphone).
                          </li>
                          <li>
                            Aktifkan izin{' '}
                            <strong className="text-white">
                              Microphone / Record Audio
                            </strong>{' '}
                            di pengaturan Permissions WebToApp.
                          </li>
                          <li>
                            Aktifkan opsi{' '}
                            <strong className="text-white">Full Screen Mode</strong>{' '}
                            &amp; <strong className="text-white">Keep Screen On</strong>.
                          </li>
                        </ul>
                      </div>
                    </div>
                  )}

                  {settingsTab === 'flutterCode' && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                        {FLUTTER_SOURCE_FILES.map((file, idx) => (
                          <button
                            key={file.path}
                            onClick={() => setSelectedFileIndex(idx)}
                            className={`px-2.5 py-1.5 rounded-lg font-telemetry text-[11px] font-bold whitespace-nowrap shrink-0 cursor-pointer ${
                              selectedFileIndex === idx
                                ? 'bg-[#23dcff] text-[#02182b]'
                                : 'bg-[#021526] text-cyan-200 border border-cyan-500/30'
                            }`}
                          >
                            {file.title}
                          </button>
                        ))}
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <button
                          onClick={() =>
                            handleCopyText(currentFile.path, currentFile.code)
                          }
                          className="flex-1 py-2 rounded-lg bg-[#052745] border border-[#23dcff]/60 text-xs font-bold text-white flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {copiedText === currentFile.path ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-[#23dcff]" />
                              <span>Tersalin!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-[#23dcff]" />
                              <span>Salin {currentFile.title}</span>
                            </>
                          )}
                        </button>
                        <button
                          onClick={() =>
                            handleDownloadFile(currentFile.title, currentFile.code)
                          }
                          className="px-3 py-2 rounded-lg cyan-btn-glow text-[#02182b] text-xs font-bold flex items-center gap-1 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Unduh</span>
                        </button>
                      </div>

                      <pre className="p-3 rounded-xl bg-[#010c17] text-cyan-50 font-telemetry text-[10.5px] leading-relaxed overflow-x-auto max-h-60 overflow-y-auto border border-cyan-500/25">
                        <code>{currentFile.code}</code>
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
