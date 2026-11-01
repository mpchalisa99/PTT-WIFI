/**
 * OFFLINE HOTSPOT LAN ENGINE (TANPA INTERNET / ZERO-CLOUD)
 * ========================================================
 * Menyediakan 2 jalur penemuan & koneksi P2P murni di satu jaringan WiFi Hotspot TANPA INTERNET:
 *
 * 1. Direct Offline WebRTC LAN (Serverless SDP Offer/Answer via QR Barcode / Kode Cepat):
 *    - Menggunakan `RTCPeerConnection({ iceServers: [] })` sehingga kandidat ICE `host` (192.168.x.x)
 *      terkumpul dalam < 150ms TANPA DNS lookup dan TANPA server STUN/TURN internet.
 *    - Mengompresi SDP Offer & Answer menjadi payload ringkas (`OFFLINE-OFFER` / `OFFLINE-ANSWER`)
 *      yang muat di dalam QR Code untuk di-scan langsung antar HP menggunakan kamera in-app.
 *
 * 2. Auto-Probe Local Hotspot WebSocket Hub (`ws://192.168.43.1:50002`, `ws://[subnet].1:50002`):
 *    - Mendeteksi IP lokal Hotspot via kandidat ICE `host` dan otomatis memindai gateway `.1`
 *      apabila HP Master menjalankan Hub Lokal (APK Native / Local Hotspot Relay).
 */

export interface CompactOfflineSignal {
  /** 'O' = Offer dari Master, 'A' = Answer dari Client */
  t: 'O' | 'A';
  /** Callsign pengirim */
  c: string;
  /** Device ID pengirim */
  id: string;
  /** IP lokal Hotspot */
  ip: string;
  /** Channel aktif */
  ch: number;
  /** Sesi / Slot ID di sisi Master */
  sid: string;
  /** Raw SDP (sudah diringkas agar ukurannya sangat kecil untuk QR Code) */
  sdp: string;
}

/**
 * Meringkas SDP WebRTC DataChannel dengan membuang baris-baris ekstensi yang tidak diperlukan
 * agar ukuran QR Code sangat ringan dan mudah dipindai oleh kamera HP dalam < 0.5 detik.
 */
export function minifyDataChannelSdp(rawSdp: string): string {
  const lines = rawSdp.split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith('v=') ||
      trimmed.startsWith('o=') ||
      trimmed.startsWith('s=') ||
      trimmed.startsWith('t=') ||
      trimmed.startsWith('a=group:') ||
      trimmed.startsWith('m=application') ||
      trimmed.startsWith('c=IN') ||
      trimmed.startsWith('a=ice-ufrag:') ||
      trimmed.startsWith('a=ice-pwd:') ||
      trimmed.startsWith('a=fingerprint:') ||
      trimmed.startsWith('a=setup:') ||
      trimmed.startsWith('a=mid:') ||
      trimmed.startsWith('a=sctp-port:') ||
      trimmed.startsWith('a=max-message-size:') ||
      (trimmed.startsWith('a=candidate:') && trimmed.includes(' typ host'))
    ) {
      kept.push(trimmed);
    }
  }

  return kept.join('\r\n') + '\r\n';
}

/**
 * Mengodekan sinyal Offline WebRTC ke string URL/Token yang aman untuk QR Code
 */
export function encodeOfflineSignalToToken(signal: CompactOfflineSignal): string {
  const json = JSON.stringify(signal);
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `DSKM-LAN:${b64}`;
}

/**
 * Mendekode string QR Code / Link menjadi objek CompactOfflineSignal jika valid
 */
export function decodeOfflineSignalFromInput(rawInput: string): CompactOfflineSignal | null {
  try {
    let token = rawInput.trim();
    if (token.includes('lanSignal=')) {
      const match = token.match(/lanSignal=([A-Za-z0-9\-_:]+)/);
      if (match && match[1]) {
        token = decodeURIComponent(match[1]);
      }
    }
    if (token.startsWith('DSKM-LAN:')) {
      token = token.slice('DSKM-LAN:'.length);
    } else if (!token.startsWith('{')) {
      return null;
    }

    let jsonStr = token;
    if (!token.startsWith('{')) {
      const padded = token.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = (4 - (padded.length % 4)) % 4;
      jsonStr = decodeURIComponent(escape(atob(padded + '='.repeat(padLen))));
    }

    const parsed = JSON.parse(jsonStr) as CompactOfflineSignal;
    if (
      (parsed.t === 'O' || parsed.t === 'A') &&
      typeof parsed.sdp === 'string' &&
      parsed.sdp.includes('a=ice-ufrag:')
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Menunggu hingga pengumpulan kandidat ICE lokal (`host` 192.168.x.x) selesai
 * dengan batas waktu cepat (default 600ms) agar tidak pernah macet saat tanpa internet.
 */
export function waitForLocalIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = 650
): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };

    const timer = window.setTimeout(finish, timeoutMs);

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(timer);
        finish();
      }
    };

    let hostCandidateFound = false;
    const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
      if (!ev.candidate) {
        window.clearTimeout(timer);
        finish();
      } else if (ev.candidate.candidate && ev.candidate.candidate.includes(' typ host')) {
        if (!hostCandidateFound) {
          hostCandidateFound = true;
          // Beri 180ms tambahan untuk kandidat interface kedua jika ada, lalu langsung selesai
          window.setTimeout(() => {
            window.clearTimeout(timer);
            finish();
          }, 180);
        }
      }
    };

    pc.addEventListener('icegatheringstatechange', onStateChange);
    pc.addEventListener('icecandidate', onCandidate);
  });
}

/**
 * Mendeteksi IPv4 LAN / Hotspot lokal perangkat (misal 192.168.43.x atau 192.168.x.x)
 * menggunakan kandidat ICE `host` lokal tanpa koneksi internet.
 */
export async function detectLocalHotspotIpWebRTC(): Promise<string | null> {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('ip_probe');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForLocalIceGathering(pc, 500);
    const sdp = pc.localDescription?.sdp || '';
    pc.close();

    const ipRegex = /((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})/g;
    const matches = sdp.match(ipRegex);
    if (matches && matches.length > 0) {
      return matches[0];
    }
    return null;
  } catch {
    return null;
  }
}
