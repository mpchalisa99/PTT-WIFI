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
  detectMobileAudioPlatform,
  getOrCreateCompatibleAudioContext,
  unlockMobileAudioSession,
  requestMicrophoneWithFallbacks,
  getSupportedAudioMimeType,
  encodePcmChunksToWavBlob,
  ensureHtmlAudioElementGainBooster,
  playBase64AudioViaWebAudioFallback,
  createSilentKeepAliveController,
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
const PASSCODE_HARIAN = 'DISKOMLEKAU';

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

  const [pingMs, setPingMs] = useState<number>(24);
  const [pingDelta, setPingDelta] = useState<number>(4);
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
  const [micLevel, setMicLevel] = useState<number>(0);
  const [micPermissionState, setMicPermissionState] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [micConstraintTier, setMicConstraintTier] = useState<string>('STANDBY');
  const [micErrorNotice, setMicErrorNotice] = useState<string | null>(null);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  // Default Echo Test to false so real Walkie-Talkie operation never echoes local speech
  const [echoTestMode, setEchoTestMode] = useState<boolean>(false);
  const [connectedPeersCount, setConnectedPeersCount] = useState<number>(0);

  // Background Keep-Alive (Silent Audio Stream via Web Audio API on visibilitychange / Screen Off / Pocket Mode)
  const [keepAliveEnabled, setKeepAliveEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('diskomlekau_keepalive_enabled');
    return saved !== null ? saved === 'true' : true;
  });
  const [isSilentKeepAliveRunning, setIsSilentKeepAliveRunning] = useState<boolean>(false);
  const [isBackgroundMode, setIsBackgroundMode] = useState<boolean>(false);
  const keepAliveEnabledRef = useRef<boolean>(keepAliveEnabled);
  const keepAliveSessionRef = useRef<SilentKeepAliveSession | null>(null);

  // VOX (Voice Activity Detection) Hands-Free Web Audio API states (Active by default)
  const [voxEnabled, setVoxEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('diskomlekau_vox_enabled');
    return saved !== null ? saved === 'true' : true;
  });
  const [voxThreshold, setVoxThreshold] = useState<number>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_vox_threshold'));
    // Migrasi nilai default lama (18% / 25%) ke standar preset TENANG 24% (THR 24%)
    if (saved === 18 || saved === 25) return 24;
    return saved >= 5 && saved <= 85 ? saved : 24;
  });
  const [voxHoldMs, setVoxHoldMs] = useState<number>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_vox_hold_ms'));
    return saved >= 500 && saved <= 3000 ? saved : 1100;
  });
  // Penguatan Volume Penerima Suara (Web Audio API GainNode: default gain.value = 2.2)
  const [rxGainBoost, setRxGainBoost] = useState<number>(() => {
    const saved = Number(localStorage.getItem('diskomlekau_rx_gain'));
    return saved >= 1.0 && saved <= 4.0 ? saved : 2.2;
  });
  const [voxInputLevel, setVoxInputLevel] = useState<number>(0);
  // Adaptive Noise Floor (Kalibrasi Otomatis Kebisingan Latar Belakang) & Effective Dynamic Threshold
  const [ambientNoiseFloor, setAmbientNoiseFloor] = useState<number>(6);
  const [effectiveVoxThreshold, setEffectiveVoxThreshold] = useState<number>(24);
  const [isVocalPatternConfirmed, setIsVocalPatternConfirmed] = useState<boolean>(false);

  const getVoxNoiseGateLabel = (thr: number) => {
    if (thr <= 28) return 'TENANG';
    if (thr <= 48) return 'KERAMAIAN';
    return 'ANGIN/MOTOR';
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
  const lastVoiceActiveTimeRef = useRef<number>(0);
  const voxVoiceFramesRef = useRef<number>(0);
  // Refs untuk Adaptive Noise Floor Calibration & Voice Pattern Verification (Hysteresis 175-200ms)
  const ambientNoiseFloorRef = useRef<number>(6);
  const noiseCalibrationSamplesRef = useRef<number[]>([]);
  const isInitialNoiseCalibratingRef = useRef<boolean>(true);
  const voiceOnsetStartTimeRef = useRef<number>(0);
  const lastVocalDipTimeRef = useRef<number>(0);
  const isVoxTriggeredTxRef = useRef<boolean>(false);
  const rxCooldownUntilRef = useRef<number>(0);
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

  // Persist VOX, Keep-Alive & Receiver GainNode Boost settings & sync refs
  useEffect(() => {
    voxEnabledRef.current = voxEnabled;
    voxThresholdRef.current = voxThreshold;
    voxHoldMsRef.current = voxHoldMs;
    keepAliveEnabledRef.current = keepAliveEnabled;
    rxGainBoostRef.current = rxGainBoost;
    try {
      localStorage.setItem('diskomlekau_vox_enabled', String(voxEnabled));
      localStorage.setItem('diskomlekau_vox_threshold', String(voxThreshold));
      localStorage.setItem('diskomlekau_vox_hold_ms', String(voxHoldMs));
      localStorage.setItem('diskomlekau_keepalive_enabled', String(keepAliveEnabled));
      localStorage.setItem('diskomlekau_rx_gain', String(rxGainBoost));
    } catch {
      // Ignore storage error
    }
  }, [voxEnabled, voxThreshold, voxHoldMs, keepAliveEnabled, rxGainBoost]);

  // Persist tactical chat messages & auto-scroll to latest message
  useEffect(() => {
    try {
      localStorage.setItem(
        'tactical_wicomm_chat_v1',
        JSON.stringify(chatMessages.slice(-80))
      );
    } catch {
      // Ignore quota error
    }
    onScreenChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    modalChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Request Screen Wake Lock so HP screen stays on in APK/fullscreen mode & re-acquire on visibilitychange
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Ignore if not supported in current browser frame
      }
    };
    requestWakeLock();
    const handleVisibilityWakeLock = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityWakeLock);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityWakeLock);
      wakeLock?.release().catch(() => {});
    };
  }, []);

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

  // Helper to immediately mute & shut off Receiver (both HTMLAudioElement & Web Audio BufferSource) during PTT/VOX Open
  const muteAndDisableReceiver = useCallback(() => {
    isReceiverOffRef.current = true;
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

  // Play incoming Base64 voice clip received from another device (Compatible with Safari iOS, Chrome Android/HarmonyOS & Background Pocket Mode)
  const playIncomingAudioBase64 = useCallback(
    (base64Data: string, senderCallsign: string, senderDeviceId?: string) => {
      if (!soundEnabled) return;
      // STRICT ANTI-ECHO: While PTT/VOX is open (TX active / Receiver OFF), NEVER play any speaker audio!
      if (isTransmittingRef.current || isReceiverOffRef.current) return;

      // Temporarily lock channel & gate VOX while speaker is playing incoming audio so RX speaker never triggers nearby VOX
      const now = Date.now();
      rxCooldownUntilRef.current = now + 3000;
      voxVoiceFramesRef.current = 0;
      setVoxInputLevel(0);
      if (senderDeviceId) {
        const lockObj: ChannelLockInfo = {
          senderId: senderDeviceId,
          callsign: senderCallsign,
          startedAt: channelLockOwnerRef.current?.startedAt || now,
          updatedAt: now,
        };
        channelLockOwnerRef.current = lockObj;
        setChannelLockOwner(lockObj);
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      playTacticalTone('rx');
      setIncomingSpeaker(senderCallsign);

      // Stop any previous RX playback first
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

      let hasReleased = false;
      const releaseChannelLockAndRestoreVox = () => {
        if (hasReleased) return;
        hasReleased = true;
        activeWebAudioRxStopRef.current = null;
        // 650ms Anti-Feedback Acoustic Decay Guard after speaker finishes playing
        rxCooldownUntilRef.current = Date.now() + 650;
        if (
          !remoteActiveTxRef.current ||
          remoteActiveTxRef.current === senderCallsign
        ) {
          remoteActiveTxRef.current = null;
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          setIncomingSpeaker((curr) => (curr === senderCallsign ? null : curr));
        }
        window.setTimeout(() => {
          if (
            voxEnabledRef.current &&
            !isTransmittingRef.current &&
            !remoteActiveTxRef.current &&
            !channelLockOwnerRef.current &&
            mediaStreamRef.current
          ) {
            mediaStreamRef.current.getAudioTracks().forEach((track) => {
              track.enabled = true;
            });
          }
        }, 620);
      };

      const handlePlaybackFinished = () => {
        releaseChannelLockAndRestoreVox();
        if (!isTransmittingRef.current && !isReceiverOffRef.current) {
          playTacticalTone('end');
        }
      };

      // Fallback helper using HTMLAudioElement routed through Web Audio API GainNode (gain.value = 2.2+)
      const playViaHtmlAudioWithGainFallback = () => {
        if (isTransmittingRef.current || isReceiverOffRef.current) {
          releaseChannelLockAndRestoreVox();
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
          audio.src = base64Data;
          audio.muted = false;
          audio.volume = 1.0;

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
          audio.onended = handlePlaybackFinished;
          audio.onerror = () => {
            releaseChannelLockAndRestoreVox();
          };

          const playPromise = audio.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              releaseChannelLockAndRestoreVox();
            });
          }
        } catch {
          releaseChannelLockAndRestoreVox();
        }
      };

      // Primary Receiver Decoder: Web Audio API decodeAudioData -> Vocal Clarity EQ -> GainNode (gain.value = 2.2+) -> Limiter -> Destination
      // Memastikan suara setelah dekripsi AES-GCM terdengar nyaring, jernih, dan penuh di semua perangkat!
      (async () => {
        if (isTransmittingRef.current || isReceiverOffRef.current) {
          releaseChannelLockAndRestoreVox();
          return;
        }
        const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
        if (!ctx) {
          playViaHtmlAudioWithGainFallback();
          return;
        }
        audioCtxRef.current = ctx;
        const handle = await playBase64AudioViaWebAudioFallback(
          ctx,
          base64Data,
          handlePlaybackFinished,
          rxGainBoostRef.current || 2.2
        );
        if (handle) {
          activeWebAudioRxStopRef.current = handle.stop;
        } else {
          // Jika format kontainer membutuhkan dekoder HTMLAudioElement, putar via HTMLAudioElement + Web Audio GainNode
          playViaHtmlAudioWithGainFallback();
        }
      })();
    },
    [soundEnabled, playTacticalTone]
  );

  // Helper to check if an incoming transmission packet collides with an already-active channel lock holder
  const isCollidingTransmissionPacket = useCallback(
    (pkt: MeshPacket): boolean => {
      if (pkt.channel !== channel) return false;
      const isTxPacket =
        pkt.type === 'TX_START' ||
        pkt.type === 'PTT_START' ||
        pkt.type === 'CHANNEL_LOCK' ||
        pkt.type === 'VOICE_CLIP';
      if (!isTxPacket) return false;

      const pktStartTs = pkt.lockStartedAt || pkt.timestamp || Date.now();

      // 1. If THIS device is already transmitting on the channel, check who claimed the floor first
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
        ip: localIp,
        role,
        isMaster: localIp === '192.168.43.1' || role === 'MASTER',
        channel,
        timestamp: Date.now(),
        peerNodeId: myPeerNodeId,
      };

      const serialized = JSON.stringify(fullPacket);

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
        } catch {
          // Ignore local WS send error
        }
      }

      // 5. WSS Cloud Mesh Brokers (when internet is available)
      mqttClientsRef.current.forEach((client) => {
        if (client && client.connected) {
          try {
            client.publish(CLOUD_MESH_TOPIC, serialized, { qos: 0 });
          } catch {
            // Ignore publish error
          }
        }
      });
    },
    [myDeviceId, myCallsign, localIp, role, channel, myPeerNodeId]
  );

  // Build and broadcast PEER_LIST_SYNC from Master to all connected Clients
  const broadcastPeerListSync = useCallback(
    (overrideMembers?: TacticalMember[]) => {
      if (role !== 'MASTER' && localIp !== '192.168.43.1') return;
      if (!myCallsign) return;

      const currentList = overrideMembers ?? membersRef.current;
      const syncList: PeerSyncEntry[] = [
        {
          peerId: myPeerNodeId,
          senderId: myDeviceId,
          callsign: myCallsign,
          ip: localIp,
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
    [role, localIp, myCallsign, myPeerNodeId, myDeviceId, channel, broadcastMeshPacket]
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
        const foundIp = await detectLocalHotspotIpWebRTC(500);
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
      await pc.setLocalDescription(offer);
      const gatheredCandidates = await gatherLocalIceCandidatesExplicit(pc, 750);

      const localSdp = pc.localDescription?.sdp || offer.sdp || '';
      if (localSdp) {
        const effectiveIp = detectedLanIpRef.current || localIp;
        const microToken = buildMicroOfflineToken({
          type: 'O',
          callsign: myCallsign,
          deviceId: myDeviceId,
          ip: effectiveIp,
          channel,
          slotId,
          sdp: localSdp,
          gatheredCandidates,
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
      if (!remotePeerId || remotePeerId === myPeerNodeId) return;
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
    [myPeerNodeId, registerPeerConnection]
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
        setMembers((prev) => prev.filter((m) => m.id !== pkt.senderId));
        if (channelLockOwnerRef.current?.senderId === pkt.senderId) {
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          remoteActiveTxRef.current = null;
          setIncomingSpeaker(null);
        }
        return;
      }

      const amIMaster = localIp === '192.168.43.1' || role === 'MASTER';
      const senderIsMaster =
        pkt.ip === '192.168.43.1' ||
        pkt.role === 'MASTER' ||
        pkt.peerNodeId === MASTER_PEER_ID ||
        Boolean(pkt.isMaster);

      if (pkt.type === 'ANNOUNCE') {
        const senderPeerId = pkt.peerNodeId || pkt.senderId;
        const now = Date.now();
        setMembers((prev) => {
          const exists = prev.some(
            (m) => m.id === pkt.senderId || m.peerId === senderPeerId
          );
          const next = exists
            ? prev.map((m) =>
                m.id === pkt.senderId || m.peerId === senderPeerId
                  ? {
                      ...m,
                      id: pkt.senderId,
                      callsign: pkt.callsign,
                      ip: pkt.ip,
                      role: pkt.role,
                      channel: pkt.channel,
                      peerId: senderPeerId,
                      lastSeen: now,
                    }
                  : m
              )
            : [
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
        if (now - lastReply > 1500 && myCallsign) {
          lastAnnounceReplyRef.current.set(pkt.senderId, now);
          broadcastMeshPacket({ type: 'ANNOUNCE' });
        }
        return;
      }

      if (pkt.type === 'PEER_LIST_SYNC' && Array.isArray(pkt.peerList)) {
        const now = Date.now();
        const incomingPeers = pkt.peerList.filter(
          (entry) =>
            entry.senderId !== myDeviceId && entry.peerId !== myPeerNodeId
        );

        setMembers((prev) => {
          const updated: TacticalMember[] = [...prev];
          incomingPeers.forEach((entry) => {
            const idx = updated.findIndex(
              (m) => m.id === entry.senderId || m.peerId === entry.peerId
            );
            if (idx >= 0) {
              updated[idx] = {
                ...updated[idx],
                id: entry.senderId,
                callsign: entry.callsign,
                ip: entry.ip,
                role: entry.role,
                channel: entry.channel,
                peerId: entry.peerId,
                lastSeen: now,
              };
            } else {
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
          return updated;
        });

        // Form direct P2P WebRTC connections with all other peers discovered via PEER_LIST_SYNC
        incomingPeers.forEach((entry) => {
          if (entry.peerId && entry.peerId.startsWith('PTT-')) {
            connectToPeerNodeIfNeeded(entry.peerId);
          }
        });
        return;
      }

      // Refresh lastSeen for any active packet from this sender
      setMembers((prev) =>
        prev.map((m) =>
          m.id === pkt.senderId ? { ...m, lastSeen: Date.now() } : m
        )
      );

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

      if (
        pkt.type === 'TX_START' ||
        pkt.type === 'PTT_START' ||
        pkt.type === 'CHANNEL_LOCK'
      ) {
        const now = Date.now();
        const incomingStartTs = pkt.lockStartedAt || pkt.timestamp || now;
        const existingLock = channelLockOwnerRef.current;

        // 1. Check if ANOTHER peer already holds the Channel Lock (First-Speaker-Wins Anti-Collision)
        if (
          existingLock &&
          existingLock.senderId !== pkt.senderId &&
          now - existingLock.updatedAt < 12000
        ) {
          const existingStartedFirst =
            existingLock.startedAt <= incomingStartTs ||
            existingLock.senderId < pkt.senderId;
          if (existingStartedFirst) {
            // Ignore colliding transmission from the 2nd peer & notify them that channel is busy/locked
            broadcastMeshPacket({
              type: 'CHANNEL_BUSY',
              lockOwnerId: existingLock.senderId,
              lockOwnerCallsign: existingLock.callsign,
              lockStartedAt: existingLock.startedAt,
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
            // THIS device started transmitting first -> keep channel lock, ignore remote colliding TX, and notify them!
            broadcastMeshPacket({
              type: 'CHANNEL_BUSY',
              lockOwnerId: myDeviceId,
              lockOwnerCallsign: myCallsign,
              lockStartedAt: myStartTs,
            });
            return;
          } else {
            // Remote peer started transmitting first -> abort our local TX (discard clip) & yield channel lock!
            forceStopLocalRecording(true);
            setCollisionBlockedNotice(
              `ANTI-COLLISION: ${pkt.callsign} LEBIH DULU MENGUNCI SALURAN`
            );
            window.setTimeout(() => setCollisionBlockedNotice(null), 2200);
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
        };
        channelLockOwnerRef.current = lockObj;
        setChannelLockOwner(lockObj);
        remoteActiveTxRef.current = pkt.callsign;
        setIncomingSpeaker(pkt.callsign);

        // Immediately lock out local VOX & mute hardware mic track so nearby devices never feedback!
        voxVoiceFramesRef.current = 0;
        setVoxInputLevel(0);
        rxCooldownUntilRef.current = now + 2500;
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
        const activeAudio = activeAudioElementRef.current;
        if (!activeAudio || activeAudio.paused || activeAudio.ended) {
          channelLockOwnerRef.current = null;
          setChannelLockOwner(null);
          setIncomingSpeaker((curr) => (curr === pkt.callsign ? null : curr));
          window.setTimeout(() => {
            if (
              voxEnabledRef.current &&
              !isTransmittingRef.current &&
              !remoteActiveTxRef.current &&
              !channelLockOwnerRef.current &&
              mediaStreamRef.current
            ) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            }
          }, 620);
        }
      } else if (
        pkt.type === 'VOICE_CLIP' &&
        (pkt.encryptedAudio || pkt.audioBase64)
      ) {
        // 1. STRICT ANTI-ECHO: While local PTT/VOX is open (Receiver OFF), drop incoming voice playback completely
        if (isTransmittingRef.current || isReceiverOffRef.current) {
          return;
        }
        // 2. STRICT ANTI-COLLISION: If another client holds the Channel Lock, ignore colliding audio clips!
        const existingLock = channelLockOwnerRef.current;
        if (
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
            playIncomingAudioBase64(decryptedBase64, pkt.callsign, pkt.senderId);
          });
        } else if (pkt.audioBase64) {
          playIncomingAudioBase64(pkt.audioBase64, pkt.callsign, pkt.senderId);
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

  // Keep latest packet handler in a ref so sockets never get destroyed on state updates
  const packetHandlerRef = useRef(handleIncomingMeshPacket);
  useEffect(() => {
    packetHandlerRef.current = handleIncomingMeshPacket;
  }, [handleIncomingMeshPacket]);

  const announcePacketBuilderRef = useRef<() => MeshPacket | null>(() => null);
  useEffect(() => {
    announcePacketBuilderRef.current = () => {
      if (!myCallsign || !isPasscodeAuthenticated) return null;
      return {
        packetId: `${myDeviceId}-${Date.now()}-ann`,
        type: 'ANNOUNCE',
        senderId: myDeviceId,
        callsign: myCallsign,
        ip: localIp,
        role,
        channel,
        timestamp: Date.now(),
        peerNodeId: myPeerNodeId,
      };
    };
  }, [myDeviceId, myCallsign, isPasscodeAuthenticated, localIp, role, channel, myPeerNodeId]);

  // Hybrid Cloud + Offline Hotspot LAN Signaling Engine + Auto-Reconnect Watchdog (2.5s):
  // Wajib terautentikasi Passcode Operasional ("DISKOMLEKAU") sebelum WebSocket/WebRTC diizinkan aktif!
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;

    let isCancelled = false;

    // Pre-generate Offline Hotspot WebRTC Offer so QR Barcode works 100% offline without internet
    prepareNextOfflineMasterOffer();

    // Auto-detect real Hotspot IP via local WebRTC host ICE candidate & probe Local Hotspot WS Hub
    let detectedSubnetGateway = '192.168.43.1';
    detectLocalHotspotIpWebRTC().then((detectedIp) => {
      if (isCancelled || !detectedIp) return;
      detectedLanIpRef.current = detectedIp;
      if (role === 'CLIENT' && localIp.startsWith('192.168.43.') && detectedIp !== '192.168.43.1') {
        setLocalIp(detectedIp);
      }
      const parts = detectedIp.split('.');
      if (parts.length === 4) {
        detectedSubnetGateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
      }
      // Refresh Master Offline Offer once real LAN IP is known
      prepareNextOfflineMasterOffer();
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
            setIsHotspotLanHubConnected(true);
            const pkt = announcePacketBuilderRef.current();
            if (pkt) {
              try {
                ws.send(JSON.stringify(pkt));
              } catch {
                // Ignore
              }
            }
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
              setIsHotspotLanHubConnected(false);
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

    // 2. Dual-Broker WSS Cloud Mesh (100% reliable on Vercel across all Android/iOS mobile carriers)
    const activeMqttClients: MqttClient[] = [];
    WSS_CLOUD_BROKERS.forEach((brokerUrl, idx) => {
      try {
        const client = mqtt.connect(brokerUrl, {
          clientId: `dskm-${myDeviceId.toLowerCase()}-${idx}-${Math.random()
            .toString(36)
            .substring(2, 6)}`,
          clean: true,
          keepalive: 30,
          reconnectPeriod: 2500,
          connectTimeout: 8000,
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
        connectToPeerNodeIfNeeded(MASTER_PEER_ID);
      }

      // Connect to custom Barcode invitedHostPeer if specified
      if (
        invitedHostPeer &&
        invitedHostPeer !== MASTER_PEER_ID &&
        invitedHostPeer !== myCurrentId
      ) {
        connectToPeerNodeIfNeeded(invitedHostPeer);
      }

      // Also ensure direct P2P connections to any already-known members
      membersRef.current.forEach((m) => {
        if (
          m.peerId &&
          m.peerId.startsWith('PTT-') &&
          m.peerId !== myCurrentId
        ) {
          connectToPeerNodeIfNeeded(m.peerId);
        }
      });
    };

    const initializePeerNode = (candidateId: string, allowFallback: boolean) => {
      if (isCancelled) return;
      boundId = candidateId;
      setActiveBoundPeerId(candidateId);

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
        setActiveBoundPeerId(openedId);
        connectToMasterAndPeers(peer, openedId);
      });

      peer.on('connection', (conn) => {
        registerPeerConnection(conn);
      });

      peer.on('disconnected', () => {
        if (!isCancelled && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch {
            // 2.5s watchdog will retry
          }
        }
      });

      peer.on('error', (err: { type?: string }) => {
        if (isCancelled) return;
        // Critical fix for Vercel: if 'PTT-MASTER-01' is already taken (by another HP or a recent page reload),
        // automatically bind uniqueClientPeerId and connect to 'PTT-MASTER-01' so the device never gets stuck!
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
            // 2.5s watchdog will retry
          }
        }
      });
    };

    initializePeerNode(boundId, isMasterRole);

    // 4. 2.5-second Watchdog Interval + Stale Peer Pruner
    const watchdogTimer = window.setInterval(() => {
      if (isCancelled) return;
      tryConnectLocalHotspotWsHub();
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
        broadcastPeerListSync();
      }

      // Prune peers that have neither an open WebRTC/Offline LAN DataChannel nor a recent ANNOUNCE (> 12s)
      const now = Date.now();
      // Auto-release stale Channel Lockout if remote transmitter dropped offline without sending TX_STOP (> 12s)
      if (
        channelLockOwnerRef.current &&
        now - channelLockOwnerRef.current.updatedAt > 12000
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
        const filtered = prev.filter((m) => {
          const hasOpenRtc =
            (m.peerId && peerConnectionsRef.current.get(m.peerId)?.open) ||
            peerConnectionsRef.current.get(m.id)?.open ||
            anyOfflineDcOpen;
          const recentlySeen = now - (m.lastSeen || now) < 12000;
          return Boolean(hasOpenRtc || recentlySeen);
        });
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 2500);

    // Send graceful PEER_LEAVE on tab/app close so other phones update immediately
    const handleBeforeUnload = () => {
      broadcastMeshPacket({ type: 'PEER_LEAVE' });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      isCancelled = true;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      window.clearInterval(watchdogTimer);
      broadcastChannelRef.current?.close();
      peerConnectionsRef.current.clear();
      pendingConnectTimestampRef.current.clear();
      localHotspotWsRef.current?.close();
      localHotspotWsRef.current = null;
      setConnectedPeersCount(offlineRtcChannelsRef.current.size);
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
    localIp,
    uniqueClientPeerId,
    invitedHostPeer,
    registerPeerConnection,
    connectToPeerNodeIfNeeded,
    broadcastPeerListSync,
    broadcastMeshPacket,
    prepareNextOfflineMasterOffer,
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

  // UNIVERSAL CHANNEL LOCKOUT / ANTI-COLLISION:
  // When any peer on the same channel is actively transmitting, lock the channel for ALL other peers
  // (blocking both VOX triggers and overlapping transmissions until the active transmission finishes).
  const activeLockSpeaker =
    incomingSpeaker ||
    (channelLockOwner && channelLockOwner.senderId !== myDeviceId
      ? channelLockOwner.callsign
      : null);
  const isPttLocked = Boolean(activeLockSpeaker);

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

          // FILTER FREKUENSI VOKAL MANUSIA BERTINGKAT (300 Hz - 3.400 Hz) VIA WEB AUDIO API BiquadFilterNode:
          // Stage 1: High-Pass Filter (300 Hz, Butterworth Q = 0.707)
          // Memotong tuntas frekuensi di bawah 300 Hz (deru angin, gemuruh mesin motor/mobil, AC, dan getaran mekanis)
          const highpass300 = ctx.createBiquadFilter();
          highpass300.type = 'highpass';
          highpass300.frequency.value = 300;
          highpass300.Q.value = 0.707;

          // Stage 2: Low-Pass Filter (3.400 Hz, Butterworth Q = 0.707)
          // Memotong tuntas frekuensi di atas 3,4 kHz (desis frekuensi tinggi, gesekan saku/jaket, bunyi klik tajam)
          const lowpass3400 = ctx.createBiquadFilter();
          lowpass3400.type = 'lowpass';
          lowpass3400.frequency.value = 3400;
          lowpass3400.Q.value = 0.707;

          // Stage 3: Vocal Formant Bandpass Filter (terpusat pada 1.010 Hz — pusat geometrik 300Hz-3400Hz, Q = 0.65)
          // Mengisolasi pita energi fundamental & formant suara manusia sebelum masuk ke sensor VOX
          const vocalBandpass = ctx.createBiquadFilter();
          vocalBandpass.type = 'bandpass';
          vocalBandpass.frequency.value = 1010;
          vocalBandpass.Q.value = 0.65;

          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.3;

          source.connect(highpass300);
          highpass300.connect(lowpass3400);
          lowpass3400.connect(vocalBandpass);
          vocalBandpass.connect(analyser);

          micSourceRef.current = source;
          micFilterRef.current = vocalBandpass;
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
    let backgroundSocketHeartbeat: number | null = null;

    const syncKeepAliveState = () => {
      if (!keepAliveEnabled) {
        controller.stop();
        setIsSilentKeepAliveRunning(false);
        return;
      }
      const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (ctx) {
        audioCtxRef.current = ctx;
        controller.start(ctx);
        setIsSilentKeepAliveRunning(controller.isActive());
      }
    };

    syncKeepAliveState();

    const handleVisibilityChange = () => {
      const isHidden = document.visibilityState === 'hidden' || document.hidden;
      setIsBackgroundMode(isHidden);

      const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (ctx) {
        audioCtxRef.current = ctx;
        if (keepAliveEnabledRef.current) {
          controller.pulseOnVisibilityChange(ctx, isHidden);
          setIsSilentKeepAliveRunning(true);
        }
      }

      if (isHidden) {
        // Saat layar HP mati / masuk saku (background): jalankan detak jantung WebSocket/WebRTC tiap 4 detik
        // agar soket jaringan dan pemutaran suara masuk tetap hidup 100%
        if (backgroundSocketHeartbeat) {
          window.clearInterval(backgroundSocketHeartbeat);
        }
        broadcastMeshPacket({ type: 'ANNOUNCE' });
        backgroundSocketHeartbeat = window.setInterval(() => {
          // Pastikan AudioContext tidak dibekukan oleh OS
          if (audioCtxRef.current) {
            const st = audioCtxRef.current.state as string;
            if (st === 'suspended' || st === 'interrupted') {
              audioCtxRef.current.resume().catch(() => {});
            }
            if (keepAliveEnabledRef.current) {
              controller.pulseOnVisibilityChange(audioCtxRef.current, true);
            }
          }
          // Kirim paket keep-alive ANNOUNCE ke WebSocket / MQTT / WebRTC agar aliran data tetap aktif
          broadcastMeshPacket({ type: 'ANNOUNCE' });
          if (peerRef.current && peerRef.current.disconnected && !peerRef.current.destroyed) {
            try {
              peerRef.current.reconnect();
            } catch {
              // Ignore
            }
          }
        }, 4000);
      } else {
        // Saat layar HP kembali menyala (visible): bersihkan timer latar belakang & pulihkan AudioContext/Mic
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
          ensureWebAudioVoxGraph();
        }
        broadcastMeshPacket({ type: 'ANNOUNCE' });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);
    window.addEventListener('blur', handleVisibilityChange);
    window.addEventListener('focus', handleVisibilityChange);

    return () => {
      if (backgroundSocketHeartbeat) {
        window.clearInterval(backgroundSocketHeartbeat);
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      window.removeEventListener('blur', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, [
    isPasscodeAuthenticated,
    isSetupCompleted,
    myCallsign,
    keepAliveEnabled,
    broadcastMeshPacket,
    ensureWebAudioVoxGraph,
  ]);

  // Helper untuk mengenkripsi (AES-256-GCM via Web Crypto API) & mengirim Blob rekaman suara ke jaringan
  const dispatchRecordedVoiceBlob = useCallback(
    (blob: Blob) => {
      // Keep mic enabled ONLY if VOX is active and no incoming speaker is playing; otherwise disable track
      if (mediaStreamRef.current) {
        const keepOpenForVox =
          voxEnabledRef.current &&
          !remoteActiveTxRef.current &&
          !channelLockOwnerRef.current;
        mediaStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = keepOpenForVox;
        });
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

  // onStartTransmit (Dipanggil otomatis oleh VOX saat suara melewati threshold, atau saat Klik Pertama tombol PTT)
  const onStartTransmit = useCallback(
    async (triggerSource: 'VOX' | 'MANUAL' = 'MANUAL') => {
      if (isTransmittingRef.current) return;

      // 0. CHANNEL LOCKOUT / ANTI-COLLISION CHECK:
      // Reject VOX or manual PTT if another client is currently transmitting or playing audio on this channel
      const now = Date.now();
      const existingLock = channelLockOwnerRef.current;
      const isChannelLockedByOther =
        Boolean(remoteActiveTxRef.current) ||
        Boolean(
          existingLock &&
            existingLock.senderId !== myDeviceId &&
            now - existingLock.updatedAt < 12000
        ) ||
        Boolean(
          activeAudioElementRef.current &&
            !activeAudioElementRef.current.paused &&
            !activeAudioElementRef.current.ended
        ) ||
        Boolean(activeWebAudioRxStopRef.current) ||
        (triggerSource === 'VOX' && now < rxCooldownUntilRef.current);

      if (isChannelLockedByOther || isPttLocked) {
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
      remoteActiveTxRef.current = null;
      setIncomingSpeaker(null);
      setIsTransmitting(true);
      isTransmittingRef.current = true;
      isVoxTriggeredTxRef.current = triggerSource === 'VOX';
      lastVoiceActiveTimeRef.current = txStartTs;

      // 2. Klaim Penguncian Saluran (CHANNEL_LOCK + TX_START) ke seluruh klien WebSocket / WebRTC / Mesh
      broadcastMeshPacket({
        type: 'CHANNEL_LOCK',
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
        lockStartedAt: txStartTs,
      });
      broadcastMeshPacket({
        type: 'TX_START',
        lockOwnerId: myDeviceId,
        lockOwnerCallsign: myCallsign,
        lockStartedAt: txStartTs,
      });

      // 3. Heartbeat CHANNEL_LOCK setiap 2 detik selama transmisi aktif agar klien yang baru gabung tetap terkunci
      if (txLockHeartbeatRef.current) {
        window.clearInterval(txLockHeartbeatRef.current);
      }
      txLockHeartbeatRef.current = window.setInterval(() => {
        if (!isTransmittingRef.current) return;
        broadcastMeshPacket({
          type: 'CHANNEL_LOCK',
          lockOwnerId: myDeviceId,
          lockOwnerCallsign: myCallsign,
          lockStartedAt: localTxStartedAtRef.current,
        });
      }, 2000);

      try {
        const analyser = await ensureWebAudioVoxGraph();
        const stream = mediaStreamRef.current;
        const ctx = audioCtxRef.current;
        if (stream && analyser && ctx) {
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const updateMeter = () => {
            if (!isTransmittingRef.current) return;
            analyser.getByteFrequencyData(dataArray);
            const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
            setMicLevel(Math.min(100, Math.max(25, avg * 1.45)));
            animFrameRef.current = requestAnimationFrame(updateMeter);
          };
          updateMeter();

          // Negotiate best supported audio MIME type for Chrome (Android/HarmonyOS) or Safari (iOS)
          const negotiatedMime = getSupportedAudioMimeType();
          let startedMediaRecorder = false;

          if (typeof MediaRecorder !== 'undefined') {
            try {
              const segmentChunks: Blob[] = [];
              recordedChunksRef.current = segmentChunks;

              const recorderOptions: MediaRecorderOptions = {
                audioBitsPerSecond: 24000,
              };
              if (negotiatedMime) {
                recorderOptions.mimeType = negotiatedMime;
              }

              let recorder: MediaRecorder;
              try {
                recorder = new MediaRecorder(stream, recorderOptions);
              } catch {
                recorder = negotiatedMime
                  ? new MediaRecorder(stream, { mimeType: negotiatedMime })
                  : new MediaRecorder(stream);
              }

              recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) {
                  segmentChunks.push(e.data);
                }
              };

              recorder.onstop = () => {
                const effectiveMime =
                  recorder.mimeType || negotiatedMime || 'audio/mp4';
                const blob = new Blob(segmentChunks, { type: effectiveMime });
                dispatchRecordedVoiceBlob(blob);
              };

              mediaRecorderRef.current = recorder;
              recorder.start();
              startedMediaRecorder = true;
            } catch {
              startedMediaRecorder = false;
            }
          }

          // Fallback: Web Audio API ScriptProcessor PCM-to-WAV Recorder (for older iOS Safari / HarmonyOS WebViews)
          if (!startedMediaRecorder && micSourceRef.current) {
            pcmChunksRef.current = [];
            isPcmRecordingRef.current = true;
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            const zeroGain = ctx.createGain();
            zeroGain.gain.value = 0; // Mute output so mic never feeds back into local speaker!

            processor.onaudioprocess = (ev) => {
              if (!isPcmRecordingRef.current) return;
              const inputData = ev.inputBuffer.getChannelData(0);
              pcmChunksRef.current.push(new Float32Array(inputData));
            };

            micSourceRef.current.connect(processor);
            processor.connect(zeroGain);
            zeroGain.connect(ctx.destination);
            pcmProcessorRef.current = processor;
            pcmZeroGainRef.current = zeroGain;
          }
        } else {
          // If microphone permission is not yet granted, fallback visual meter so UI remains responsive
          const fallbackTick = () => {
            if (!isTransmittingRef.current) return;
            setMicLevel(Math.floor(40 + Math.random() * 55));
            animFrameRef.current = requestAnimationFrame(fallbackTick);
          };
          fallbackTick();
        }
      } catch {
        setMicPermissionState('denied');
        const fallbackTick = () => {
          if (!isTransmittingRef.current) return;
          setMicLevel(Math.floor(40 + Math.random() * 55));
          animFrameRef.current = requestAnimationFrame(fallbackTick);
        };
        fallbackTick();
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
    ]
  );

  // onStopTransmit (Dipanggil otomatis oleh VOX saat hening / berhenti bicara, atau saat Klik Kedua tombol PTT)
  const onStopTransmit = useCallback(() => {
    if (!isTransmittingRef.current) return;
    setIsTransmitting(false);
    isTransmittingRef.current = false;
    isVoxTriggeredTxRef.current = false;
    voxVoiceFramesRef.current = 0;
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

    // Jika VOX dimatikan, matikan track mikrofon hardware; jika VOX aktif, biarkan siap mendengarkan kalimat berikutnya
    if (mediaStreamRef.current && !voxEnabledRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    }

    // Hentikan perekam MediaRecorder & kirim paket VOICE_CLIP
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
  }, [
    myDeviceId,
    myCallsign,
    playTacticalTone,
    broadcastMeshPacket,
    dispatchRecordedVoiceBlob,
  ]);

  const handlePttStart = () => onStartTransmit('MANUAL');
  const handlePttEnd = () => onStopTransmit();

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
    if (isPttLocked) return;
    if (isTransmittingRef.current || isTransmitting) {
      onStopTransmit();
    } else {
      onStartTransmit('MANUAL');
    }
  };

  // MESIN UTAMA VOX CERDAS BERBASIS WEB AUDIO API:
  // 1. Adaptive Threshold / Noise Gate (Kalibrasi Otomatis Ambient Noise Floor)
  // 2. Bandpass Filter Vokal (300 Hz - 3.400 Hz)
  // 3. Voice Pattern Verification & Hysteresis Debounce (175-200 ms)
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;

    let isCancelled = false;
    let voxTimer: number | null = null;

    // Reset kalibrasi awal kebisingan latar belakang saat pertama kali terhubung
    isInitialNoiseCalibratingRef.current = true;
    noiseCalibrationSamplesRef.current = [];
    voiceOnsetStartTimeRef.current = 0;

    const startContinuousVoxMonitor = async () => {
      if (!voxEnabled && !isTransmittingRef.current) {
        setVoxInputLevel(0);
        setIsVocalPatternConfirmed(false);
        if (mediaStreamRef.current && !isTransmittingRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            t.enabled = false;
          });
        }
        return;
      }

      const analyser = await ensureWebAudioVoxGraph();
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

      voxTimer = window.setInterval(() => {
        if (isCancelled) return;

        // Auto-resume AudioContext if mobile browser (Safari iOS / Chrome Android / HarmonyOS) suspended or interrupted it
        if (audioCtxRef.current) {
          const st = audioCtxRef.current.state as string;
          if (st === 'suspended' || st === 'interrupted') {
            audioCtxRef.current.resume().catch(() => {});
          }
        }

        // Strict Channel Lockout & Half-Duplex Anti-Collision Gate:
        // Never allow VOX to sample or trigger while another peer holds the channel lock, is playing RX audio, or in cooldown
        const now = Date.now();
        const activeLock = channelLockOwnerRef.current;
        const isChannelLockedOrReceiving =
          Boolean(remoteActiveTxRef.current) ||
          Boolean(
            activeLock &&
              activeLock.senderId !== myDeviceId &&
              now - activeLock.updatedAt < 12000
          ) ||
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
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach((t) => {
              if (t.enabled) t.enabled = false;
            });
          }
          return;
        }

        // Re-enable mic track for VOX standby once channel lock & cooldown are completely clear
        if (
          voxEnabledRef.current &&
          !isTransmittingRef.current &&
          mediaStreamRef.current
        ) {
          mediaStreamRef.current.getAudioTracks().forEach((t) => {
            if (!t.enabled) t.enabled = true;
          });
        }

        analyser.getByteTimeDomainData(timeDomainBuf);
        analyser.getByteFrequencyData(freqDomainBuf);

        // 1. Hitung RMS Amplitude & Zero-Crossing Rate (ZCR) dari sinyal pasca-filter (300Hz - 3.4kHz)
        let sumSquares = 0;
        let zcrCount = 0;
        let prevSign = timeDomainBuf[0] >= 128 ? 1 : -1;
        for (let i = 0; i < timeDomainBuf.length; i++) {
          const sample = timeDomainBuf[i] - 128;
          const normalized = sample / 128;
          sumSquares += normalized * normalized;
          const currSign = sample >= 0 ? 1 : -1;
          if (currSign !== prevSign && Math.abs(sample) >= 2) {
            zcrCount += 1;
          }
          prevSign = currSign;
        }
        const rms = Math.sqrt(sumSquares / timeDomainBuf.length);

        // 2. Analisis Spektral Pita Vokal Manusia (300 Hz - 3.400 Hz) vs Pita Bising Luar (<300 Hz & >3.400 Hz)
        const sampleRate = audioCtxRef.current?.sampleRate || 48000;
        const binHz = sampleRate / analyser.fftSize; // ~93.75 Hz per bin (fftSize=512)
        const minVocalBin = Math.max(1, Math.floor(300 / binHz));
        const maxVocalBin = Math.min(
          freqDomainBuf.length - 1,
          Math.ceil(3400 / binHz)
        );

        let vocalBandSum = 0;
        let vocalBinCount = 0;
        let outBandSum = 0;
        let outBinCount = 0;

        for (let i = 0; i < freqDomainBuf.length; i++) {
          if (i >= minVocalBin && i <= maxVocalBin) {
            vocalBandSum += freqDomainBuf[i];
            vocalBinCount += 1;
          } else if (i < minVocalBin || i <= Math.min(freqDomainBuf.length - 1, maxVocalBin + 36)) {
            outBandSum += freqDomainBuf[i];
            outBinCount += 1;
          }
        }

        const vocalBandAvg = vocalBinCount > 0 ? vocalBandSum / vocalBinCount : 0;
        const outBandAvg = outBinCount > 0 ? outBandSum / outBinCount : 1;

        // Skor Energi Vokal Terfokus (0 - 100)
        const voiceEnergy = Math.min(
          100,
          Math.round(Math.max(rms * 245, vocalBandAvg * 0.88))
        );
        setVoxInputLevel(voiceEnergy);

        // 3. VERIFIKASI POLA VOKAL MANUSIA (Voice Pattern Verification):
        // Memastikan energi dominan berada di rentang vokal (300Hz-3.4kHz) dan frekuensi gelombang sesuai artikulasi suara manusia,
        // sehingga ketukan meja, batuk singkat, deru angin, atau suara bising jauh diabaikan.
        const spectralVocalRatio = vocalBandAvg / Math.max(1, outBandAvg);
        const isHumanZcrValid = zcrCount >= 4 && zcrCount <= 155;
        const isVocalPatternValid =
          spectralVocalRatio >= 1.15 &&
          isHumanZcrValid &&
          voiceEnergy >= Math.round(ambientNoiseFloorRef.current + 8);
        setIsVocalPatternConfirmed(isVocalPatternValid);

        // 4. ADAPTIVE THRESHOLD / NOISE GATE (Kalibrasi Otomatis Ambient Noise Floor):
        const baseThreshold = voxThresholdRef.current;

        if (!isTransmittingRef.current) {
          // Fase Kalibrasi Awal (~450ms pertama saat baru terhubung / belum bicara)
          if (isInitialNoiseCalibratingRef.current) {
            noiseCalibrationSamplesRef.current.push(voiceEnergy);
            if (noiseCalibrationSamplesRef.current.length >= 10) {
              const sorted = [...noiseCalibrationSamplesRef.current].sort(
                (a, b) => a - b
              );
              // Ambil persentil bawah-tengah (ke-4 dari 10 sampel) sebagai tingkat kebisingan dasar ruangan
              const calibratedFloor = Math.max(
                2,
                Math.min(48, sorted[3] ?? sorted[0] ?? 6)
              );
              ambientNoiseFloorRef.current = calibratedFloor;
              setAmbientNoiseFloor(Math.round(calibratedFloor));
              isInitialNoiseCalibratingRef.current = false;
            }
          } else if (voiceOnsetStartTimeRef.current === 0 || !isVocalPatternValid) {
            // Pembaruan Adaptif Kontinu saat tidak ada orang bicara (Asymmetric EMA):
            // Cepat turun jika lingkungan menjadi lebih hening, lambat naik jika bising latar konstan meningkat
            const currentFloor = ambientNoiseFloorRef.current;
            if (voiceEnergy <= currentFloor) {
              ambientNoiseFloorRef.current = Math.max(
                2,
                currentFloor * 0.85 + voiceEnergy * 0.15
              );
            } else if (voiceEnergy < baseThreshold + 10) {
              ambientNoiseFloorRef.current = Math.min(
                52,
                currentFloor * 0.965 + voiceEnergy * 0.035
              );
            }
            setAmbientNoiseFloor(Math.round(ambientNoiseFloorRef.current));
          }
        }

        // Hitung Batas Ambang Dinamis (Effective Adaptive Threshold):
        // Menyesuaikan otomatis di atas ambient noise floor, namun tidak pernah lebih rendah dari slider pilihan pengguna (mis. 24%)
        const adaptiveHeadroom =
          baseThreshold <= 28 ? 11 : baseThreshold <= 48 ? 14 : 17;
        const dynamicNoiseGate = Math.round(
          ambientNoiseFloorRef.current + adaptiveHeadroom
        );
        const effectiveThreshold = Math.min(
          85,
          Math.max(baseThreshold, dynamicNoiseGate)
        );
        setEffectiveVoxThreshold(effectiveThreshold);

        // 5. LOGIKA KONFIRMASI DURASI VOKAL (Hysteresis / Debounce 175ms - 200ms):
        // Mencegah suara singkat (<175ms) seperti batuk, benturan, atau suara orang lewat membuka jalur PTT
        const requiredConfirmMs = baseThreshold >= 40 ? 200 : 175;

        if (!isTransmittingRef.current) {
          if (
            voxEnabledRef.current &&
            !isPttLocked &&
            voiceEnergy >= effectiveThreshold &&
            isVocalPatternValid
          ) {
            if (voiceOnsetStartTimeRef.current === 0) {
              voiceOnsetStartTimeRef.current = now;
            }
            lastVocalDipTimeRef.current = 0;
            voxVoiceFramesRef.current += 1;

            const confirmedDurationMs = now - voiceOnsetStartTimeRef.current;
            if (confirmedDurationMs >= requiredConfirmMs) {
              voiceOnsetStartTimeRef.current = 0;
              voxVoiceFramesRef.current = 0;
              lastVoiceActiveTimeRef.current = now;
              onStartTransmit('VOX');
            }
          } else {
            // Toleransi micro-dip 1 frame (<=50ms) antar suku kata jika sudah lewat 90ms bicara;
            // jika hening/bukan vokal lebih dari 50ms, segera batalkan pemicu VOX!
            if (
              voiceOnsetStartTimeRef.current > 0 &&
              now - voiceOnsetStartTimeRef.current >= 90 &&
              voiceEnergy >= effectiveThreshold - 4 &&
              lastVocalDipTimeRef.current === 0
            ) {
              lastVocalDipTimeRef.current = now;
            } else {
              voiceOnsetStartTimeRef.current = 0;
              lastVocalDipTimeRef.current = 0;
              voxVoiceFramesRef.current = 0;
            }
          }
        } else {
          // Saat sedang Transmisi (TX Aktif) -> Gunakan ambang histeresis bawah (sustain threshold)
          // agar kalimat tidak terputus di tengah pengucapan, lalu tutup otomatis setelah hening selama voxHoldMs
          const sustainThreshold = Math.max(
            Math.round(ambientNoiseFloorRef.current + 6),
            Math.round(effectiveThreshold * 0.76)
          );
          if (voiceEnergy >= sustainThreshold) {
            lastVoiceActiveTimeRef.current = now;
          } else if (voxEnabledRef.current) {
            const silentMs = now - lastVoiceActiveTimeRef.current;
            if (silentMs >= voxHoldMsRef.current) {
              onStopTransmit();
            }
          }
        }
      }, 45);
    };

    startContinuousVoxMonitor();

    // Ensure AudioContext, reusable HTMLAudioElement & Keep-Alive Silent Stream unlock on any touch/click (iOS Safari & Android Chrome)
    const unlockAudioOnInteraction = () => {
      const ctx = getOrCreateCompatibleAudioContext(audioCtxRef.current);
      if (ctx) {
        audioCtxRef.current = ctx;
        unlockMobileAudioSession(ctx, reusableRxAudioRef.current);
        if (keepAliveEnabledRef.current && keepAliveSessionRef.current) {
          keepAliveSessionRef.current.start(ctx);
          setIsSilentKeepAliveRunning(true);
        }
      }
      if (voxEnabledRef.current && !mediaStreamRef.current) {
        ensureWebAudioVoxGraph();
      }
    };
    window.addEventListener('pointerdown', unlockAudioOnInteraction, { passive: true });
    window.addEventListener('touchstart', unlockAudioOnInteraction, { passive: true });
    window.addEventListener('keydown', unlockAudioOnInteraction, { passive: true });

    return () => {
      isCancelled = true;
      if (voxTimer) window.clearInterval(voxTimer);
      window.removeEventListener('pointerdown', unlockAudioOnInteraction);
      window.removeEventListener('touchstart', unlockAudioOnInteraction);
      window.removeEventListener('keydown', unlockAudioOnInteraction);
    };
  }, [
    isPasscodeAuthenticated,
    isSetupCompleted,
    myCallsign,
    myDeviceId,
    voxEnabled,
    isPttLocked,
    ensureWebAudioVoxGraph,
    onStartTransmit,
    onStopTransmit,
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

  // Refresh Ping handler
  const handleRefreshPing = () => {
    setIsRefreshingPing(true);
    broadcastMeshPacket({ type: 'PING' });
    window.setTimeout(() => {
      const nextPing = pingMs > 150 ? Math.floor(22 + Math.random() * 28) : 354;
      setPingDelta(Math.abs(nextPing - pingMs));
      setPingMs(nextPing);
      setIsRefreshingPing(false);
    }, 280);
  };

  // Constant 1-second ANNOUNCE broadcast once connected (mirrors Flutter Timer.periodic 1s)
  useEffect(() => {
    if (!isPasscodeAuthenticated || !isSetupCompleted || !myCallsign) return;
    broadcastMeshPacket({ type: 'ANNOUNCE' });
    const interval = window.setInterval(() => {
      broadcastMeshPacket({ type: 'ANNOUNCE' });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isPasscodeAuthenticated, isSetupCompleted, myCallsign, broadcastMeshPacket]);

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

    const realLanIp = await detectLocalHotspotIpWebRTC(550);
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
                const foundIp = await detectLocalHotspotIpWebRTC(450);
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
              await pc.setLocalDescription(answer);
              const gatheredCandidates = await gatherLocalIceCandidatesExplicit(pc, 750);

              const answerSdp = pc.localDescription?.sdp || answer.sdp || '';
              if (answerSdp) {
                const encodedAnswer = buildMicroOfflineToken({
                  type: 'A',
                  callsign: effectiveCallsign,
                  deviceId: myDeviceId,
                  ip: detectedLanIpRef.current || clientIp,
                  channel: offlineSig.ch,
                  slotId: offlineSig.sid,
                  sdp: answerSdp,
                  gatheredCandidates,
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
    <div className="h-[100dvh] max-h-[100dvh] w-full bg-[#021322] text-[#e5faff] flex flex-col items-center justify-center overflow-hidden select-none">
      <main
        className={`w-full h-[100dvh] max-h-[100dvh] tactical-grid-bg flex flex-col justify-between relative overflow-hidden transition-all ${
          fullScreenStretch
            ? 'max-w-full'
            : 'max-w-[460px] sm:border-x-2 sm:border-[#23dcff]/45 sm:shadow-[0_0_60px_rgba(0,195,255,0.25)]'
        }`}
      >
        {/* TOP TELEMETRY STATUS STRIP + AES-256-GCM E2EE BADGE */}
        <header className="px-2.5 py-1 flex items-center justify-between text-[9.5px] font-telemetry text-cyan-100/95 border-b border-cyan-400/15 bg-[#03192e]/70 backdrop-blur-xs shrink-0">
          <div className="flex items-center gap-1.5 truncate">
            <Lock className="w-3 h-3 text-[#23dcff] shrink-0" />
            <span className="tracking-tight font-bold text-[#23dcff] truncate">
              AES-256-GCM E2EE
            </span>
            <span className="text-cyan-400/50">•</span>
            <span className="text-cyan-100/90 truncate">
              TX:{e2eEncryptedTxCount} RX:{e2eDecryptedRxCount}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span>{pingMs} ms</span>
            <span className="text-cyan-400/50">|</span>
            <span className="text-cyan-200 font-bold">ONLINE</span>
            <button
              onClick={handleToggleFullScreen}
              title="Layar Penuh HP (Fullscreen)"
              className="px-1.5 py-0.5 rounded border border-cyan-400/60 text-[9px] font-bold text-cyan-100 bg-cyan-950/80 hover:bg-[#23dcff] hover:text-[#02182b] transition-colors flex items-center gap-1 cursor-pointer"
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

              {/* Label Status Permanen: MASTER (192.168.43.1) atau CLIENT */}
              <div className="px-2.5 py-1 rounded-lg cyan-btn-glow text-[#021d33] font-extrabold text-[11px] flex items-center gap-1 shrink-0">
                <Star className="w-3.5 h-3.5 fill-[#021d33]" />
                <span>{isMasterDevice ? 'MASTER' : 'CLIENT'}</span>
              </div>
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

              {/* Tombol Cepat BARCODE */}
              <button
                onClick={() => setActiveBottomModal('barcode')}
                className="h-11 px-3 rounded-xl bg-[#052542] hover:bg-[#093862] border border-[#23dcff]/65 flex flex-col items-center justify-center text-[10px] font-bold text-white transition-colors shrink-0 cursor-pointer"
              >
                <QrCode className="w-4.5 h-4.5 text-[#23dcff]" />
                <span>BARCODE</span>
              </button>
            </div>
          </section>

          {/* 4. GRID USER / ANGGOTA (REAL PEERS ONLY - MAXIMIZED) */}
          <section className="space-y-1.5 shrink-0">
            {/* Baris Atas: Tombol TALK ALL, ID SAYA: [CALLSIGN], Edit Nama & TOMBOL EMERGENCY CLEAR */}
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

              {/* TOMBOL KHUSUS EMERGENCY CLEAR (PEMBERSIHAN DARURAT) */}
              <button
                type="button"
                onClick={handleEmergencyClear}
                title="EMERGENCY CLEAR: Putuskan WebSocket, Matikan Mikrofon, Hapus Cache & Reset ke Login"
                className="px-2.5 py-1.5 rounded-full bg-gradient-to-r from-red-700 to-red-600 hover:from-red-600 hover:to-red-500 border border-red-300/80 shadow-[0_0_14px_rgba(239,68,68,0.55)] text-white font-tactical text-[11px] font-extrabold tracking-wider flex items-center gap-1 shrink-0 active:scale-95 transition-all cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-white shrink-0" />
                <span>EMERGENCY CLEAR</span>
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

                {/* Tombol Preset Cepat Anti-Bising: TENANG (24%), RAMAI (42%), ANGIN (65%) */}
                <div className="flex items-center gap-1 min-w-0">
                  {[
                    { label: 'TENANG', val: 24 },
                    { label: 'RAMAI', val: 42 },
                    { label: 'ANGIN', val: 65 },
                  ].map((preset) => {
                    const isActivePreset =
                      preset.val === 24
                        ? voxThreshold === 24 || Math.abs(voxThreshold - 24) <= 3
                        : Math.abs(voxThreshold - preset.val) <= 5;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => {
                          setVoxThreshold(preset.val);
                          handleRecalibrateVoxNoiseFloor();
                        }}
                        title={`Set Sensitivitas VOX ke Mode ${preset.label} (THR ${preset.val}%)`}
                        className={`px-1.5 py-0.5 rounded font-telemetry text-[8px] font-bold transition-colors cursor-pointer ${
                          isActivePreset
                            ? 'bg-[#23dcff] text-[#02182b] font-extrabold'
                            : 'bg-[#042138] hover:bg-[#083456] text-cyan-100 border border-cyan-400/35'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                {/* Tombol Sakelar Keep-Alive (Silent Audio Stream Mode Saku / Layar Mati) */}
                <button
                  type="button"
                  onClick={() => setKeepAliveEnabled((prev) => !prev)}
                  title="Keep-Alive Silent Audio Stream (Agar WebSocket & Audio Tetap Hidup Saat Layar HP Mati / Masuk Saku)"
                  className={`px-1.5 py-0.5 rounded border font-telemetry text-[8px] font-extrabold transition-colors shrink-0 cursor-pointer ${
                    keepAliveEnabled
                      ? 'bg-[#06385c] border-[#23dcff] text-[#23dcff]'
                      : 'bg-[#031829] border-cyan-500/30 text-cyan-300/60'
                  }`}
                >
                  {keepAliveEnabled
                    ? isBackgroundMode
                      ? 'SAKU:AKTIF'
                      : 'KEEP:ON'
                    : 'KEEP:OFF'}
                </button>

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

              {/* Baris 2: Pengatur Sensitivitas VOX (Threshold Slider) + Indikator Adaptive Noise Gate */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRecalibrateVoxNoiseFloor}
                  title="Ketuk untuk Kalibrasi Ulang Tingkat Kebisingan Latar (Adaptive Noise Floor)"
                  className="font-telemetry text-[9px] font-bold text-cyan-100 shrink-0 cursor-pointer hover:text-[#23dcff]"
                >
                  THR <strong className="text-[#23dcff]">{voxThreshold}%</strong>
                </button>

                <div className="relative flex-1 h-4 flex items-center">
                  {/* Track Background + Ambient Noise Floor Zone + Live Vocal Level Bar */}
                  <div className="w-full h-2 rounded-full bg-[#021220] border border-cyan-400/40 overflow-hidden relative">
                    {/* Zona Bising Latar Belakang (Ambient Noise Floor) */}
                    <div
                      style={{ width: `${Math.min(100, ambientNoiseFloor)}%` }}
                      className="position-absolute inset-y-0 left-0 h-full bg-cyan-900/50 pointer-events-none"
                    />
                    {/* Level Suara Vokal Saat Ini */}
                    <div
                      style={{ width: `${Math.min(100, voxInputLevel)}%` }}
                      className={`h-full transition-all duration-75 ${
                        voxInputLevel >= effectiveVoxThreshold && isVocalPatternConfirmed
                          ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
                          : 'bg-cyan-500/55'
                      }`}
                    />
                  </div>

                  {/* Garis Batas Ambang Manual (Threshold Gate Marker) */}
                  <div
                    style={{
                      left: `${((voxThreshold - 5) / (85 - 5)) * 100}%`,
                    }}
                    className="absolute top-0 bottom-0 w-1 -ml-0.5 rounded-full bg-white shadow-[0_0_6px_#23dcff] pointer-events-none"
                  />

                  {/* Garis Ambang Adaptif Otomatis (Adaptive Noise Gate Marker jika bising latar tinggi) */}
                  {effectiveVoxThreshold > voxThreshold && (
                    <div
                      style={{
                        left: `${((effectiveVoxThreshold - 5) / (85 - 5)) * 100}%`,
                      }}
                      title={`Ambang Adaptif Otomatis: ${effectiveVoxThreshold}% (Noise Floor: ${ambientNoiseFloor}%)`}
                      className="absolute top-0.5 bottom-0.5 w-1 -ml-0.5 rounded-full bg-amber-300 shadow-[0_0_6px_#fcd34d] pointer-events-none"
                    />
                  )}

                  {/* Input Range Slider Interaktif (Pengatur Sensitivitas VOX) */}
                  <input
                    type="range"
                    min={5}
                    max={85}
                    step={1}
                    value={voxThreshold}
                    onChange={(e) => setVoxThreshold(Number(e.target.value))}
                    aria-label="Pengatur Sensitivitas VOX Threshold Slider"
                    className="absolute inset-0 w-full h-full accent-[#23dcff] opacity-90 cursor-pointer"
                  />
                </div>

                <span className="font-telemetry text-[8.5px] text-cyan-100/95 shrink-0 min-w-[92px] text-right">
                  {isPttLocked
                    ? `LOCKED (${activeLockSpeaker})`
                    : voxEnabled
                    ? effectiveVoxThreshold > voxThreshold
                      ? `MIC:${voxInputLevel}%•ADAPT:${effectiveVoxThreshold}%`
                      : `MIC:${voxInputLevel}%•NF:${ambientNoiseFloor}%`
                    : 'MANUAL PTT'}
                </span>
              </div>
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
              {/* Indikator Gelombang Suara Kiri */}
              <div className="flex items-center gap-1">
                {[6, 8, 10, 12, 15, 18, 21, 24].map((h, i) => (
                  <span
                    key={`lw-${i}`}
                    style={{
                      height: isTransmitting
                        ? `${Math.max(6, ((h * Math.max(micLevel, voxInputLevel)) / 55) % 34)}px`
                        : voxEnabled && voxInputLevel > 5
                        ? `${Math.max(5, ((h * voxInputLevel) / 85) % 22)}px`
                        : `${h * 0.65}px`,
                    }}
                    className={`w-1.5 rounded-full transition-all duration-75 ${
                      isTransmitting || activeLockSpeaker
                        ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
                        : 'bg-[#23dcff]/55'
                    }`}
                  />
                ))}
              </div>

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

              {/* Indikator Gelombang Suara Kanan */}
              <div className="flex items-center gap-1">
                {[24, 21, 18, 15, 12, 10, 8, 6].map((h, i) => (
                  <span
                    key={`rw-${i}`}
                    style={{
                      height: isTransmitting
                        ? `${Math.max(6, ((h * Math.max(micLevel, voxInputLevel)) / 55) % 34)}px`
                        : voxEnabled && voxInputLevel > 5
                        ? `${Math.max(5, ((h * voxInputLevel) / 85) % 22)}px`
                        : `${h * 0.65}px`,
                    }}
                    className={`w-1.5 rounded-full transition-all duration-75 ${
                      isTransmitting || activeLockSpeaker
                        ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
                        : 'bg-[#23dcff]/55'
                    }`}
                  />
                ))}
              </div>
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
                              Sensitivitas VOX (Threshold Slider)
                            </span>
                            <span className="text-[#23dcff] font-bold">
                              THR {voxThreshold}% ({getVoxNoiseGateLabel(voxThreshold)}) • Adaptif: {effectiveVoxThreshold}%
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
                              { label: 'Tenang (24%)', val: 24 },
                              { label: 'Keramaian (42%)', val: 42 },
                              { label: 'Angin/Motor (65%)', val: 65 },
                            ].map((p) => (
                              <button
                                key={p.label}
                                type="button"
                                onClick={() => {
                                  setVoxThreshold(p.val);
                                  handleRecalibrateVoxNoiseFloor();
                                }}
                                className={`py-1 px-2 rounded-lg text-[10px] font-bold border cursor-pointer ${
                                  (p.val === 24
                                    ? voxThreshold === 24 || Math.abs(voxThreshold - 24) <= 3
                                    : Math.abs(voxThreshold - p.val) <= 5)
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
                              Noise Floor: <strong className="text-white">{ambientNoiseFloor}%</strong> • Filter Vokal: <strong className="text-[#23dcff]">300Hz–3,4kHz</strong>
                            </span>
                            <button
                              type="button"
                              onClick={handleRecalibrateVoxNoiseFloor}
                              className="px-2 py-0.5 rounded bg-[#063256] hover:bg-[#094778] border border-[#23dcff]/60 text-[#23dcff] font-bold cursor-pointer"
                            >
                              Kalibrasi Bising
                            </button>
                          </div>
                        </div>

                        <div className="flex items-center justify-between pt-2 border-t border-cyan-500/20 text-[11px]">
                          <span className="text-cyan-200">
                            Jeda Hening Tutup Transmisi (Hold Time)
                          </span>
                          <div className="flex items-center gap-1">
                            {[750, 1100, 1600].map((ms) => (
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
                      </div>

                      {/* Keep-Alive Latar Belakang (Silent Audio Stream via Web Audio API pada visibilitychange) */}
                      <div className="p-3 rounded-xl bg-[#021526] border border-[#23dcff]/45 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-white font-bold">
                              Keep-Alive Mode Saku / Layar Mati
                            </div>
                            <div className="text-[10px] text-cyan-200/75">
                              Silent Audio Stream (Web Audio API + visibilitychange) agar WebSocket &amp; suara masuk tidak dibekukan Android/iOS saat layar HP mati atau di dalam saku
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
                          <span className="text-cyan-200">Status Aliran Audio Kosong:</span>
                          <span className="font-bold text-[#23dcff]">
                            {keepAliveEnabled
                              ? isSilentKeepAliveRunning
                                ? isBackgroundMode
                                  ? 'AKTIF DI LATAR BELAKANG (MODE SAKU)'
                                  : 'SIAGA AKTIF (SILENT STREAM RUNNING)'
                                : 'SIAP AKTIF SAAT SENTUH LAYAR'
                              : 'NONAKTIF'}
                          </span>
                        </div>
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
