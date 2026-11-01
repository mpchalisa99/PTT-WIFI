import React, { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
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
} from 'lucide-react';
import { FLUTTER_SOURCE_FILES } from './data/flutterSourceFiles';
import { usePWAInstall } from './usePWAInstall';

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
}

interface MeshPacket {
  type: 'ANNOUNCE' | 'VOICE_CLIP' | 'PTT_START' | 'PTT_END' | 'PING' | 'PONG';
  senderId: string;
  callsign: string;
  ip: string;
  role: 'MASTER' | 'CLIENT';
  channel: number;
  timestamp: number;
  audioBase64?: string;
  mimeType?: string;
  peerNodeId?: string;
}

const MESH_SLOTS = 6;

// Universal parser for both ?query and #hash invite parameters (prevents 404 Page Not Found)
function extractInviteParamsFromUrl() {
  const searchStr = window.location.search.replace(/^\?/, '');
  const hashStr = window.location.hash.replace(/^#\/?/, '').replace(/^\?/, '');
  const combined = [searchStr, hashStr].filter(Boolean).join('&');
  const params = new URLSearchParams(combined);

  const isInvite =
    params.get('invite') === '1' ||
    params.get('role') === 'CLIENT' ||
    Boolean(params.get('hostPeer'));
  const ch = Number(params.get('ch'));
  const hostPeer = params.get('hostPeer') || '';
  const hostCallsign = (params.get('hostCallsign') || params.get('host') || 'MASTER').toUpperCase();
  const masterIp = params.get('master') || params.get('ip') || '192.168.43.1';

  return {
    isInvite,
    channel: ch >= 1 && ch <= 99 ? ch : null,
    hostPeer,
    hostCallsign,
    masterIp,
    role: params.get('role'),
  };
}

export default function App() {
  const { isInstallable, isInstalled, install } = usePWAInstall();

  // Read URL invite parameters once on boot (supports both #hash and ?query)
  const [urlInviteParams, setUrlInviteParams] = useState(() => extractInviteParamsFromUrl());

  // Persistent identity & URL query auto-join support for Barcode scanning
  const [myDeviceId] = useState<string>(() => {
    const initial = extractInviteParamsFromUrl();
    if (initial.isInvite) {
      const sessionSaved = sessionStorage.getItem('diskomlekau_invite_device_id');
      if (sessionSaved) return sessionSaved;
      const generatedInvite = `CLI-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
      sessionStorage.setItem('diskomlekau_invite_device_id', generatedInvite);
      return generatedInvite;
    }
    const saved = localStorage.getItem('diskomlekau_device_id');
    if (saved) return saved;
    const generated = `DEV-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    localStorage.setItem('diskomlekau_device_id', generated);
    return generated;
  });

  const myPeerNodeId = `diskomlekau-node-${myDeviceId.toLowerCase()}`;

  const [role, setRole] = useState<'MASTER' | 'CLIENT'>(() => {
    if (urlInviteParams.isInvite) return 'CLIENT';
    if (urlInviteParams.role === 'CLIENT' || urlInviteParams.role === 'MASTER') {
      return urlInviteParams.role;
    }
    return (localStorage.getItem('diskomlekau_role') as 'MASTER' | 'CLIENT') || 'MASTER';
  });

  const [localIp, setLocalIp] = useState<string>(() => {
    if (urlInviteParams.isInvite) {
      const sessionIp = sessionStorage.getItem('diskomlekau_invite_ip');
      if (sessionIp) return sessionIp;
      const generatedIp = `192.168.43.${Math.floor(102 + Math.random() * 90)}`;
      sessionStorage.setItem('diskomlekau_invite_ip', generatedIp);
      return generatedIp;
    }
    return localStorage.getItem('diskomlekau_ip') || '192.168.43.1';
  });

  const [channel, setChannel] = useState<number>(() => {
    if (urlInviteParams.channel) return urlInviteParams.channel;
    return Number(localStorage.getItem('diskomlekau_channel')) || 12;
  });

  const [myCallsign, setMyCallsign] = useState<string>(() => {
    if (urlInviteParams.isInvite) {
      return sessionStorage.getItem('diskomlekau_invite_callsign') || '';
    }
    return localStorage.getItem('diskomlekau_callsign') || '';
  });

  const [isSetupCompleted, setIsSetupCompleted] = useState<boolean>(() => {
    if (urlInviteParams.isInvite) {
      return Boolean(sessionStorage.getItem('diskomlekau_invite_callsign'));
    }
    return Boolean(localStorage.getItem('diskomlekau_callsign'));
  });

  const [setupCallsignInput, setSetupCallsignInput] = useState<string>(() => {
    if (urlInviteParams.isInvite) {
      return sessionStorage.getItem('diskomlekau_invite_callsign') || '';
    }
    return localStorage.getItem('diskomlekau_callsign') || '';
  });

  const [setupIpMode, setSetupIpMode] = useState<'192.168.43.1' | 'CLIENT'>(() => {
    if (urlInviteParams.isInvite) return 'CLIENT';
    const savedIp = localStorage.getItem('diskomlekau_ip') || '192.168.43.1';
    return savedIp === '192.168.43.1' ? '192.168.43.1' : 'CLIENT';
  });

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

  // Real Microphone & PTT Audio states
  const [isTransmitting, setIsTransmitting] = useState<boolean>(false);
  const [incomingSpeaker, setIncomingSpeaker] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState<number>(0);
  const [micPermissionState, setMicPermissionState] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [echoTestMode, setEchoTestMode] = useState<boolean>(true);
  const [connectedPeersCount, setConnectedPeersCount] = useState<number>(0);

  // Bottom Navigation Modal States
  const [activeBottomModal, setActiveBottomModal] = useState<
    null | 'channels' | 'editName' | 'barcode' | 'settings'
  >(null);
  const [settingsTab, setSettingsTab] = useState<'audio' | 'apkGuide' | 'flutterCode'>('audio');
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [selectedFileIndex, setSelectedFileIndex] = useState<number>(0);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Audio & WebRTC refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const animFrameRef = useRef<number | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const peerRef = useRef<Peer | null>(null);
  const directNodePeerRef = useRef<Peer | null>(null);
  const peerConnectionsRef = useRef<Map<string, DataConnection>>(new Map());
  const lastAnnounceReplyRef = useRef<Map<string, number>>(new Map());

  // Persist user settings
  useEffect(() => {
    if (!myCallsign) return;
    if (urlInviteParams.isInvite) {
      sessionStorage.setItem('diskomlekau_invite_callsign', myCallsign);
      sessionStorage.setItem('diskomlekau_invite_ip', localIp);
    } else {
      localStorage.setItem('diskomlekau_callsign', myCallsign);
      localStorage.setItem('diskomlekau_channel', String(channel));
      localStorage.setItem('diskomlekau_role', role);
      localStorage.setItem('diskomlekau_ip', localIp);
    }
  }, [myCallsign, channel, role, localIp, urlInviteParams.isInvite]);

  // If joined via Barcode Invite Link, immediately seed the invited Master host into active peers
  useEffect(() => {
    if (!isSetupCompleted || !invitedHostPeer || !invitedHostCallsign) return;
    setMembers((prev) => {
      const exists = prev.some(
        (m) => m.peerId === invitedHostPeer || m.callsign === invitedHostCallsign
      );
      if (exists) return prev;
      return [
        ...prev,
        {
          id: invitedHostPeer,
          callsign: invitedHostCallsign,
          ip: urlInviteParams.masterIp || '192.168.43.1',
          role: 'MASTER',
          statusText: 'MASTER HOST',
          isTargeted: true,
          isTalking: false,
          pingMs: 18,
          channel,
          peerId: invitedHostPeer,
        },
      ];
    });
  }, [isSetupCompleted, invitedHostPeer, invitedHostCallsign, channel, urlInviteParams.masterIp]);

  // Request Screen Wake Lock so HP screen stays on in APK/fullscreen mode
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator) {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      } catch {
        // Ignore if not supported in current browser frame
      }
    };
    requestWakeLock();
    return () => {
      wakeLock?.release().catch(() => {});
    };
  }, []);

  // Tactical Walkie-Talkie Roger Beep & Squelch Synthesizer
  const playTacticalTone = useCallback(
    (type: 'start' | 'end' | 'rx') => {
      if (!soundEnabled) return;
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        }
        const ctx = audioCtxRef.current;
        if (ctx.state === 'suspended') {
          ctx.resume();
        }
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

  // Play incoming Base64 voice clip received from another device or loopback test
  const playIncomingAudioBase64 = useCallback(
    (base64Data: string, senderCallsign: string) => {
      if (!soundEnabled) return;
      playTacticalTone('rx');
      setIncomingSpeaker(senderCallsign);

      const audio = new Audio(base64Data);
      audio.onended = () => {
        setIncomingSpeaker((curr) => (curr === senderCallsign ? null : curr));
        playTacticalTone('end');
      };
      audio.onerror = () => {
        setIncomingSpeaker(null);
      };
      audio.play().catch(() => {
        setIncomingSpeaker(null);
      });
    },
    [soundEnabled, playTacticalTone]
  );

  // Send packet to all connected WebRTC peers + local BroadcastChannel
  const broadcastMeshPacket = useCallback(
    (partial: Omit<MeshPacket, 'senderId' | 'callsign' | 'ip' | 'role' | 'channel' | 'timestamp'>) => {
      if (!myCallsign) return;
      const fullPacket: MeshPacket = {
        ...partial,
        senderId: myDeviceId,
        callsign: myCallsign,
        ip: localIp,
        role,
        channel,
        timestamp: Date.now(),
        peerNodeId: myPeerNodeId,
      };

      try {
        broadcastChannelRef.current?.postMessage(fullPacket);
      } catch {
        // Ignore BroadcastChannel error
      }

      peerConnectionsRef.current.forEach((conn) => {
        if (conn && conn.open) {
          try {
            conn.send(fullPacket);
          } catch {
            // Ignore closed peer connection
          }
        }
      });
    },
    [myDeviceId, myCallsign, localIp, role, channel, myPeerNodeId]
  );

  // Handle incoming mesh packets (from WebRTC PeerJS or BroadcastChannel)
  const handleIncomingMeshPacket = useCallback(
    (pkt: MeshPacket) => {
      if (!pkt || pkt.senderId === myDeviceId || !pkt.callsign) return;
      // Filter by currentChannel without closing sockets
      if (pkt.channel !== channel) return;

      if (pkt.type === 'ANNOUNCE') {
        setMembers((prev) => {
          const exists = prev.some(
            (m) => m.id === pkt.senderId || m.callsign === pkt.callsign
          );
          if (exists) {
            return prev.map((m) =>
              m.id === pkt.senderId || m.callsign === pkt.callsign
                ? {
                    ...m,
                    id: pkt.senderId,
                    callsign: pkt.callsign,
                    ip: pkt.ip,
                    role: pkt.role,
                    channel: pkt.channel,
                    peerId: pkt.peerNodeId || m.peerId,
                  }
                : m
            );
          }
          return [
            ...prev,
            {
              id: pkt.senderId,
              callsign: pkt.callsign,
              ip: pkt.ip,
              role: pkt.role,
              statusText: 'ALL AKTIF',
              isTargeted: true,
              isTalking: false,
              pingMs: 24,
              channel: pkt.channel,
              peerId: pkt.peerNodeId,
            },
          ];
        });

        // Instant reply so newly joined Barcode Clients immediately see this device
        const now = Date.now();
        const lastReply = lastAnnounceReplyRef.current.get(pkt.senderId) || 0;
        if (now - lastReply > 1500 && myCallsign) {
          lastAnnounceReplyRef.current.set(pkt.senderId, now);
          broadcastMeshPacket({ type: 'ANNOUNCE' });
        }
      } else if (pkt.type === 'PTT_START') {
        setIncomingSpeaker(pkt.callsign);
        playTacticalTone('rx');
      } else if (pkt.type === 'PTT_END') {
        setIncomingSpeaker((curr) => (curr === pkt.callsign ? null : curr));
      } else if (pkt.type === 'VOICE_CLIP' && pkt.audioBase64) {
        playIncomingAudioBase64(pkt.audioBase64, pkt.callsign);
      } else if (pkt.type === 'PING') {
        broadcastMeshPacket({ type: 'PONG' });
      } else if (pkt.type === 'PONG') {
        const rtt = Math.max(8, Date.now() - pkt.timestamp);
        setPingDelta(Math.abs(rtt - pingMs));
        setPingMs(rtt);
      }
    },
    [myDeviceId, channel, pingMs, myCallsign, playIncomingAudioBase64, playTacticalTone, broadcastMeshPacket]
  );

  // Keep latest packet handler in a ref so WebRTC sockets never get destroyed on state updates
  const packetHandlerRef = useRef(handleIncomingMeshPacket);
  useEffect(() => {
    packetHandlerRef.current = handleIncomingMeshPacket;
  }, [handleIncomingMeshPacket]);

  const announcePacketBuilderRef = useRef<() => MeshPacket | null>(() => null);
  useEffect(() => {
    announcePacketBuilderRef.current = () => {
      if (!myCallsign) return null;
      return {
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
  }, [myDeviceId, myCallsign, localIp, role, channel, myPeerNodeId]);

  // Helper to attach listeners to a PeerJS DataConnection
  const registerPeerConnection = useCallback((conn: DataConnection) => {
    conn.on('open', () => {
      peerConnectionsRef.current.set(conn.peer, conn);
      setConnectedPeersCount(peerConnectionsRef.current.size);
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
      packetHandlerRef.current(incoming);

      // If this device is Master/Hub, relay packets to other connected clients on same channel
      peerConnectionsRef.current.forEach((otherConn, peerKey) => {
        if (peerKey !== conn.peer && otherConn.open) {
          try {
            otherConn.send(incoming);
          } catch {
            // Ignore relay error
          }
        }
      });
    });
    conn.on('close', () => {
      peerConnectionsRef.current.delete(conn.peer);
      setConnectedPeersCount(peerConnectionsRef.current.size);
    });
    conn.on('error', () => {
      peerConnectionsRef.current.delete(conn.peer);
      setConnectedPeersCount(peerConnectionsRef.current.size);
    });
  }, []);

  // Setup persistent BroadcastChannel + Direct Node PeerJS + Mesh Slots (never closes on channel switch)
  useEffect(() => {
    // 1. Local BroadcastChannel for same-device / multi-tab instant voice & discovery sync
    if ('BroadcastChannel' in window) {
      const bc = new BroadcastChannel('diskomlekau_tactical_ptt_channel');
      bc.onmessage = (event) => {
        packetHandlerRef.current(event.data as MeshPacket);
      };
      broadcastChannelRef.current = bc;
    }

    // 2. Direct Node PeerJS (used by Barcode Invite Link `hostPeer=...` so Clients connect 100% directly)
    const directPeer = new Peer(myPeerNodeId);
    directNodePeerRef.current = directPeer;

    directPeer.on('connection', (conn) => {
      registerPeerConnection(conn);
    });

    // 3. Channel Slot Mesh PeerJS for automatic same-channel discovery
    let slotPeer: Peer | null = null;
    let isCancelled = false;

    const getSlotPeerId = (slot: number) =>
      `diskomlekau-tactical-v2-global-slot${slot}`;

    const tryBindSlot = (slotIndex: number) => {
      if (isCancelled || slotIndex >= MESH_SLOTS) return;
      const candidateId = getSlotPeerId(slotIndex);
      const p = new Peer(candidateId);

      p.on('open', () => {
        if (isCancelled) {
          p.destroy();
          return;
        }
        slotPeer = p;
        peerRef.current = p;
        for (let s = 0; s < MESH_SLOTS; s++) {
          if (s === slotIndex) continue;
          const targetId = getSlotPeerId(s);
          if (!peerConnectionsRef.current.has(targetId)) {
            try {
              const conn = p.connect(targetId, { reliable: true });
              registerPeerConnection(conn);
            } catch {
              // Slot not occupied
            }
          }
        }
      });

      p.on('connection', (conn) => {
        registerPeerConnection(conn);
      });

      p.on('error', (err: { type?: string }) => {
        if (err.type === 'unavailable-id') {
          p.destroy();
          tryBindSlot(slotIndex + 1);
        }
      });
    };

    tryBindSlot(0);

    return () => {
      isCancelled = true;
      broadcastChannelRef.current?.close();
      peerConnectionsRef.current.clear();
      directPeer.destroy();
      slotPeer?.destroy();
    };
  }, [myPeerNodeId, registerPeerConnection]);

  // Connect & auto-reconnect to invitedHostPeer (from Barcode Invite Link or manual paste)
  useEffect(() => {
    if (!invitedHostPeer || invitedHostPeer === myPeerNodeId) return;

    const connectToInvitedHost = () => {
      const activePeer = directNodePeerRef.current || peerRef.current;
      if (!activePeer || activePeer.disconnected || activePeer.destroyed) return;
      const existing = peerConnectionsRef.current.get(invitedHostPeer);
      if (existing && existing.open) return;

      try {
        const conn = activePeer.connect(invitedHostPeer, { reliable: true });
        registerPeerConnection(conn);
      } catch {
        // Retry on next tick
      }
    };

    connectToInvitedHost();
    const timer = window.setInterval(connectToInvitedHost, 2000);
    return () => window.clearInterval(timer);
  }, [invitedHostPeer, myPeerNodeId, registerPeerConnection]);

  // Start Push-To-Talk (`onLongPress` / Hold) -> Captures real microphone audio
  const handlePttStart = async () => {
    if (isTransmitting) return;
    setIncomingSpeaker(null);
    setIsTransmitting(true);
    playTacticalTone('start');
    broadcastMeshPacket({ type: 'PTT_START' });

    try {
      if (!mediaStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        mediaStreamRef.current = stream;
        setMicPermissionState('granted');
      }

      const stream = mediaStreamRef.current;
      if (stream) {
        // Real-time audio level meter for the left/right cyan wave bars
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        }
        const ctx = audioCtxRef.current;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const updateMeter = () => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setMicLevel(Math.min(100, Math.max(25, avg * 1.4)));
          animFrameRef.current = requestAnimationFrame(updateMeter);
        };
        updateMeter();

        // Record voice packet for cross-device WebRTC / BroadcastChannel & APK Echo Test
        recordedChunksRef.current = [];
        const recorder = new MediaRecorder(stream);
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          });
          if (blob.size > 200) {
            const reader = new FileReader();
            reader.onloadend = () => {
              const base64Audio = reader.result as string;
              if (base64Audio) {
                broadcastMeshPacket({
                  type: 'VOICE_CLIP',
                  audioBase64: base64Audio,
                  mimeType: blob.type,
                });

                // If Echo Test Mode is enabled (and no remote peer is active), play back captured voice
                if (echoTestMode && peerConnectionsRef.current.size === 0) {
                  window.setTimeout(() => {
                    playIncomingAudioBase64(base64Audio, `${myCallsign} (ECHO)`);
                  }, 350);
                }
              }
            };
            reader.readAsDataURL(blob);
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
      }
    } catch {
      // Fallback animated waveform if mic permission isn't granted yet
      setMicPermissionState('denied');
      const fallbackTick = () => {
        setMicLevel(Math.floor(40 + Math.random() * 55));
        animFrameRef.current = requestAnimationFrame(fallbackTick);
      };
      fallbackTick();
    }
  };

  // Stop Push-To-Talk (`onLongPressEnd` / Release)
  const handlePttEnd = () => {
    if (!isTransmitting) return;
    setIsTransmitting(false);
    setMicLevel(0);

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

    playTacticalTone('end');
    broadcastMeshPacket({ type: 'PTT_END' });
  };

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
    if (!isSetupCompleted || !myCallsign) return;
    broadcastMeshPacket({ type: 'ANNOUNCE' });
    const interval = window.setInterval(() => {
      broadcastMeshPacket({ type: 'ANNOUNCE' });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isSetupCompleted, myCallsign, broadcastMeshPacket]);

  // Permanent role lock based on IP '192.168.43.1'
  const isMasterDevice = localIp === '192.168.43.1';
  const permanentRoleLabel = isMasterDevice ? 'HP MASTER' : 'CLIENT';

  const handleSetupConnect = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = setupCallsignInput.trim().toUpperCase();
    if (!cleaned) return;
    const assignedIp =
      setupIpMode === '192.168.43.1'
        ? '192.168.43.1'
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

  // Use exact active URL with #hash fragment so no web server or WebView ever returns "404 Page not found"
  const cleanCurrentBaseUrl = `${window.location.origin}${window.location.pathname}`.replace(
    /\/+$/,
    ''
  );
  const sharePairUrl = `${cleanCurrentBaseUrl}/#invite=1&ch=${channel}&role=CLIENT&master=192.168.43.1&hostPeer=${encodeURIComponent(
    myPeerNodeId
  )}&hostCallsign=${encodeURIComponent(myCallsign || 'MASTER')}`;

  // Generate real scannable QR Code image whenever sharePairUrl changes
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(sharePairUrl, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#03192e',
        light: '#ffffff',
      },
    })
      .then((dataUrl) => {
        if (active) setQrCodeDataUrl(dataUrl);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [sharePairUrl]);

  const handleShareInviteLink = async () => {
    const shareTitle = `DISKOMLEKAU TACTICAL PTT - CH ${String(channel).padStart(2, '0')}`;
    const shareText = `Gabung ke Jaringan Walkie-Talkie DISKOMLEKAU TACTICAL PTT (${
      myCallsign || 'MASTER'
    } - CHANNEL ${String(channel).padStart(2, '0')}):`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: sharePairUrl,
        });
        return;
      } catch {
        // Fallback to copy
      }
    }
    handleCopyText('pairUrl', sharePairUrl);
  };

  // Universal processor for any scanned QR code string, pasted URL, or Master Node ID
  const applyScannedOrPastedInvite = useCallback(
    (rawString: string): boolean => {
      const raw = rawString.trim();
      if (!raw) return false;

      try {
        let parsedCh = channel;
        let parsedHostPeer = '';
        let parsedHostCallsign = 'MASTER';
        let parsedMasterIp = '192.168.43.1';

        if (
          raw.includes('invite=') ||
          raw.includes('hostPeer=') ||
          raw.includes('ch=') ||
          raw.includes('?') ||
          raw.includes('#')
        ) {
          // Extract query/hash part after # or ?
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
            'MASTER'
          ).toUpperCase();
          parsedMasterIp = params.get('master') || params.get('ip') || '192.168.43.1';
        } else {
          parsedHostPeer = raw.startsWith('diskomlekau-node-')
            ? raw.toLowerCase()
            : `diskomlekau-node-${raw.toLowerCase()}`;
        }

        setSetupIpMode('CLIENT');
        if (localIp === '192.168.43.1') {
          const newClientIp = `192.168.43.${Math.floor(102 + Math.random() * 90)}`;
          setLocalIp(newClientIp);
          setRole('CLIENT');
        }

        setChannel(parsedCh);
        if (parsedHostPeer) {
          setInvitedHostPeer(parsedHostPeer);
          setInvitedHostCallsign(parsedHostCallsign);
        }
        setUrlInviteParams({
          isInvite: true,
          channel: parsedCh,
          hostPeer: parsedHostPeer,
          hostCallsign: parsedHostCallsign,
          masterIp: parsedMasterIp,
          role: 'CLIENT',
        });

        setMembers((prev) => {
          const exists = prev.some(
            (m) =>
              (parsedHostPeer && m.peerId === parsedHostPeer) ||
              m.callsign === parsedHostCallsign
          );
          if (exists) {
            return prev.map((m) =>
              (parsedHostPeer && m.peerId === parsedHostPeer) ||
              m.callsign === parsedHostCallsign
                ? { ...m, channel: parsedCh, ip: parsedMasterIp, role: 'MASTER' }
                : m
            );
          }
          return [
            ...prev,
            {
              id: parsedHostPeer || `master-${Date.now()}`,
              callsign: parsedHostCallsign,
              ip: parsedMasterIp,
              role: 'MASTER',
              statusText: 'MASTER HOST',
              isTargeted: true,
              isTalking: false,
              pingMs: 18,
              channel: parsedCh,
              peerId: parsedHostPeer,
            },
          ];
        });

        playTacticalTone('rx');
        setInviteJoinStatus(
          `BERHASIL TERHUBUNG KE MASTER ${parsedHostCallsign} (CH ${String(parsedCh).padStart(
            2,
            '0'
          )})`
        );
        return true;
      } catch {
        setInviteJoinStatus('FORMAT BARCODE / LINK TIDAK VALID');
        return false;
      }
    },
    [channel, localIp, playTacticalTone]
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
              const ok = applyScannedOrPastedInvite(code.data);
              if (ok) {
                setIsSetupScannerOpen(false);
                window.setTimeout(() => {
                  setInviteJoinStatus(null);
                  setActiveBottomModal(null);
                }, 1100);
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
          const ok = applyScannedOrPastedInvite(code.data);
          if (ok) {
            setIsSetupScannerOpen(false);
            window.setTimeout(() => {
              setInviteJoinStatus(null);
              setActiveBottomModal(null);
            }, 1100);
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
    const ok = applyScannedOrPastedInvite(manualInviteInput);
    if (ok) {
      setManualInviteInput('');
      window.setTimeout(() => {
        setInviteJoinStatus(null);
        setActiveBottomModal(null);
      }, 1100);
    }
  };

  const currentFile = FLUTTER_SOURCE_FILES[selectedFileIndex];

  const curvedTitle = 'PUSH TO TALK & HOLD';
  const curvedChars = curvedTitle.split('');

  // 1. LAYAR SETUP AWAL (SetupScreen - KONEK NAMA + SCAN BARCODE LANGSUNG)
  if (!isSetupCompleted) {
    return (
      <div className="min-h-[100dvh] w-full tactical-grid-bg text-[#e5faff] flex items-center justify-center p-5 select-none">
        <div className="w-full max-w-[420px] tactical-panel rounded-3xl p-6 space-y-4 shadow-[0_0_50px_rgba(35,220,255,0.22)]">
          <div className="flex flex-col items-center text-center space-y-2">
            <div className="w-16 h-16 rounded-full bg-[#03192e] border-2 border-[#23dcff] shadow-[0_0_20px_rgba(35,220,255,0.35)] flex items-center justify-center">
              <Radio className="w-8 h-8 text-[#23dcff]" />
            </div>
            <h1 className="font-tactical text-[26px] font-extrabold tracking-wider text-white cyan-glow-text">
              DISKOMLEKAU TACTICAL PTT
            </h1>
            <p className="font-telemetry text-[11px] text-cyan-200/90 tracking-wide">
              REGISTRASI IDENTITAS JARINGAN HOTSPOT LAN
            </p>
            {urlInviteParams.isInvite && (
              <div className="w-full mt-1 px-3 py-2 rounded-xl bg-[#07375c] border border-[#23dcff] text-xs font-telemetry text-white font-bold">
                TERHUBUNG BARCODE MASTER: {invitedHostCallsign} • CHANNEL{' '}
                {String(channel).padStart(2, '0')}
              </div>
            )}
          </div>

          {/* Tombol Buka In-App Scanner di SetupScreen agar tidak pernah "Page Not Found" */}
          <div>
            <button
              type="button"
              onClick={() => setIsSetupScannerOpen((prev) => !prev)}
              className="w-full py-2.5 px-3 rounded-xl bg-[#052946] hover:bg-[#093b63] border border-[#23dcff] text-white font-telemetry text-xs font-bold flex items-center justify-center gap-2 cursor-pointer"
            >
              <Camera className="w-4 h-4 text-[#23dcff]" />
              <span>
                {isSetupScannerOpen
                  ? 'TUTUP KAMERA SCANNER BARCODE'
                  : 'SCAN BARCODE DARI HP MASTER (TANPA BROWSER)'}
              </span>
            </button>

            {isSetupScannerOpen && (
              <div className="mt-2.5 p-3 rounded-2xl bg-[#021526] border border-[#23dcff] space-y-2.5 text-center">
                <div className="relative w-full aspect-square max-w-[230px] mx-auto rounded-xl overflow-hidden bg-black border-2 border-[#23dcff]">
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
                  <p className="font-telemetry text-[10.5px] text-amber-300">{scannerError}</p>
                )}
                <label className="w-full py-2 px-3 rounded-xl bg-[#07375c] hover:bg-[#0b4b7a] border border-cyan-400/60 text-white font-telemetry text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer">
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

          <form onSubmit={handleSetupConnect} className="space-y-4">
            <div>
              <label className="block font-telemetry text-xs font-bold text-cyan-100 mb-1.5">
                MASUKKAN NAMA / CALLSIGN ANDA:
              </label>
              <input
                type="text"
                required
                maxLength={12}
                value={setupCallsignInput}
                onChange={(e) => setSetupCallsignInput(e.target.value)}
                placeholder="CONTOH: YUDHI / GARUDA-1"
                autoFocus
                className="w-full px-4 py-3 rounded-xl bg-[#021526] border-2 border-[#23dcff]/70 focus:border-[#23dcff] text-white font-telemetry text-base font-extrabold uppercase tracking-wider focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-telemetry text-[11px] font-bold text-cyan-200/90 mb-1.5">
                DETEKSI IP PERANGKAT (KUNCI PERAN PERMANEN):
              </label>
              <div className="grid grid-cols-2 gap-2 font-telemetry text-xs">
                <button
                  type="button"
                  onClick={() => setSetupIpMode('192.168.43.1')}
                  className={`py-2.5 px-3 rounded-xl border font-bold text-left transition-all cursor-pointer ${
                    setupIpMode === '192.168.43.1'
                      ? 'bg-[#093b61] border-[#23dcff] text-white shadow-[0_0_12px_rgba(35,220,255,0.3)]'
                      : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                  }`}
                >
                  <div className="text-[#23dcff] font-extrabold">HP MASTER</div>
                  <div className="text-[10px]">192.168.43.1 (Host)</div>
                </button>
                <button
                  type="button"
                  onClick={() => setSetupIpMode('CLIENT')}
                  className={`py-2.5 px-3 rounded-xl border font-bold text-left transition-all cursor-pointer ${
                    setupIpMode === 'CLIENT'
                      ? 'bg-[#093b61] border-[#23dcff] text-white shadow-[0_0_12px_rgba(35,220,255,0.3)]'
                      : 'bg-[#021526] border-cyan-500/30 text-cyan-200/70'
                  }`}
                >
                  <div className="text-[#23dcff] font-extrabold">CLIENT</div>
                  <div className="text-[10px]">192.168.43.x (Anggota)</div>
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="w-full py-3.5 rounded-xl cyan-btn-glow text-[#02182b] font-tactical text-lg font-extrabold tracking-wider flex items-center justify-center gap-2 cursor-pointer"
            >
              <Wifi className="w-5 h-5" />
              <span>KONEK JARINGAN</span>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-[#021322] text-[#e5faff] flex flex-col items-center justify-center overflow-x-hidden select-none">
      <main
        className={`w-full min-h-[100dvh] tactical-grid-bg flex flex-col justify-between relative overflow-hidden transition-all ${
          fullScreenStretch
            ? 'max-w-full'
            : 'max-w-[460px] sm:border-x-2 sm:border-[#23dcff]/45 sm:shadow-[0_0_60px_rgba(0,195,255,0.25)]'
        }`}
      >
        {/* TOP TELEMETRY STATUS STRIP */}
        <header className="px-3.5 pt-2.5 pb-1.5 flex items-center justify-between text-[11px] font-telemetry text-cyan-100/95 border-b border-cyan-400/15 bg-[#03192e]/60 backdrop-blur-xs">
          <div className="flex items-center gap-1.5 truncate">
            <Wifi className="w-3.5 h-3.5 text-[#23dcff] shrink-0" />
            <span className="tracking-tight truncate">
              VERCEL CLOUD MESH • UDP LAN HOTSPOT
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span>{pingMs} ms</span>
            <span className="text-cyan-400/50">|</span>
            <span className="text-cyan-200 font-bold">ONLINE</span>
            <button
              onClick={handleToggleFullScreen}
              title="Layar Penuh HP (Fullscreen)"
              className="px-2 py-0.5 rounded border border-cyan-400/60 text-[10px] font-bold text-cyan-100 bg-cyan-950/80 hover:bg-[#23dcff] hover:text-[#02182b] transition-colors flex items-center gap-1 cursor-pointer"
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

        {/* MAIN VERTICAL TACTICAL STACK */}
        <div className="flex-1 w-full max-w-[540px] mx-auto px-3.5 py-2 flex flex-col justify-evenly gap-2.5">
          {/* 1. HEADER TEKS: DISKOMLEKAU TACTICAL PTT */}
          <div className="text-center py-0.5">
            <h1 className="font-tactical text-[28px] sm:text-[32px] leading-none font-extrabold tracking-[0.06em] text-[#e9fcff] cyan-glow-text">
              DISKOMLEKAU TACTICAL PTT
            </h1>
          </div>

          {/* 2. CARD STATUS JARINGAN (TOP PANEL) */}
          <section className="tactical-panel rounded-2xl p-3.5 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              {/* Indikator Sinyal 4 Bar */}
              <div className="px-2.5 py-2 rounded-lg bg-[#03192e] border border-cyan-400/40 flex items-end gap-1 shrink-0">
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
              <div className="font-telemetry leading-tight shrink-0">
                <div className="text-[12px] font-bold text-white">PING:</div>
                <div className="text-[15px] font-extrabold text-white">
                  {pingMs} ms
                </div>
              </div>

              <div className="font-telemetry text-[12px] text-cyan-200/90 shrink-0">
                (+{pingDelta}ms)
              </div>

              {/* Status LATENCY TINGGI / RENDAH */}
              <div className="px-2.5 py-1 rounded-md border border-cyan-400/45 bg-[#031b32]/80 font-telemetry text-[11px] font-bold leading-tight text-white">
                <div>LATENCY</div>
                <div className={isHighLatency ? 'text-cyan-200' : 'text-emerald-300'}>
                  {isHighLatency ? 'TINGGI' : 'RENDAH'}
                </div>
              </div>

              {/* Tombol Refresh Ping */}
              <button
                onClick={handleRefreshPing}
                className="min-h-[38px] px-2.5 py-1.5 rounded-lg bg-[#05233e] hover:bg-[#09355c] border border-cyan-400/55 flex items-center gap-1 text-xs font-bold text-white transition-colors shrink-0 cursor-pointer"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 text-[#23dcff] ${
                    isRefreshingPing ? 'animate-spin' : ''
                  }`}
                />
                <span>Ping</span>
              </button>

              {/* Label Status Permanen: MASTER (192.168.43.1) atau CLIENT */}
              <div className="min-h-[38px] px-2.5 py-1.5 rounded-lg cyan-btn-glow text-[#021d33] font-extrabold text-xs flex items-center gap-1 shrink-0">
                <Star className="w-3.5 h-3.5 fill-[#021d33]" />
                <span>{isMasterDevice ? 'MASTER' : 'CLIENT'}</span>
              </div>
            </div>

            <div className="h-[1px] bg-gradient-to-r from-cyan-400/40 via-cyan-300/60 to-cyan-400/20" />

            {/* Teks Informasi Peran Permanen & Peer Aktif */}
            <div className="grid grid-cols-12 gap-2 font-telemetry text-[12px] text-white/95 leading-snug pt-0.5">
              <div className="col-span-5">
                <div className="font-semibold">PERAN: {permanentRoleLabel}</div>
                <div className="text-cyan-100">({localIp})</div>
              </div>
              <div className="col-span-7">
                <div>
                  Peer Aktif:{' '}
                  <strong className="text-white">
                    {activeChannelPeers.length}
                  </strong>{' '}
                  • Target:{' '}
                  <strong className="text-white">
                    {targetedClientsCount} activeClients
                  </strong>
                </div>
                <div className="text-cyan-100">(Unicast)</div>
              </div>
            </div>
          </section>

          {/* 3. CARD CHANNEL SELECTOR (Tanpa menutup/memutus koneksi UDP) */}
          <section className="tactical-panel rounded-2xl p-3.5 space-y-2.5">
            <div className="flex items-center justify-between px-1">
              <span className="text-cyan-300 text-xs">▼</span>
              <h2 className="font-tactical text-[15px] font-bold tracking-[0.08em] text-white text-center">
                CHANNEL SELECTOR - CLOUD &amp; HOTSPOT SYNC
              </h2>
              <span className="text-cyan-300 text-xs">▼</span>
            </div>

            <div className="flex items-center justify-between gap-3">
              {/* Knob Kiri (Channel - 1) */}
              <button
                onClick={() => setChannel((c) => (c > 1 ? c - 1 : 99))}
                aria-label="Channel Sebelumnya"
                className="w-14 h-14 rounded-full bg-gradient-to-b from-[#0b476e] to-[#031c32] border-2 border-[#23dcff]/70 shadow-[0_0_15px_rgba(35,220,255,0.28)] flex items-center justify-center active:scale-95 transition-transform shrink-0 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-full border border-cyan-300/40 bg-[#052946] relative">
                  <span className="w-1 h-3 bg-white rounded-full absolute bottom-1.5 right-2 rotate-[-35deg]" />
                </div>
              </button>

              {/* Layar Tengah CHANNEL */}
              <div className="flex-1 tactical-panel-inset rounded-2xl py-2.5 px-3 text-center">
                <div className="font-tactical text-[32px] leading-none font-extrabold tracking-[0.12em] text-white cyan-glow-text">
                  CHANNEL {String(channel).padStart(2, '0')}
                </div>
                <div className="font-telemetry text-[12px] text-cyan-200 tracking-wider mt-1">
                  MASTER HOST - 192.168.43.1
                </div>
              </div>

              {/* Knob Kanan (Channel + 1) */}
              <button
                onClick={() => setChannel((c) => (c < 99 ? c + 1 : 1))}
                aria-label="Channel Berikutnya"
                className="w-14 h-14 rounded-full bg-gradient-to-b from-[#0b476e] to-[#031c32] border-2 border-[#23dcff]/70 shadow-[0_0_15px_rgba(35,220,255,0.28)] flex items-center justify-center active:scale-95 transition-transform shrink-0 cursor-pointer"
              >
                <div className="w-9 h-9 rounded-full border border-cyan-300/40 bg-[#052946] relative">
                  <span className="w-1 h-3 bg-white rounded-full absolute bottom-1.5 left-2 rotate-[35deg]" />
                </div>
              </button>
            </div>

            {/* Keterangan bawah card & tombol BARCODE */}
            <div className="flex items-center justify-between pt-0.5">
              <div className="font-tactical text-[14px] font-bold tracking-wider text-white">
                {permanentRoleLabel} AKTIF | {activeChannelPeers.length} MEMBERS ONLINE
              </div>
              <button
                onClick={() => setActiveBottomModal('barcode')}
                className="min-h-[36px] px-3 py-1 rounded-lg bg-[#052542] hover:bg-[#093862] border border-[#23dcff]/65 flex items-center gap-1.5 text-xs font-bold text-white transition-colors cursor-pointer"
              >
                <QrCode className="w-4 h-4 text-[#23dcff]" />
                <span>BARCODE</span>
              </button>
            </div>
          </section>

          {/* 4. GRID USER / ANGGOTA (REAL PEERS ONLY) */}
          <section className="space-y-2">
            {/* Baris Atas: Tombol (•) TALK ALL, ID SAYA: [CALLSIGN], dan Edit Nama */}
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => {
                  const next = !talkAll;
                  setTalkAll(next);
                  if (next) {
                    setMembers((prev) => prev.map((m) => ({ ...m, isTargeted: true })));
                  }
                }}
                className={`min-h-[44px] px-4 py-2 rounded-full font-tactical text-[16px] font-bold tracking-wider flex items-center gap-2 transition-all shrink-0 cursor-pointer ${
                  talkAll
                    ? 'cyan-btn-glow text-white border border-white/50'
                    : 'bg-[#052542] text-cyan-200 border border-cyan-400/50'
                }`}
              >
                <Radio className="w-4 h-4" />
                <span>TALK ALL</span>
              </button>

              <div className="flex-1 tactical-panel rounded-full px-3.5 py-1.5 flex items-center justify-between gap-2 min-h-[44px]">
                <div className="font-telemetry text-xs truncate">
                  <span className="text-cyan-200/90">ID SAYA: </span>
                  <strong className="text-white font-bold">{myCallsign}</strong>
                </div>
                <button
                  onClick={() => openEditNameModal()}
                  className="px-2.5 py-1 rounded-full bg-[#041d34] hover:bg-[#083156] border border-cyan-400/50 flex items-center gap-1 text-[11px] font-medium text-cyan-100 shrink-0 cursor-pointer"
                >
                  <Pencil className="w-3 h-3 text-[#23dcff]" />
                  <span>Edit Nama</span>
                </button>
              </div>
            </div>

            {/* Baris Bawah: Hanya menampilkan Real Peers. Jika kosong tampilkan "MENCARI ANGGOTA AKTIF..." */}
            {activeChannelPeers.length === 0 ? (
              <div className="tactical-panel rounded-2xl py-5 px-4 text-center space-y-1.5">
                <div className="flex items-center justify-center gap-2 text-[#23dcff]">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span className="font-tactical text-[16px] font-extrabold tracking-wider text-white">
                    MENCARI ANGGOTA AKTIF...
                  </span>
                </div>
                <p className="font-telemetry text-[10.5px] text-cyan-200/80">
                  Menunggu perangkat lain terhubung ke CHANNEL {String(channel).padStart(2, '0')} (Broadcast 1s Aktif)
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {activeChannelPeers.map((member) => {
                  const isHighlighted =
                    selectedMemberId === member.id ||
                    incomingSpeaker === member.callsign ||
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
                      className={`rounded-2xl p-2 flex items-center justify-between gap-1.5 border transition-all cursor-pointer ${
                        isHighlighted
                          ? 'bg-gradient-to-b from-[#17a9d9] to-[#0c6c99] border-[#66ecff] shadow-[0_0_16px_rgba(35,220,255,0.45)]'
                          : 'bg-gradient-to-b from-[#062b4c] to-[#041d35] border-[#23dcff]/45 hover:border-[#23dcff]'
                      }`}
                    >
                      <div className="relative w-7 h-7 rounded-full bg-[#03192e] border border-cyan-400/55 flex items-center justify-center shrink-0">
                        <Mic className="w-3.5 h-3.5 text-[#23dcff]" />
                        <span className="w-2 h-2 rounded-full bg-[#23dcff] absolute -top-0.5 -right-0.5" />
                      </div>

                      <div className="min-w-0 flex-1 leading-tight">
                        <div className="font-tactical text-[14px] font-bold text-white truncate">
                          {member.callsign}
                        </div>
                        <div className="font-telemetry text-[9.5px] text-cyan-100/90 truncate">
                          {member.ip}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 5. TOMBOL PTT UTAMA (CENTER) */}
          <section className="py-1.5 flex items-center justify-center gap-3">
            {/* Indikator Gelombang Suara Kiri */}
            <div className="flex items-center gap-1">
              {[6, 7, 8, 9, 11, 13, 15, 17, 19, 21].map((h, i) => (
                <span
                  key={`lw-${i}`}
                  style={{
                    height: isTransmitting
                      ? `${Math.max(6, ((h * micLevel) / 60) % 30)}px`
                      : `${h * 0.65}px`,
                  }}
                  className={`w-1 rounded-full transition-all duration-75 ${
                    isTransmitting || incomingSpeaker
                      ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
                      : 'bg-[#23dcff]/55'
                  }`}
                />
              ))}
            </div>

            {/* Tombol Lingkaran Raksasa PTT (Push-To-Talk & Hold) */}
            <button
              type="button"
              onMouseDown={handlePttStart}
              onMouseUp={handlePttEnd}
              onMouseLeave={handlePttEnd}
              onTouchStart={(e) => {
                e.preventDefault();
                handlePttStart();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                handlePttEnd();
              }}
              className={`relative w-48 h-48 sm:w-52 sm:h-52 rounded-full border-[3px] flex items-center justify-center transition-transform duration-150 cursor-pointer select-none ${
                isTransmitting
                  ? 'ptt-ring-active border-white scale-[0.97]'
                  : 'ptt-ring-outer border-[#2fe0ff] active:scale-95'
              }`}
            >
              {/* Teks Melingkar "PUSH TO TALK & HOLD" */}
              <div className="absolute inset-0 pointer-events-none">
                {curvedChars.map((char, index) => {
                  const total = curvedChars.length;
                  const spreadDeg = 112;
                  const startAngle = -spreadDeg / 2;
                  const angle = startAngle + (index / (total - 1)) * spreadDeg;
                  return (
                    <span
                      key={index}
                      style={{
                        transform: `rotate(${angle}deg)`,
                      }}
                      className="absolute left-1/2 top-2 -ml-[5px] h-[86px] sm:h-[94px] origin-bottom font-tactical text-[11.5px] font-extrabold text-[#02192d] tracking-wider"
                    >
                      {char}
                    </span>
                  );
                })}
              </div>

              {/* Lingkaran Dalam Tombol PTT */}
              <div
                className={`w-32 h-32 sm:w-36 sm:h-36 rounded-full border-2 flex flex-col items-center justify-center px-3 text-center transition-all ${
                  isTransmitting
                    ? 'bg-gradient-to-b from-[#33e6ff] to-[#066c96] border-white shadow-inner'
                    : 'bg-gradient-to-b from-[#178bbf] via-[#0a4c73] to-[#052942] border-[#6beaff]/65 shadow-[inset_0_3px_10px_rgba(255,255,255,0.25)]'
                }`}
              >
                <Radio
                  className={`w-10 h-10 sm:w-11 sm:h-11 mb-1 ${
                    isTransmitting
                      ? 'text-[#021b30] animate-pulse'
                      : 'text-[#03233b]'
                  }`}
                />
                <span className="font-tactical text-[15px] sm:text-[16px] font-extrabold tracking-wider text-white drop-shadow">
                  {isTransmitting
                    ? 'TRANSMITTING'
                    : incomingSpeaker
                    ? `RX: ${incomingSpeaker}`
                    : 'MASTER READY'}
                </span>
              </div>
            </button>

            {/* Indikator Gelombang Suara Kanan */}
            <div className="flex items-center gap-1">
              {[21, 19, 17, 15, 13, 11, 9, 8, 7, 6].map((h, i) => (
                <span
                  key={`rw-${i}`}
                  style={{
                    height: isTransmitting
                      ? `${Math.max(6, ((h * micLevel) / 60) % 30)}px`
                      : `${h * 0.65}px`,
                  }}
                  className={`w-1 rounded-full transition-all duration-75 ${
                    isTransmitting || incomingSpeaker
                      ? 'bg-[#23dcff] shadow-[0_0_8px_#23dcff]'
                      : 'bg-[#23dcff]/55'
                  }`}
                />
              ))}
            </div>
          </section>

          {/* BANNER STATUS BAWAH ("MASTER READY") */}
          <button
            type="button"
            onMouseDown={handlePttStart}
            onMouseUp={handlePttEnd}
            onMouseLeave={handlePttEnd}
            onTouchStart={(e) => {
              e.preventDefault();
              handlePttStart();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              handlePttEnd();
            }}
            className="w-full py-3 rounded-2xl cyan-btn-glow font-tactical text-[19px] font-extrabold tracking-[0.08em] text-white text-center shadow-[0_0_25px_rgba(35,220,255,0.45)] cursor-pointer"
          >
            {isTransmitting
              ? 'TRANSMITTING VOICE STREAM...'
              : incomingSpeaker
              ? `RECEIVING VOICE: ${incomingSpeaker}`
              : 'MASTER READY'}
          </button>
        </div>

        {/* 6. BOTTOM NAVIGATION BAR: [Channels], [Edit Nama], [Barcode], [Settings] */}
        <nav className="w-full bg-[#021526]/95 border-t border-cyan-400/35 px-2 py-2.5 grid grid-cols-4 gap-1 shrink-0">
          <button
            onClick={() => setActiveBottomModal('channels')}
            className="flex flex-col items-center justify-center py-1 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Radio className="w-5 h-5 text-[#23dcff] mb-1" />
            <span className="font-telemetry text-[11px] font-semibold">
              [Channels]
            </span>
          </button>

          <button
            onClick={() => openEditNameModal()}
            className="flex flex-col items-center justify-center py-1 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Pencil className="w-5 h-5 text-[#23dcff] mb-1" />
            <span className="font-telemetry text-[11px] font-semibold">
              [Edit Nama]
            </span>
          </button>

          <button
            onClick={() => setActiveBottomModal('barcode')}
            className="flex flex-col items-center justify-center py-1 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <QrCode className="w-5 h-5 text-[#23dcff] mb-1" />
            <span className="font-telemetry text-[11px] font-semibold">
              [Barcode]
            </span>
          </button>

          <button
            onClick={() => {
              setSettingsTab('audio');
              setActiveBottomModal('settings');
            }}
            className="flex flex-col items-center justify-center py-1 text-cyan-100 hover:text-[#23dcff] transition-colors cursor-pointer"
          >
            <Settings className="w-5 h-5 text-[#23dcff] mb-1" />
            <span className="font-telemetry text-[11px] font-semibold">
              [Settings]
            </span>
          </button>
        </nav>

        {/* ===================================================================
            MODAL OVERLAYS ([Channels], [Edit Nama], [Barcode], [Settings])
           =================================================================== */}
        {activeBottomModal && (
          <div className="fixed inset-0 bg-[#010d18]/90 backdrop-blur-md z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-[460px] max-h-[88dvh] overflow-y-auto tactical-panel rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-cyan-400/30 pb-3">
                <h3 className="font-tactical text-lg font-bold tracking-wider text-[#23dcff]">
                  {activeBottomModal === 'channels' &&
                    'PILIH FREKUENSI CHANNEL PTT'}
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

              {/* MODAL 2: EDIT NAMA */}
              {activeBottomModal === 'editName' && (
                <form onSubmit={handleSaveName} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-cyan-200 mb-1.5">
                      CALLSIGN TAKTIKAL (MAKS 10 KARAKTER)
                    </label>
                    <input
                      type="text"
                      maxLength={10}
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      autoFocus
                      className="w-full px-3.5 py-2.5 rounded-xl bg-[#021424] border border-[#23dcff] text-white font-telemetry font-bold uppercase focus:outline-none"
                      placeholder="CONTOH: YUDHI"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveBottomModal(null)}
                      className="px-4 py-2 rounded-lg text-xs font-semibold text-cyan-200 hover:bg-cyan-500/10 cursor-pointer"
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
                      <div className="w-48 h-48 mx-auto bg-white p-2.5 rounded-2xl flex flex-col items-center justify-center shadow-[0_0_25px_rgba(35,220,255,0.35)] border-2 border-[#23dcff]">
                        {qrCodeDataUrl ? (
                          <img
                            src={qrCodeDataUrl}
                            alt="QR Code Invite Link"
                            className="w-full h-full object-contain rounded-lg select-all"
                          />
                        ) : (
                          <QrCode className="w-36 h-36 text-[#03192e]" />
                        )}
                      </div>

                      <div className="space-y-0.5">
                        <div className="font-telemetry text-xs text-white font-extrabold">
                          BARCODE HOST: {myCallsign} ({localIp}) • CH{' '}
                          {String(channel).padStart(2, '0')}
                        </div>
                        <div className="font-telemetry text-[10.5px] text-cyan-200/85">
                          Buka menu <strong className="text-white">[Barcode] &rarr; SCAN BARCODE</strong> di HP lain untuk langsung terhubung tanpa browser!
                        </div>
                      </div>

                      <div className="space-y-1.5 text-left">
                        <label className="block font-telemetry text-[10.5px] text-cyan-200 font-bold">
                          LINK INVITE &amp; KODE NODE MASTER:
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={sharePairUrl}
                          onFocus={(e) => e.currentTarget.select()}
                          className="w-full font-telemetry text-[11px] text-cyan-100 bg-[#021526] px-3 py-2 rounded-lg border border-cyan-500/40 focus:outline-none select-all"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleCopyText('pairUrl', sharePairUrl)}
                          className="py-2.5 px-3 rounded-xl cyan-btn-glow text-[#02182b] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          {copiedText === 'pairUrl' ? (
                            <>
                              <Check className="w-4 h-4" />
                              <span>Link Tersalin!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4" />
                              <span>Salin Link Invite</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={handleShareInviteLink}
                          className="py-2.5 px-3 rounded-xl bg-[#063256] hover:bg-[#0a4678] border border-[#23dcff] text-white font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <Share2 className="w-4 h-4 text-[#23dcff]" />
                          <span>Bagikan Link</span>
                        </button>
                      </div>
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
                      <div className="px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400 text-emerald-200 font-telemetry text-[11px] font-bold text-center">
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

                      <div className="flex items-center justify-between py-2 border-b border-cyan-500/20">
                        <div>
                          <div className="text-white font-bold">
                            Mode Echo / Uji Suara Mic APK
                          </div>
                          <div className="text-[10px] text-cyan-200/75">
                            Putar balik suara Anda setelah lepas tombol PTT
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

                      <div className="flex items-center justify-between py-2 border-b border-cyan-500/20">
                        <span className="text-cyan-200">Proporsi Layar</span>
                        <button
                          onClick={() => setFullScreenStretch((s) => !s)}
                          className="px-3 py-1.5 rounded-lg bg-[#042440] border border-cyan-400/50 text-white font-bold cursor-pointer"
                        >
                          {fullScreenStretch ? 'Full Lebar Layar' : 'Mode Potret HP'}
                        </button>
                      </div>

                      <div className="flex items-center justify-between py-2">
                        <span className="text-cyan-200">Status Izin Microphone</span>
                        <span className="font-bold text-[#23dcff] uppercase">
                          {micPermissionState === 'granted'
                            ? 'AKTIF (SIAP REKAM)'
                            : 'TEKAN PTT UTK IZIN MIC'}
                        </span>
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
                              <Check className="w-3.5 h-3.5 text-emerald-300" />
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
