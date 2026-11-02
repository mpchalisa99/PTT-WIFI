import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:provider/provider.dart';
import 'package:record/record.dart';
import 'package:udp/udp.dart';

/// ============================================================================
/// 1. ENTRY POINT UTAMA (main) & MULTIPROVIDER
/// ============================================================================
void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  SystemChrome.setSystemUIOverlayStyle(
    const SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarIconBrightness: Brightness.light,
    ),
  );

  final audioService = AudioService();
  final udpNetworkService = UdpNetworkService();

  // Hubungkan Floor Control & Strict Half-Duplex antara UdpNetworkService dan AudioService:
  // 1) Saat menerima paket TX_START dari peer lain (atau terkena Master Override),
  //    paksa matikan Mic (stopRecording) dan kembalikan volume speaker ke 1.0 (Max).
  udpNetworkService.onEnterReceiveMode = () async {
    await audioService.enterReceiveMode();
  };

  // 2) Saat menerima paket suara PCM dari UDP Port 50001, putar hanya jika tidak sedang Tx
  udpNetworkService.onAudioPacketReceived = (Uint8List pcmBytes, String senderIp) {
    audioService.playAudioChunk(pcmBytes);
  };

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<UdpNetworkService>.value(
          value: udpNetworkService,
        ),
        Provider<AudioService>.value(
          value: audioService,
        ),
      ],
      child: const DiskomlekauTacticalPttApp(),
    ),
  );
}

/// ============================================================================
/// 2. MODEL DATA ANGGOTA (PeerMember)
/// ============================================================================
class PeerMember {
  final String id;
  String callsign;
  final String ipAddress;
  final int channel;
  bool isTargeted;
  bool isTransmitting;
  DateTime lastSeen;
  int lastPingMs;

  PeerMember({
    required this.id,
    required this.callsign,
    required this.ipAddress,
    required this.channel,
    this.isTargeted = true,
    this.isTransmitting = false,
    this.lastPingMs = 18,
    DateTime? lastSeen,
  }) : lastSeen = lastSeen ?? DateTime.now();

  /// Factory untuk memproses data JSON dari paket UDP Broadcast Auto-Discovery
  factory PeerMember.fromJson(Map<String, dynamic> json) {
    return PeerMember(
      id: (json['id'] ?? json['ip'] ?? 'UNKNOWN').toString(),
      callsign: (json['callsign'] ?? 'PEER').toString().toUpperCase(),
      ipAddress: (json['ip'] ?? '0.0.0.0').toString(),
      channel: (json['ch'] as num?)?.toInt() ?? 12,
      isTargeted: json['isTargeted'] as bool? ?? true,
      isTransmitting: json['tx'] as bool? ?? false,
      lastPingMs: (json['ping'] as num?)?.toInt() ?? 18,
      lastSeen: DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'callsign': callsign,
        'ip': ipAddress,
        'ch': channel,
        'isTargeted': isTargeted,
        'tx': isTransmitting,
        'ping': lastPingMs,
      };
}

/// ============================================================================
/// 3. UDP NETWORK SERVICE
/// - Floor Control (TX_START & TX_STOP) via Port 50000 (Anti-Crowded)
/// - Master Override: HP MASTER (192.168.43.1) selalu bisa mengambil alih jalur bicara
/// - Tanpa Re-bind saat pindah channel (Socket tetap terbuka & stabil)
/// - Auto-Discovery Broadcast konstan setiap 1 detik (Port 50000)
/// - Real Peers Only (Tidak ada data anggota palsu/simulasi)
/// ============================================================================
class UdpNetworkService extends ChangeNotifier {
  static const int discoveryPort = 50000;
  static const int audioPort = 50001;
  static const String masterHotspotIp = '192.168.43.1';

  UDP? _discoverySocket;
  UDP? _audioSocket;
  Timer? _heartbeatTimer;
  Timer? _pruneTimer;
  Timer? _floorWatchdogTimer;

  bool _isInitialized = false;
  String _localIp = '0.0.0.0';
  String _myCallsign = '';
  final String _deviceId = 'NODE-${DateTime.now().millisecondsSinceEpoch % 100000}';
  int _currentChannel = 12;
  bool _isMaster = false;
  bool _talkAll = true;
  bool _isTransmitting = false;
  int _lastPingMs = 18;
  int _pingDeltaMs = 2;
  int _txSequence = 0;
  int _subnetSweepCursor = 2;

  /// State Floor Control (Hak Bicara / Anti-Crowded)
  String? _activeSpeakerIp;
  String? _activeSpeakerCallsign;
  bool _activeSpeakerIsMaster = false;
  DateTime? _lastTxPacketTime;

  /// Map murni berisi perangkat nyata yang aktif di jaringan Hotspot (key: IP)
  final Map<String, PeerMember> _peers = {};

  /// Callback ke AudioService saat paket PCM diterima atau saat dipaksa masuk mode Rx
  void Function(Uint8List pcmBytes, String senderIp)? onAudioPacketReceived;
  Future<void> Function()? onEnterReceiveMode;

  bool get isInitialized => _isInitialized;
  String get localIp => _localIp;
  String get myCallsign => _myCallsign;
  int get currentChannel => _currentChannel;
  bool get isMaster => _isMaster;
  String get roleLabel => _isMaster ? 'HP MASTER' : 'CLIENT';
  bool get talkAll => _talkAll;
  bool get isTransmitting => _isTransmitting;
  int get lastPingMs => _lastPingMs;
  int get pingDeltaMs => _pingDeltaMs;
  bool get isHighLatency => _lastPingMs > 150;

  /// Informasi siapa yang sedang memegang Floor Control (Hak Bicara) di channel ini
  String? get activeSpeakerIp => _activeSpeakerIp;
  String? get activeSpeakerCallsign => _activeSpeakerCallsign;
  bool get isReceiving =>
      !_isTransmitting && _activeSpeakerIp != null && _activeSpeakerIp != _localIp;

  /// ATURAN FLOOR CONTROL & MASTER OVERRIDE:
  /// - Jika ada user lain yang sedang bicara (`isReceiving == true`):
  ///   * Klien biasa (`!_isMaster`) DIKUNCI tombol PTT-nya (`isPttLocked == true`).
  ///   * HP MASTER (`_isMaster == true`) TIDAK DIKUNCI (`isPttLocked == false`)
  ///     karena memiliki hak MASTER OVERRIDE untuk mengambil alih jalur bicara kapan saja.
  bool get isPttLocked => isReceiving && !_isMaster;

  /// Hanya mengembalikan daftar klien nyata yang aktif pada channel saat ini
  List<PeerMember> get activeChannelPeers => _peers.values
      .where((p) => p.channel == _currentChannel)
      .toList()
    ..sort((a, b) => a.callsign.compareTo(b.callsign));

  /// Daftar peer tujuan pengiriman paket suara Unicast pada channel aktif
  List<PeerMember> get targetedPeers => activeChannelPeers
      .where((p) => _talkAll || p.isTargeted)
      .toList();

  /// Dipanggil dari SetupScreen saat pengguna menekan tombol "KONEK JARINGAN"
  Future<void> connectWithCallsign(String callsign) async {
    _myCallsign = callsign.trim().toUpperCase();
    await initialize();
  }

  /// Inisialisasi IP lokal & buka socket UDP Port 50000 dan 50001 HANYA SEKALI
  Future<void> initialize() async {
    await _detectLocalHotspotIp();

    if (_discoverySocket == null) {
      await _bindDiscoverySocket();
    }
    if (_audioSocket == null) {
      await _bindAudioSocket();
    }

    // Kirim UDP Discovery (4-Vector: Subnet Broadcast + Gateway Unicast + ARP + Sweep) setiap 1 detik
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) async {
        await _detectLocalHotspotIp();
        await _sendDiscoveryAnnouncement();
      },
    );

    // Bersihkan peer yang putus WiFi (> 6 detik) & reset Floor Control jika paket TX_STOP hilang
    _pruneTimer?.cancel();
    _pruneTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) {
        _pruneStalePeers();
        _checkFloorControlTimeout();
      },
    );

    _isInitialized = true;
    await _sendDiscoveryAnnouncement();
    notifyListeners();
  }

  /// Deteksi IP lokal perangkat pada interface Hotspot/WiFi (`ap0`, `wlan0`, `swlan0`, `softap0`, `rndis0`)
  /// termasuk saat Mobile Data MATI (Hotspot Tanpa Internet di Android 10–15).
  Future<void> _detectLocalHotspotIp() async {
    String? detectedIp;
    try {
      final info = NetworkInfo();
      final wifiIp = await info.getWifiIP();
      if (wifiIp != null && wifiIp.isNotEmpty && wifiIp != '0.0.0.0') {
        detectedIp = wifiIp;
      }

      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      );

      // Prioritaskan interface Hotspot/Tethering/WiFi (`ap`, `swlan`, `wlan`, `softap`, `rndis`)
      for (final iface in interfaces) {
        final name = iface.name.toLowerCase();
        final isHotspotIface = name.contains('ap') ||
            name.contains('wlan') ||
            name.contains('swlan') ||
            name.contains('rndis') ||
            name.contains('eth');
        for (final addr in iface.addresses) {
          final ip = addr.address;
          if (ip == masterHotspotIp) {
            detectedIp = masterHotspotIp;
            break;
          }
          if (isHotspotIface && (ip.startsWith('192.168.') || ip.startsWith('172.'))) {
            detectedIp = ip;
          } else if ((detectedIp == null || detectedIp.isEmpty) && ip.startsWith('192.168.')) {
            detectedIp = ip;
          }
        }
        if (detectedIp == masterHotspotIp) break;
      }
    } catch (e) {
      debugPrint('Gagal membaca NetworkInterface: $e');
    }

    _localIp = (detectedIp != null && detectedIp.isNotEmpty)
        ? detectedIp
        : masterHotspotIp;

    // Kunci peran Master jika IP adalah '192.168.43.1' atau gateway Hotspot '.1'
    _isMaster = (_localIp == masterHotspotIp || _localIp.endsWith('.1'));
  }

  /// Membaca tabel ARP kernel Android (`/proc/net/arp`) untuk menemukan IP klien/master
  /// yang terhubung di Hotspot meskipun UDP Broadcast diblokir oleh firmware HP.
  Future<List<String>> _readConnectedHotspotArpIps() async {
    final List<String> arpIps = [];
    try {
      final arpFile = File('/proc/net/arp');
      if (await arpFile.exists()) {
        final lines = await arpFile.readAsLines();
        for (int i = 1; i < lines.length; i++) {
          final cols = lines[i].trim().split(RegExp(r'\s+'));
          if (cols.isNotEmpty) {
            final ip = cols[0];
            if (ip != _localIp &&
                (ip.startsWith('192.168.') || ip.startsWith('172.'))) {
              arpIps.add(ip);
            }
          }
        }
      }
    } catch (_) {}
    return arpIps;
  }

  /// Buka socket UDP Port 50000 sekali saja & tangani ANNOUNCE, PEER_LIST_SYNC, TX_START, TX_STOP, PING, PONG
  Future<void> _bindDiscoverySocket() async {
    try {
      _discoverySocket = await UDP.bind(Endpoint.any(port: const Port(discoveryPort)));

      _discoverySocket!.asStream().listen((Datagram? datagram) {
        if (datagram == null) return;
        final senderIp = datagram.address.address;

        // Abaikan paket pantulan dari IP sendiri
        if (senderIp == _localIp) return;

        try {
          final Map<String, dynamic> data = jsonDecode(utf8.decode(datagram.data));
          final String type = (data['type'] ?? '').toString();
          final int packetCh = (data['ch'] as num?)?.toInt() ?? _currentChannel;

          if (type == 'ANNOUNCE') {
            final String announcedIp = (data['ip'] ?? senderIp).toString();
            final String peerKey = (announcedIp.isNotEmpty && announcedIp != '0.0.0.0')
                ? announcedIp
                : senderIp;
            if (peerKey == _localIp) return;

            data['ip'] = peerKey;
            final bool isNewPeer = !_peers.containsKey(peerKey);
            final incoming = PeerMember.fromJson(data);
            final existing = _peers[peerKey];
            if (existing != null) {
              incoming.isTargeted = existing.isTargeted;
              incoming.lastPingMs = existing.lastPingMs;
            }
            _peers[peerKey] = incoming;

            // Jika peer baru terdeteksi, langsung balas Unicast ANNOUNCE ke pengirim agar instan (< 100ms)
            if (isNewPeer) {
              _sendDirectUnicastAnnounce(peerKey);
            }

            // Jika perangkat ini adalah HP MASTER, sebarkan PEER_LIST_SYNC ke seluruh klien Hotspot
            // agar semua klien saling menemukan meskipun Hotspot memblokir Broadcast antar-klien (AP Isolation)
            if (_isMaster) {
              _broadcastPeerListSyncFromMaster();
            }

            // Sinkronisasi Floor Control jika pengirim sedang transmit di channel yang sama
            if (packetCh == _currentChannel && incoming.isTransmitting) {
              _handleIncomingTxStart(
                senderIp: peerKey,
                senderCallsign: incoming.callsign,
                senderIsMaster: peerKey == masterHotspotIp ||
                    peerKey.endsWith('.1') ||
                    (data['isMaster'] == true),
              );
            }
            notifyListeners();
          } else if (type == 'PEER_LIST_SYNC') {
            final List<dynamic>? list = data['peers'] as List<dynamic>?;
            if (list != null) {
              bool changed = false;
              for (final item in list) {
                if (item is Map<String, dynamic>) {
                  final String pIp = (item['ip'] ?? '').toString();
                  if (pIp.isEmpty || pIp == _localIp) continue;
                  final incoming = PeerMember.fromJson(item);
                  final existing = _peers[pIp];
                  if (existing != null) {
                    incoming.isTargeted = existing.isTargeted;
                    incoming.lastPingMs = existing.lastPingMs;
                  }
                  _peers[pIp] = incoming;
                  changed = true;
                }
              }
              if (changed) notifyListeners();
            }
          } else if (type == 'TX_START') {
            if (packetCh != _currentChannel) return;

            final String originIp = (data['ip'] ?? senderIp).toString();
            final String speakerCallsign =
                (data['callsign'] ?? _peers[originIp]?.callsign ?? originIp)
                    .toString()
                    .toUpperCase();
            final bool senderIsMaster = originIp == masterHotspotIp ||
                originIp.endsWith('.1') ||
                (data['isMaster'] == true);

            _handleIncomingTxStart(
              senderIp: originIp,
              senderCallsign: speakerCallsign,
              senderIsMaster: senderIsMaster,
            );

            // Jika HP MASTER menerima TX_START dari salah satu Client, teruskan (Relay Unicast) ke Client lain
            if (_isMaster && senderIp != _localIp) {
              _relayControlPacketToOtherClients(datagram.data, excludeIp: senderIp);
            }
          } else if (type == 'TX_STOP') {
            if (packetCh != _currentChannel) return;

            final String originIp = (data['ip'] ?? senderIp).toString();
            if (_peers.containsKey(originIp)) {
              _peers[originIp]!.isTransmitting = false;
            }
            if (_activeSpeakerIp == originIp) {
              _activeSpeakerIp = null;
              _activeSpeakerCallsign = null;
              _activeSpeakerIsMaster = false;
              _lastTxPacketTime = null;
            }
            if (_isMaster && senderIp != _localIp) {
              _relayControlPacketToOtherClients(datagram.data, excludeIp: senderIp);
            }
            notifyListeners();
          } else if (type == 'PING') {
            _sendPong(senderIp, (data['ts'] as num).toInt());
          } else if (type == 'PONG') {
            final sentTs = (data['ts'] as num).toInt();
            final rtt = (DateTime.now().millisecondsSinceEpoch - sentTs).clamp(1, 999);
            _pingDeltaMs = (rtt - _lastPingMs).abs();
            _lastPingMs = rtt;
            if (_peers.containsKey(senderIp)) {
              _peers[senderIp]!.lastPingMs = rtt;
            }
            notifyListeners();
          }
        } catch (e) {
          debugPrint('Paket UDP Discovery rusak dari $senderIp: $e');
        }
      });
    } catch (e) {
      debugPrint('Gagal bind discovery socket port $discoveryPort: $e');
    }
  }

  /// Mengirim daftar lengkap anggota aktif (`PEER_LIST_SYNC`) dari HP MASTER ke seluruh Client via Unicast
  Future<void> _broadcastPeerListSyncFromMaster() async {
    if (_discoverySocket == null || !_isMaster || _myCallsign.isEmpty) return;

    final List<Map<String, dynamic>> allNodes = [
      {
        'id': _deviceId,
        'callsign': _myCallsign,
        'ip': _localIp,
        'ch': _currentChannel,
        'tx': _isTransmitting,
        'ping': _lastPingMs,
      },
      ..._peers.values.map((p) => p.toJson()),
    ];

    final bytes = utf8.encode(
      jsonEncode({
        'type': 'PEER_LIST_SYNC',
        'ch': _currentChannel,
        'peers': allNodes,
      }),
    );

    for (final peer in _peers.values) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(
            InternetAddress(peer.ipAddress),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }
  }

  /// Balas langsung ANNOUNCE via Unicast ke IP tertentu
  Future<void> _sendDirectUnicastAnnounce(String targetIp) async {
    if (_discoverySocket == null || _myCallsign.isEmpty || targetIp == _localIp) return;
    final bytes = utf8.encode(
      jsonEncode({
        'type': 'ANNOUNCE',
        'id': _deviceId,
        'callsign': _myCallsign,
        'ip': _localIp,
        'ch': _currentChannel,
        'tx': _isTransmitting,
        'isMaster': _isMaster,
        'ping': _lastPingMs,
      }),
    );
    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(
          InternetAddress(targetIp),
          port: const Port(discoveryPort),
        ),
      );
    } catch (_) {}
  }

  /// Relay paket kontrol (`TX_START` / `TX_STOP`) oleh HP MASTER ke klien lain (mengatasi AP Isolation)
  Future<void> _relayControlPacketToOtherClients(
    Uint8List rawBytes, {
    required String excludeIp,
  }) async {
    if (_discoverySocket == null) return;
    for (final peer in activeChannelPeers) {
      if (peer.ipAddress == excludeIp || peer.ipAddress == _localIp) continue;
      try {
        await _discoverySocket!.send(
          rawBytes,
          Endpoint.unicast(
            InternetAddress(peer.ipAddress),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }
  }

  /// Proses paket `TX_START` (Floor Control & Master Override)
  void _handleIncomingTxStart({
    required String senderIp,
    required String senderCallsign,
    required bool senderIsMaster,
  }) {
    if (_peers.containsKey(senderIp)) {
      _peers[senderIp]!.isTransmitting = true;
      _peers[senderIp]!.lastSeen = DateTime.now();
    }

    // Jika perangkat ini adalah HP MASTER dan sedang berbicara, klien biasa tidak boleh memotong
    if (_isMaster && _isTransmitting && !senderIsMaster) {
      return;
    }

    // Jika perangkat ini (CLIENT) sedang berbicara lalu HP MASTER menekan PTT (MASTER OVERRIDE),
    // atau jika klien lain sudah lebih dulu memegang Floor Control:
    // Hentikan paksa rekaman Mic lokal (Strict Half-Duplex) dan pindah ke mode Receiving!
    if (_isTransmitting && (senderIsMaster || !_isMaster)) {
      _isTransmitting = false;
      onEnterReceiveMode?.call();
    } else if (!_isTransmitting) {
      // Pastikan AudioService berada di mode Receive (Mic Off, Speaker Volume = 1.0 Max)
      onEnterReceiveMode?.call();
    }

    _activeSpeakerIp = senderIp;
    _activeSpeakerCallsign = senderCallsign;
    _activeSpeakerIsMaster = senderIsMaster;
    _lastTxPacketTime = DateTime.now();
    notifyListeners();
  }

  /// Kirim sinyal Floor Control `TX_START` atau `TX_STOP` via port UDP Discovery (50000)
  Future<void> _sendFloorControlSignal(String signalType) async {
    if (_discoverySocket == null) return;

    final payload = utf8.encode(
      jsonEncode({
        'type': signalType, // 'TX_START' atau 'TX_STOP'
        'ip': _localIp,
        'callsign': _myCallsign,
        'ch': _currentChannel,
        'isMaster': _isMaster,
        'ts': DateTime.now().millisecondsSinceEpoch,
      }),
    );

    final parts = _localIp.split('.');
    final subnetPrefix = parts.length == 4 ? '${parts[0]}.${parts[1]}.${parts[2]}' : '192.168.43';
    final subnetBroadcast = '$subnetPrefix.255';
    final subnetGateway = '$subnetPrefix.1';

    // 1. Kirim ke Subnet Broadcast (dipisah try-catch agar tidak gagal jika tidak ada internet)
    try {
      await _discoverySocket!.send(
        payload,
        Endpoint.unicast(
          InternetAddress(subnetBroadcast),
          port: const Port(discoveryPort),
        ),
      );
    } catch (_) {}

    // 2. Kirim Unicast langsung ke Gateway Master (.1) & seluruh peer aktif
    final Set<String> unicastTargets = {
      subnetGateway,
      masterHotspotIp,
      ...activeChannelPeers.map((p) => p.ipAddress),
    }..remove(_localIp);

    for (final targetIp in unicastTargets) {
      try {
        await _discoverySocket!.send(
          payload,
          Endpoint.unicast(
            InternetAddress(targetIp),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }
  }

  /// 4-VECTOR OFFLINE HOTSPOT AUTO-DISCOVERY (Berjalan mulus 100% TANPA INTERNET):
  /// 1. Subnet Broadcast (`x.x.x.255` & `192.168.43.255`)
  /// 2. Direct Gateway Unicast (`x.x.x.1` & `192.168.43.1`) + Known Peers Unicast
  /// 3. Pembacaan Tabel ARP Kernel (`/proc/net/arp`)
  /// 4. Rotating Unicast Subnet Sweep (`x.x.x.2` .. `x.x.x.254`) untuk menembus pemblokiran Broadcast
  Future<void> _sendDiscoveryAnnouncement() async {
    if (_discoverySocket == null || _myCallsign.isEmpty) return;

    final bytes = utf8.encode(
      jsonEncode({
        'type': 'ANNOUNCE',
        'id': _deviceId,
        'callsign': _myCallsign,
        'ip': _localIp,
        'ch': _currentChannel,
        'tx': _isTransmitting,
        'isMaster': _isMaster,
        'ping': _lastPingMs,
      }),
    );

    final parts = _localIp.split('.');
    final subnetPrefix = parts.length == 4 ? '${parts[0]}.${parts[1]}.${parts[2]}' : '192.168.43';
    final subnetBroadcast = '$subnetPrefix.255';
    final subnetGateway = '$subnetPrefix.1';

    // Vector 1: Subnet Broadcast (dipisah try/catch dari Endpoint.broadcast agar bebas ENETUNREACH saat tanpa internet)
    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(
          InternetAddress(subnetBroadcast),
          port: const Port(discoveryPort),
        ),
      );
    } catch (_) {}

    if (subnetBroadcast != '192.168.43.255') {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(
            InternetAddress('192.168.43.255'),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }

    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.broadcast(port: const Port(discoveryPort)),
      );
    } catch (_) {}

    // Vector 2 & 3: Direct Unicast ke Gateway Master (.1), Peer yang sudah dikenal, dan Tabel ARP Kernel
    final arpIps = await _readConnectedHotspotArpIps();
    final Set<String> directTargets = {
      subnetGateway,
      masterHotspotIp,
      ..._peers.keys,
      ...arpIps,
    }..remove(_localIp);

    for (final ip in directTargets) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(
            InternetAddress(ip),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }

    // Vector 4: Rotating Unicast Subnet Sweep (36 IP per detik) agar otomatis saling menemukan
    // meskipun Hotspot HP memblokir paket Broadcast dan membatasi akses /proc/net/arp (Android 10+)
    for (int i = 0; i < 36; i++) {
      final hostOctet = _subnetSweepCursor;
      _subnetSweepCursor = _subnetSweepCursor >= 254 ? 2 : _subnetSweepCursor + 1;
      final candidateIp = '$subnetPrefix.$hostOctet';
      if (candidateIp == _localIp || directTargets.contains(candidateIp)) continue;
      try {
        _discoverySocket!.send(
          bytes,
          Endpoint.unicast(
            InternetAddress(candidateIp),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }

    if (_isMaster && _peers.isNotEmpty) {
      await _broadcastPeerListSyncFromMaster();
    }
  }

  /// Buka socket UDP Port 50001 sekali saja & filter paket suara via byte header channel
  Future<void> _bindAudioSocket() async {
    try {
      _audioSocket = await UDP.bind(Endpoint.any(port: const Port(audioPort)));

      _audioSocket!.asStream().listen((Datagram? datagram) {
        if (datagram == null || datagram.data.length <= 6) return;
        final senderIp = datagram.address.address;
        if (senderIp == _localIp) return;

        final bytes = datagram.data;
        final int packetChannel = bytes[0];
        final int flags = bytes[1];
        final bool packetFromMaster = (flags & 1) != 0;
        final bool isRelayedByMaster = (flags & 4) != 0;

        // Filter channel di level aplikasi tanpa menutup/re-bind socket UDP
        if (packetChannel != _currentChannel) return;

        // Jika perangkat ini adalah HP MASTER dan menerima paket suara dari Client,
        // teruskan (Unicast Audio Relay) ke seluruh Client lain di channel yang sama (mengatasi AP Isolation)
        if (_isMaster && !isRelayedByMaster) {
          final relayedPacket = Uint8List.fromList(bytes);
          relayedPacket[1] = flags | 4; // Tandai sudah di-relay agar tidak memantul kembali
          for (final peer in activeChannelPeers) {
            if (peer.ipAddress == senderIp || peer.ipAddress == _localIp) continue;
            try {
              _audioSocket!.send(
                relayedPacket,
                Endpoint.unicast(
                  InternetAddress(peer.ipAddress),
                  port: const Port(audioPort),
                ),
              );
            } catch (_) {}
          }
        }

        // Jika pengirim adalah HP MASTER (Override) saat klien ini sedang Tx, hentikan Tx klien!
        if (_isTransmitting && packetFromMaster && !_isMaster) {
          _isTransmitting = false;
          onEnterReceiveMode?.call();
        }

        // Strict Half-Duplex: Jangan putar audio masuk jika perangkat ini sedang Transmitting
        if (_isTransmitting) return;

        // Perbarui indikator Floor Control aktif dari paket suara yang mengalir
        _activeSpeakerIp = senderIp;
        _activeSpeakerCallsign =
            _peers[senderIp]?.callsign ?? (packetFromMaster ? 'MASTER' : senderIp);
        _activeSpeakerIsMaster = packetFromMaster;
        _lastTxPacketTime = DateTime.now();

        final pcmPayload = Uint8List.sublistView(bytes, 6);
        onAudioPacketReceived?.call(pcmPayload, senderIp);
        notifyListeners();
      });
    } catch (e) {
      debugPrint('Gagal bind audio socket port $audioPort: $e');
    }
  }

  /// Mulai bicara (Push-To-Talk Ditekan):
  /// - Cek apakah Floor Control sedang dikunci (`isPttLocked`).
  /// - Jika HP MASTER, diizinkan melakukan Override meskipun ada klien yang sedang bicara.
  /// - Kirim paket `TX_START` ke seluruh anggota channel.
  Future<bool> startTransmitting() async {
    if (isPttLocked) {
      return false; // Ditolak karena anggota lain sedang bicara & perangkat ini bukan Master
    }

    // Jika HP MASTER melakukan Override saat klien lain sedang bicara, ambil alih Floor Control
    _activeSpeakerIp = _localIp;
    _activeSpeakerCallsign = _myCallsign;
    _activeSpeakerIsMaster = _isMaster;
    _isTransmitting = true;
    notifyListeners();

    await _sendFloorControlSignal('TX_START');
    await _sendDiscoveryAnnouncement();
    return true;
  }

  /// Berhenti bicara (Push-To-Talk Dilepas):
  /// - Kirim paket `TX_STOP` agar kunci PTT terbuka kembali untuk seluruh anggota.
  Future<void> stopTransmitting() async {
    if (!_isTransmitting) return;
    _isTransmitting = false;
    if (_activeSpeakerIp == _localIp) {
      _activeSpeakerIp = null;
      _activeSpeakerCallsign = null;
      _activeSpeakerIsMaster = false;
    }
    notifyListeners();

    await _sendFloorControlSignal('TX_STOP');
    await _sendDiscoveryAnnouncement();
  }

  /// Mengirim potongan suara PCM mentah dengan header 6-byte (Byte 0 = _currentChannel)
  Future<void> sendRawAudioChunk(Uint8List pcmChunk) async {
    if (_audioSocket == null || !_isTransmitting || pcmChunk.isEmpty) return;

    _txSequence = (_txSequence + 1) & 0xFFFF;

    // Header 6-Byte:
    // Byte 0: _currentChannel (1-99)
    // Byte 1: Flags (Bit 0 = Master, Bit 1 = TalkAll)
    // Byte 2-3: Sequence Number (Uint16 Big Endian)
    // Byte 4-5: Payload Length (Uint16 Big Endian)
    final header = ByteData(6);
    header.setUint8(0, _currentChannel);
    header.setUint8(1, (_isMaster ? 1 : 0) | (_talkAll ? 2 : 0));
    header.setUint16(2, _txSequence, Endian.big);
    header.setUint16(4, pcmChunk.length, Endian.big);

    final packet = Uint8List(6 + pcmChunk.length);
    packet.setRange(0, 6, header.buffer.asUint8List());
    packet.setRange(6, packet.length, pcmChunk);

    final parts = _localIp.split('.');
    final subnetGateway = parts.length == 4
        ? '${parts[0]}.${parts[1]}.${parts[2]}.1'
        : masterHotspotIp;

    final Set<String> targetIps = {
      ...targetedPeers.map((p) => p.ipAddress),
      if (!_isMaster) subnetGateway,
    }..remove(_localIp);

    for (final ip in targetIps) {
      try {
        await _audioSocket!.send(
          packet,
          Endpoint.unicast(
            InternetAddress(ip),
            port: const Port(audioPort),
          ),
        );
      } catch (_) {}
    }
  }

  /// Uji ulang latensi PING ke semua peer aktif
  Future<void> refreshPing() async {
    if (_discoverySocket == null) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final bytes = utf8.encode(jsonEncode({'type': 'PING', 'ts': now}));

    for (final peer in _peers.values) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(
            InternetAddress(peer.ipAddress),
            port: const Port(discoveryPort),
          ),
        );
      } catch (_) {}
    }
  }

  Future<void> _sendPong(String targetIp, int originalTs) async {
    if (_discoverySocket == null) return;
    final bytes = utf8.encode(jsonEncode({'type': 'PONG', 'ts': originalTs}));
    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(
          InternetAddress(targetIp),
          port: const Port(discoveryPort),
        ),
      );
    } catch (_) {}
  }

  void _pruneStalePeers() {
    final now = DateTime.now();
    final beforeCount = _peers.length;
    _peers.removeWhere((ip, peer) {
      final isStale = now.difference(peer.lastSeen).inSeconds > 5;
      if (isStale && _activeSpeakerIp == ip) {
        _activeSpeakerIp = null;
        _activeSpeakerCallsign = null;
        _activeSpeakerIsMaster = false;
      }
      return isStale;
    });
    if (_peers.length != beforeCount) {
      notifyListeners();
    }
  }

  /// Watchdog: Jika paket UDP `TX_STOP` hilang di udara selama > 3 detik tanpa ada paket audio baru,
  /// otomatis buka kembali kunci Floor Control agar channel tidak macet terkunci.
  void _checkFloorControlTimeout() {
    if (_activeSpeakerIp != null &&
        _activeSpeakerIp != _localIp &&
        _lastTxPacketTime != null) {
      if (DateTime.now().difference(_lastTxPacketTime!).inSeconds > 3) {
        final peer = _peers[_activeSpeakerIp!];
        if (peer != null) peer.isTransmitting = false;
        _activeSpeakerIp = null;
        _activeSpeakerCallsign = null;
        _activeSpeakerIsMaster = false;
        _lastTxPacketTime = null;
        notifyListeners();
      }
    }
  }

  /// Pindah channel dengan aman: TIDAK menutup/re-bind socket UDP!
  void setChannel(int newChannel) {
    final nextChannel = newChannel.clamp(1, 99);
    if (_currentChannel == nextChannel) return;
    if (_isTransmitting) {
      stopTransmitting();
    }
    _currentChannel = nextChannel;
    _activeSpeakerIp = null;
    _activeSpeakerCallsign = null;
    _activeSpeakerIsMaster = false;
    _sendDiscoveryAnnouncement();
    notifyListeners();
  }

  void setCallsign(String newName) {
    final cleaned = newName.trim().toUpperCase();
    if (cleaned.isEmpty) return;
    _myCallsign = cleaned;
    _sendDiscoveryAnnouncement();
    notifyListeners();
  }

  void toggleTalkAll() {
    _talkAll = !_talkAll;
    if (_talkAll) {
      for (final p in _peers.values) {
        p.isTargeted = true;
      }
    }
    notifyListeners();
  }

  void togglePeerTarget(String ip) {
    final peer = _peers[ip];
    if (peer != null) {
      peer.isTargeted = !peer.isTargeted;
      _talkAll = _peers.values.every((p) => p.isTargeted);
      notifyListeners();
    }
  }

  String get inviteLink =>
      'diskomlekau://join?ip=$_localIp&ch=$_currentChannel&host=${Uri.encodeComponent(_myCallsign)}';

  Future<bool> joinViaInviteLink(String rawInput) async {
    final trimmed = rawInput.trim();
    if (trimmed.isEmpty) return false;

    String targetIp = masterHotspotIp;
    int targetCh = _currentChannel;
    String targetCallsign = 'MASTER';

    try {
      if (trimmed.contains('://') || trimmed.contains('?')) {
        final uri = Uri.parse(
          trimmed.startsWith('http') || trimmed.startsWith('diskomlekau://')
              ? trimmed
              : 'diskomlekau://join?$trimmed',
        );
        targetIp = uri.queryParameters['ip'] ??
            uri.queryParameters['master'] ??
            masterHotspotIp;
        targetCh = int.tryParse(uri.queryParameters['ch'] ?? '') ?? _currentChannel;
        targetCallsign =
            (uri.queryParameters['host'] ?? uri.queryParameters['hostCallsign'] ?? 'MASTER')
                .toUpperCase();
      } else {
        targetIp = trimmed;
      }

      _currentChannel = targetCh.clamp(1, 99);

      if (targetIp != _localIp && targetIp.isNotEmpty) {
        _peers[targetIp] = PeerMember(
          id: 'HOST-$targetIp',
          callsign: targetCallsign,
          ipAddress: targetIp,
          channel: _currentChannel,
          isTargeted: true,
          lastPingMs: 18,
          lastSeen: DateTime.now(),
        );
      }

      await _sendDiscoveryAnnouncement();
      notifyListeners();
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  void dispose() {
    _heartbeatTimer?.cancel();
    _pruneTimer?.cancel();
    _floorWatchdogTimer?.cancel();
    _discoverySocket?.close();
    _audioSocket?.close();
    super.dispose();
  }
}

/// ============================================================================
/// 4. AUDIO SERVICE - STRICT HALF-DUPLEX (ANTI-ECHO)
/// - Saat Transmitting (Tx): Volume AudioPlayer = 0.0 (Mute) & mulai Record Mic.
/// - Saat Receiving (Rx): Hentikan paksa Record Mic (Mic Off) & Volume AudioPlayer = 1.0 (Max).
/// - RecordConfig menggunakan echoCancel: true, noiseSuppress: true, autoGain: true.
/// ============================================================================
class AudioService {
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

  StreamSubscription<Uint8List>? _recordingSubscription;
  bool _isRecording = false;
  bool _isTxMuted = false;

  static const int sampleRate = 16000;
  static const int numChannels = 1;
  static const int bitsPerSample = 16;
  static const int udpChunkSize = 1280; // 40ms @ 16kHz 16-bit mono

  final BytesBuilder _playbackBuffer = BytesBuilder(copy: false);
  bool _isPlayingChunk = false;

  AudioService() {
    _player.setReleaseMode(ReleaseMode.stop);
    _player.setPlayerMode(PlayerMode.lowLatency);
    _player.setVolume(1.0);
  }

  /// MODE TRANSMIT (Tx) - STRICT HALF-DUPLEX:
  /// 1. Mute speaker (`_player.setVolume(0.0)`) & hentikan pemutaran agar suara speaker
  ///    tidak bocor masuk ke microphone (Anti-Echo).
  /// 2. Aktifkan perekaman microphone dengan `echoCancel`, `noiseSuppress`, dan `autoGain`.
  Future<void> startRecording(void Function(Uint8List chunk) onAudioChunk) async {
    if (_isRecording) return;

    // 1. Strict Half-Duplex: Mute AudioPlayer ke 0 & bersihkan buffer playback
    _isTxMuted = true;
    _playbackBuffer.clear();
    try {
      await _player.setVolume(0.0);
      await _player.stop();
    } catch (_) {}

    final hasPerm = await _recorder.hasPermission();
    if (!hasPerm) {
      debugPrint('Izin microphone ditolak.');
      return;
    }

    _isRecording = true;
    final List<int> accumulator = [];

    // 2. Jalankan stream rekaman dengan DSP Anti-Echo & Noise Suppression aktif
    final Stream<Uint8List> micStream = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: numChannels,
        echoCancel: true,
        noiseSuppress: true,
        autoGain: true,
      ),
    );

    _recordingSubscription = micStream.listen(
      (Uint8List rawBytes) {
        if (!_isRecording) return;
        accumulator.addAll(rawBytes);

        while (accumulator.length >= udpChunkSize) {
          final chunk = Uint8List.fromList(accumulator.sublist(0, udpChunkSize));
          accumulator.removeRange(0, udpChunkSize);
          onAudioChunk(chunk);
        }
      },
      onError: (Object err) {
        debugPrint('Error stream microphone: $err');
      },
    );
  }

  /// Hentikan perekaman microphone & kembalikan ke mode Receive (Speaker Volume = 1.0 Max)
  Future<void> stopRecording() async {
    _isRecording = false;
    await _recordingSubscription?.cancel();
    _recordingSubscription = null;

    try {
      if (await _recorder.isRecording()) {
        await _recorder.stop();
      }
    } catch (_) {}

    // Kembalikan volume AudioPlayer ke 1.0 (Max) agar siap menerima suara masuk
    _isTxMuted = false;
    try {
      await _player.setVolume(1.0);
    } catch (_) {}
  }

  /// MODE RECEIVE (Rx) - STRICT HALF-DUPLEX:
  /// Dipanggil otomatis saat menerima `TX_START` dari anggota lain atau saat terkena Master Override.
  /// Menghentikan paksa `record` (Mic Off) dan mengembalikan volume `audioplayers` ke 1.0 (Max).
  Future<void> enterReceiveMode() async {
    if (_isRecording) {
      await stopRecording();
    } else {
      _isTxMuted = false;
      try {
        await _player.setVolume(1.0);
      } catch (_) {}
    }
  }

  /// Memutar data PCM mentah dari paket UDP menggunakan in-memory WAV header
  /// Hanya memutar apabila tidak sedang dalam mode Transmitting (`!_isRecording && !_isTxMuted`).
  Future<void> playAudioChunk(Uint8List pcmBytes) async {
    if (pcmBytes.isEmpty || _isRecording || _isTxMuted) return;

    _playbackBuffer.add(pcmBytes);

    if (_playbackBuffer.length < udpChunkSize * 3 || _isPlayingChunk) {
      return;
    }

    _isPlayingChunk = true;
    try {
      await _player.setVolume(1.0);
      final rawPcm = _playbackBuffer.takeBytes();
      final wavBytes = _addWavHeader(rawPcm);
      await _player.play(BytesSource(wavBytes));
    } catch (e) {
      debugPrint('Gagal memutar paket audio UDP: $e');
    } finally {
      _isPlayingChunk = false;
    }
  }

  Uint8List _addWavHeader(Uint8List pcmData) {
    final int dataLength = pcmData.length;
    final int fileSize = dataLength + 36;
    final int byteRate = sampleRate * numChannels * (bitsPerSample ~/ 8);
    final int blockAlign = numChannels * (bitsPerSample ~/ 8);

    final header = ByteData(44);
    header.setUint8(0, 0x52); // 'R'
    header.setUint8(1, 0x49); // 'I'
    header.setUint8(2, 0x46); // 'F'
    header.setUint8(3, 0x46); // 'F'
    header.setUint32(4, fileSize, Endian.little);
    header.setUint8(8, 0x57); // 'W'
    header.setUint8(9, 0x41); // 'A'
    header.setUint8(10, 0x56); // 'V'
    header.setUint8(11, 0x45); // 'E'
    header.setUint8(12, 0x66); // 'f'
    header.setUint8(13, 0x6D); // 'm'
    header.setUint8(14, 0x74); // 't'
    header.setUint8(15, 0x20); // ' '
    header.setUint32(16, 16, Endian.little);
    header.setUint16(20, 1, Endian.little); // PCM = 1
    header.setUint16(22, numChannels, Endian.little);
    header.setUint32(24, sampleRate, Endian.little);
    header.setUint32(28, byteRate, Endian.little);
    header.setUint16(32, blockAlign, Endian.little);
    header.setUint16(34, bitsPerSample, Endian.little);
    header.setUint8(36, 0x64); // 'd'
    header.setUint8(37, 0x61); // 'a'
    header.setUint8(38, 0x74); // 't'
    header.setUint8(39, 0x61); // 'a'
    header.setUint32(40, dataLength, Endian.little);

    final wavBuffer = Uint8List(44 + dataLength);
    wavBuffer.setRange(0, 44, header.buffer.asUint8List());
    wavBuffer.setRange(44, 44 + dataLength, pcmData);
    return wavBuffer;
  }

  Future<void> dispose() async {
    await stopRecording();
    await _recorder.dispose();
    await _player.dispose();
  }
}

/// ============================================================================
/// 5. MATERIAL APP & LAYAR SETUP AWAL (SetupScreen)
/// ============================================================================
class DiskomlekauTacticalPttApp extends StatelessWidget {
  const DiskomlekauTacticalPttApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'TACTICAL NET-COMM SUBDISRUDAL',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF041D34),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF23DCFF),
          secondary: Color(0xFF09B6DF),
        ),
      ),
      // Halaman pertama wajib melalui SetupScreen (Input Callsign)
      home: const SetupScreen(),
    );
  }
}

class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key});

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final TextEditingController _callsignController = TextEditingController();
  bool _isConnecting = false;
  String? _errorText;

  static const Color bgDarkNavy = Color(0xFF041D34);
  static const Color cyanBright = Color(0xFF23DCFF);
  static const Color cyanSoft = Color(0xFF7CE8FF);

  Future<void> _handleConnect() async {
    final callsign = _callsignController.text.trim().toUpperCase();
    if (callsign.isEmpty) {
      setState(() => _errorText = 'CALLSIGN / NAMA WAJIB DIISI!');
      return;
    }

    setState(() {
      _errorText = null;
      _isConnecting = true;
    });

    final net = context.read<UdpNetworkService>();
    await net.connectWithCallsign(callsign);

    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(
        builder: (_) => const TacticalPttHomePage(),
      ),
    );
  }

  @override
  void dispose() {
    _callsignController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: bgDarkNavy,
      body: CustomPaint(
        painter: _TacticalGridPainter(),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
              child: Container(
                padding: const EdgeInsets.all(24),
                decoration: BoxDecoration(
                  gradient: const LinearGradient(
                    colors: [Color(0xFF072D4F), Color(0xFF041C33)],
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                  ),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: cyanBright.withValues(alpha: 0.65), width: 1.5),
                  boxShadow: [
                    BoxShadow(color: cyanBright.withValues(alpha: 0.2), blurRadius: 24),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 76,
                      height: 76,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: const Color(0xFF03192E),
                        border: Border.all(color: cyanBright, width: 2),
                        boxShadow: [
                          BoxShadow(color: cyanBright.withValues(alpha: 0.35), blurRadius: 16),
                        ],
                      ),
                      child: const Icon(Icons.sensors, size: 40, color: cyanBright),
                    ),
                    const SizedBox(height: 18),
                    const Text(
                      'TACTICAL NET-COMM SUBDISRUDAL',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 22,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 1.4,
                        shadows: [Shadow(color: cyanBright, blurRadius: 12)],
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'REGISTRASI IDENTITAS JARINGAN HOTSPOT LAN',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: cyanSoft,
                        fontSize: 11.5,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.8,
                      ),
                    ),
                    const SizedBox(height: 24),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        'MASUKKAN NAMA / CALLSIGN ANDA:',
                        style: TextStyle(
                          color: Colors.white.withValues(alpha: 0.9),
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 0.6,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _callsignController,
                      autofocus: true,
                      textCapitalization: TextCapitalization.characters,
                      maxLength: 12,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 1.5,
                      ),
                      decoration: InputDecoration(
                        counterText: '',
                        hintText: 'CONTOH: YUDHI / GARUDA-1',
                        hintStyle: TextStyle(
                          color: Colors.white.withValues(alpha: 0.35),
                          fontSize: 14,
                        ),
                        errorText: _errorText,
                        filled: true,
                        fillColor: const Color(0xFF021526),
                        prefixIcon: const Icon(Icons.person_outline, color: cyanBright),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: BorderSide(color: cyanBright.withValues(alpha: 0.5), width: 1.4),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: cyanBright, width: 2),
                        ),
                        errorBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: Colors.redAccent, width: 1.5),
                        ),
                        focusedErrorBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(12),
                          borderSide: const BorderSide(color: Colors.redAccent, width: 2),
                        ),
                      ),
                      onSubmitted: (_) => _handleConnect(),
                    ),
                    const SizedBox(height: 20),
                    SizedBox(
                      width: double.infinity,
                      height: 52,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: cyanBright,
                          foregroundColor: const Color(0xFF02182B),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(14),
                          ),
                          elevation: 8,
                        ),
                        onPressed: _isConnecting ? null : _handleConnect,
                        child: _isConnecting
                            ? const SizedBox(
                                width: 22,
                                height: 22,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2.5,
                                  color: Color(0xFF02182B),
                                ),
                              )
                            : const Row(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Icon(Icons.wifi_tethering, size: 20),
                                  SizedBox(width: 8),
                                  Text(
                                    'KONEK JARINGAN',
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w900,
                                      letterSpacing: 1.2,
                                    ),
                                  ),
                                ],
                              ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// ============================================================================
/// 6. HALAMAN UTAMA DASHBOARD PTT (TacticalPttHomePage)
/// ============================================================================
class TacticalPttHomePage extends StatefulWidget {
  const TacticalPttHomePage({super.key});

  @override
  State<TacticalPttHomePage> createState() => _TacticalPttHomePageState();
}

class _TacticalPttHomePageState extends State<TacticalPttHomePage> {
  int _selectedNavIndex = 0;
  final FocusNode _twsMediaFocusNode = FocusNode();
  DateTime? _lastTwsToggleTime;
  bool _twsAutoDetected = false;
  bool _twsHandsFreeEnabled = true;
  String _lastTwsKeySignal = 'SENTUH 1x = BUKA MIC • 2x = PUTUS MIC';

  static const Color bgDarkNavy = Color(0xFF041D34);
  static const Color cyanBright = Color(0xFF23DCFF);
  static const Color cyanSoft = Color(0xFF7CE8FF);

  static final Set<LogicalKeyboardKey> _twsLogicalKeys = <LogicalKeyboardKey>{
    LogicalKeyboardKey.mediaPlayPause,
    LogicalKeyboardKey.mediaPlay,
    LogicalKeyboardKey.mediaPause,
    LogicalKeyboardKey.mediaStop,
    LogicalKeyboardKey.mediaTrackNext,
    LogicalKeyboardKey.mediaTrackPrevious,
    LogicalKeyboardKey.mediaFastForward,
    LogicalKeyboardKey.mediaRewind,
    LogicalKeyboardKey.headsetHook,
    LogicalKeyboardKey.call,
    LogicalKeyboardKey.endCall,
  };

  @override
  void dispose() {
    _twsMediaFocusNode.dispose();
    super.dispose();
  }

  /// Fungsi utama memulai transmisi suara (dipanggil oleh Tombol PTT Utama & Sentuhan ke-1 TWS)
  Future<void> onStartTransmit(
    BuildContext context,
    UdpNetworkService net,
    AudioService audioService,
  ) async {
    if (net.isTransmitting) return;
    final String speakerName = net.activeSpeakerCallsign ?? 'ANGGOTA';

    if (net.isPttLocked) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          backgroundColor: Colors.redAccent.shade700,
          duration: const Duration(milliseconds: 1200),
          content: Text(
            'JALUR SIBUK: Sedang menerima suara dari $speakerName!',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
          ),
        ),
      );
      return;
    }

    final allowed = await net.startTransmitting();
    if (!allowed) return;

    await audioService.startRecording((Uint8List pcmChunk) {
      net.sendRawAudioChunk(pcmChunk);
    });
  }

  /// Fungsi utama menghentikan transmisi suara (dipanggil saat Lepas Tombol PTT & Sentuhan ke-2 TWS)
  Future<void> onStopTransmit(
    UdpNetworkService net,
    AudioService audioService,
  ) async {
    if (!net.isTransmitting) return;
    await audioService.stopRecording();
    await net.stopTransmitting();
  }

  /// Deteksi Otomatis TWS & Mode Toggle:
  /// - Sentuh 1x membuka Mic untuk bicara (`onStartTransmit`)
  /// - Sentuh ke-2 memutus Mic (`onStopTransmit`)
  KeyEventResult _handleTwsKeyEvent(
    KeyEvent event,
    BuildContext context,
    UdpNetworkService net,
    AudioService audioService,
  ) {
    if (!_twsHandsFreeEnabled) return KeyEventResult.ignored;

    final bool isMediaKey = _twsLogicalKeys.contains(event.logicalKey) ||
        const <int>{79, 85, 86, 87, 88, 89, 90, 126, 127}.contains(
          event.logicalKey.keyId & 0xFF,
        );
    if (!isMediaKey) return KeyEventResult.ignored;

    final String keyLabel = event.logicalKey.keyLabel.isNotEmpty
        ? event.logicalKey.keyLabel
        : 'TWS-KEY';

    if (event is KeyDownEvent) {
      final now = DateTime.now();
      if (_lastTwsToggleTime != null &&
          now.difference(_lastTwsToggleTime!).inMilliseconds < 360) {
        return KeyEventResult.handled;
      }
      _lastTwsToggleTime = now;

      if (!_twsAutoDetected) {
        _twsAutoDetected = true;
      }

      if (!net.isTransmitting) {
        setState(() => _lastTwsKeySignal = 'SENTUH 1x [$keyLabel] -> MIC TERBUKA');
        onStartTransmit(context, net, audioService);
      } else {
        setState(() => _lastTwsKeySignal = 'SENTUH KE-2 [$keyLabel] -> MIC DIPUTUS');
        onStopTransmit(net, audioService);
      }
      return KeyEventResult.handled;
    }

    if (event is KeyRepeatEvent || event is KeyUpEvent) {
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  void _showEditCallsignDialog(BuildContext context, UdpNetworkService net) {
    final controller = TextEditingController(text: net.myCallsign);
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF05233E),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: cyanBright, width: 1.5),
        ),
        title: const Text(
          'EDIT CALLSIGN SAYA',
          style: TextStyle(color: cyanBright, fontWeight: FontWeight.bold, fontSize: 15),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
          decoration: InputDecoration(
            hintText: 'Masukkan Callsign Baru',
            hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.4)),
            enabledBorder: OutlineInputBorder(
              borderSide: BorderSide(color: cyanBright.withValues(alpha: 0.5)),
            ),
            focusedBorder: const OutlineInputBorder(
              borderSide: BorderSide(color: cyanBright, width: 2),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('BATAL', style: TextStyle(color: Colors.white70)),
          ),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: cyanBright),
            onPressed: () {
              final value = controller.text.trim().toUpperCase();
              if (value.isNotEmpty) {
                net.setCallsign(value);
              }
              Navigator.pop(ctx);
            },
            child: const Text(
              'SIMPAN',
              style: TextStyle(color: Color(0xFF021627), fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }

  void _showBarcodeModal(BuildContext context, UdpNetworkService net) {
    final inviteController = TextEditingController();
    final link = net.inviteLink;

    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF05233E),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: cyanBright, width: 1.5),
        ),
        title: const Text(
          'BARCODE & LINK INVITE JARINGAN',
          textAlign: TextAlign.center,
          style: TextStyle(color: cyanBright, fontWeight: FontWeight.bold, fontSize: 15),
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: cyanBright, width: 2),
                ),
                child: const Icon(Icons.qr_code_2, size: 150, color: Color(0xFF03192E)),
              ),
              const SizedBox(height: 10),
              Text(
                'ID: ${net.myCallsign} (${net.roleLabel})',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 4),
              Text(
                'IP: ${net.localIp} • CHANNEL ${net.currentChannel.toString().padLeft(2, '0')}',
                style: const TextStyle(color: cyanSoft, fontSize: 12),
              ),
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFF021526),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: cyanBright.withValues(alpha: 0.45)),
                ),
                child: SelectableText(
                  link,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: cyanSoft, fontSize: 11, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: cyanBright,
                    foregroundColor: const Color(0xFF021627),
                  ),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: link));
                    if (ctx.mounted) {
                      ScaffoldMessenger.of(ctx).showSnackBar(
                        const SnackBar(
                          content: Text('Link Invite berhasil disalin ke Clipboard!'),
                          duration: Duration(seconds: 2),
                        ),
                      );
                    }
                  },
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text(
                    'SALIN LINK INVITE',
                    style: TextStyle(fontWeight: FontWeight.w900, fontSize: 12),
                  ),
                ),
              ),
              const SizedBox(height: 14),
              Divider(color: cyanBright.withValues(alpha: 0.3)),
              const SizedBox(height: 8),
              const Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'TEMPEL LINK INVITE / IP MASTER:',
                  style: TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.bold),
                ),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: inviteController,
                style: const TextStyle(color: Colors.white, fontSize: 12),
                decoration: InputDecoration(
                  hintText: 'diskomlekau://join?ip=192.168.43.1&ch=12...',
                  hintStyle: TextStyle(color: Colors.white.withValues(alpha: 0.35), fontSize: 11),
                  filled: true,
                  fillColor: const Color(0xFF021526),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: BorderSide(color: cyanBright.withValues(alpha: 0.5)),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10),
                    borderSide: const BorderSide(color: cyanBright, width: 1.5),
                  ),
                ),
              ),
              const SizedBox(height: 8),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(
                    side: const BorderSide(color: cyanBright, width: 1.4),
                    foregroundColor: cyanBright,
                  ),
                  onPressed: () async {
                    final ok = await net.joinViaInviteLink(inviteController.text);
                    if (ctx.mounted && ok) {
                      Navigator.pop(ctx);
                      ScaffoldMessenger.of(context).showSnackBar(
                        SnackBar(
                          content: Text(
                            'Terhubung ke Link Invite pada CHANNEL ${net.currentChannel.toString().padLeft(2, '0')}!',
                          ),
                        ),
                      );
                    }
                  },
                  icon: const Icon(Icons.link, size: 16),
                  label: const Text(
                    'GABUNG VIA LINK INVITE',
                    style: TextStyle(fontWeight: FontWeight.w900, fontSize: 12),
                  ),
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('TUTUP', style: TextStyle(color: cyanBright, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<UdpNetworkService>(
      builder: (context, net, _) {
        final audioService = context.read<AudioService>();
        final List<PeerMember> realPeers = net.activeChannelPeers;
        final int activeCount = realPeers.length;

        return Focus(
          focusNode: _twsMediaFocusNode,
          autofocus: true,
          onKeyEvent: (node, event) =>
              _handleTwsKeyEvent(event, context, net, audioService),
          child: Scaffold(
            backgroundColor: bgDarkNavy,
            body: CustomPaint(
              painter: _TacticalGridPainter(),
              child: SafeArea(
                child: Column(
                  children: [
                    Expanded(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                        child: Column(
                          children: [
                            // 1. TEKS JUDUL "TACTICAL NET-COMM SUBDISRUDAL"
                            const Padding(
                              padding: EdgeInsets.symmetric(vertical: 8),
                              child: Text(
                                'TACTICAL NET-COMM SUBDISRUDAL',
                                textAlign: TextAlign.center,
                                style: TextStyle(
                                  color: Color(0xFFE5FAFF),
                                  fontSize: 24,
                                  fontWeight: FontWeight.w900,
                                  letterSpacing: 1.5,
                                  shadows: [
                                    Shadow(color: cyanBright, blurRadius: 14),
                                  ],
                                ),
                              ),
                            ),

                            // 2. CONTAINER CARD STATUS JARINGAN
                            _buildNetworkStatusCard(net, activeCount),
                            const SizedBox(height: 12),

                            // 3. CONTAINER CHANNEL SELECTOR
                            _buildChannelCard(context, net, activeCount),
                            const SizedBox(height: 14),

                            // 4. GRIDVIEW ANGGOTA (REAL PEERS + INDIKATOR TX/RX)
                            _buildMemberGridSection(context, net, realPeers),
                            const SizedBox(height: 18),

                            // 5. TOMBOL PTT RAKSASA (TERHUBUNG KE onStartTransmit / onStopTransmit & TWS)
                            _buildGiantPttButton(context, net, audioService),
                            const SizedBox(height: 16),

                            // Banner Status Bawah (Menampilkan RECEIVING FROM [NAMA] / TRANSMITTING / READY)
                            _buildBottomStatusBanner(net),
                          ],
                        ),
                      ),
                    ),

                    // 6. BOTTOM NAVIGATION BAR (4 IKON)
                    _buildBottomNavigationBar(context, net),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  /// 2. Card Status Jaringan
  Widget _buildNetworkStatusCard(UdpNetworkService net, int activeCount) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tacticalCardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFF03192D),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: cyanBright.withValues(alpha: 0.45)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    _buildSignalBar(8, true),
                    const SizedBox(width: 3),
                    _buildSignalBar(12, true),
                    const SizedBox(width: 3),
                    _buildSignalBar(16, true),
                    const SizedBox(width: 3),
                    _buildSignalBar(20, !net.isHighLatency),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'PING:',
                    style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12),
                  ),
                  Text(
                    '${net.lastPingMs} ms',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 15),
                  ),
                ],
              ),
              const SizedBox(width: 6),
              Text(
                '(+${net.pingDeltaMs}ms)',
                style: const TextStyle(color: cyanSoft, fontSize: 11.5),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.5)),
                  ),
                  child: Text(
                    net.isHighLatency ? 'LATENCY\nTINGGI' : 'LATENCY\nRENDAH',
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.bold,
                      fontSize: 10.5,
                      height: 1.15,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              InkWell(
                onTap: net.refreshPing,
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  decoration: BoxDecoration(
                    color: const Color(0xFF04223C),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.65)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.sync, size: 14, color: cyanBright),
                      SizedBox(width: 4),
                      Text(
                        'Ping',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(
                  color: cyanBright,
                  borderRadius: BorderRadius.circular(8),
                  boxShadow: [BoxShadow(color: cyanBright.withValues(alpha: 0.5), blurRadius: 10)],
                ),
                child: Row(
                  children: [
                    Icon(
                      net.isMaster ? Icons.star : Icons.devices,
                      size: 14,
                      color: const Color(0xFF022038),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      net.isMaster ? 'MASTER' : 'CLIENT',
                      style: const TextStyle(
                        color: Color(0xFF022038),
                        fontWeight: FontWeight.w900,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Divider(color: cyanBright.withValues(alpha: 0.3), height: 1),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: Text(
                  'PERAN: ${net.roleLabel}\n(${net.localIp})',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600, height: 1.35),
                ),
              ),
              Expanded(
                child: Text(
                  'Peer Aktif: $activeCount • Target: ${net.targetedPeers.length} activeClients\n(Half-Duplex • Floor Control)',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600, height: 1.35),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 3. Container Channel Selector
  Widget _buildChannelCard(BuildContext context, UdpNetworkService net, int activeCount) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tacticalCardDecoration(),
      child: Column(
        children: [
          const Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Icon(Icons.arrow_drop_down, color: cyanSoft, size: 18),
              Text(
                'CHANNEL SELECTOR - CLOUD & HOTSPOT SYNC',
                style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                  fontSize: 12,
                  letterSpacing: 0.6,
                ),
              ),
              Icon(Icons.arrow_drop_down, color: cyanSoft, size: 18),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              InkWell(
                onTap: () => net.setChannel(net.currentChannel - 1),
                borderRadius: BorderRadius.circular(30),
                child: Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      colors: [Color(0xFF0D4C73), Color(0xFF042038)],
                    ),
                    border: Border.all(color: cyanBright, width: 2),
                    boxShadow: [BoxShadow(color: cyanBright.withValues(alpha: 0.25), blurRadius: 8)],
                  ),
                  child: const Icon(Icons.chevron_left, color: Colors.white, size: 28),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF021629),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.45)),
                  ),
                  child: Column(
                    children: [
                      Text(
                        'CHANNEL ${net.currentChannel.toString().padLeft(2, '0')}',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 28,
                          fontWeight: FontWeight.w900,
                          letterSpacing: 2.0,
                        ),
                      ),
                      const SizedBox(height: 4),
                      const Text(
                        'MASTER HOST - 192.168.43.1',
                        style: TextStyle(
                          color: cyanSoft,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 12),
              InkWell(
                onTap: () => net.setChannel(net.currentChannel + 1),
                borderRadius: BorderRadius.circular(30),
                child: Container(
                  width: 52,
                  height: 52,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      colors: [Color(0xFF0D4C73), Color(0xFF042038)],
                    ),
                    border: Border.all(color: cyanBright, width: 2),
                    boxShadow: [BoxShadow(color: cyanBright.withValues(alpha: 0.25), blurRadius: 8)],
                  ),
                  child: const Icon(Icons.chevron_right, color: Colors.white, size: 28),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '${net.roleLabel} AKTIF | $activeCount MEMBERS ONLINE',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                  fontSize: 12,
                ),
              ),
              InkWell(
                onTap: () => _showBarcodeModal(context, net),
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  decoration: BoxDecoration(
                    color: const Color(0xFF04223C),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.65)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.qr_code_2, size: 16, color: cyanBright),
                      SizedBox(width: 5),
                      Text(
                        'BARCODE',
                        style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 4. GridView Anggota (Real Peers Only + Highlight Speaker yang sedang Transmit)
  Widget _buildMemberGridSection(
    BuildContext context,
    UdpNetworkService net,
    List<PeerMember> realPeers,
  ) {
    return Column(
      children: [
        Row(
          children: [
            InkWell(
              onTap: net.toggleTalkAll,
              borderRadius: BorderRadius.circular(24),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
                decoration: BoxDecoration(
                  color: net.talkAll ? cyanBright : const Color(0xFF062E4F),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: cyanBright, width: 1.5),
                  boxShadow: [
                    if (net.talkAll)
                      BoxShadow(color: cyanBright.withValues(alpha: 0.55), blurRadius: 14),
                  ],
                ),
                child: Row(
                  children: [
                    Icon(
                      Icons.sensors,
                      size: 18,
                      color: net.talkAll ? const Color(0xFF021C33) : cyanBright,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'TALK ALL',
                      style: TextStyle(
                        color: net.talkAll ? const Color(0xFF021C33) : Colors.white,
                        fontWeight: FontWeight.w900,
                        fontSize: 13.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: _tacticalCardDecoration(),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Flexible(
                      child: Text(
                        'ID SAYA: ${net.myCallsign}',
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                          fontSize: 13,
                        ),
                      ),
                    ),
                    InkWell(
                      onTap: () => _showEditCallsignDialog(context, net),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: cyanBright.withValues(alpha: 0.6)),
                        ),
                        child: const Row(
                          children: [
                            Icon(Icons.edit, size: 13, color: cyanBright),
                            SizedBox(width: 4),
                            Text('Edit Nama', style: TextStyle(color: Colors.white, fontSize: 11.5)),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (realPeers.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 16),
            decoration: _tacticalCardDecoration(),
            child: Column(
              children: [
                const SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(
                    strokeWidth: 2.2,
                    color: cyanBright,
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'MENCARI ANGGOTA AKTIF...',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w900,
                    fontSize: 14,
                    letterSpacing: 1.1,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  'Menunggu perangkat lain terhubung ke WiFi Hotspot pada CHANNEL ${net.currentChannel.toString().padLeft(2, '0')} (UDP Port 50000)',
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: cyanSoft,
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          )
        else
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: realPeers.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 3,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 2.15,
            ),
            itemBuilder: (context, index) {
              final peer = realPeers[index];
              final isPeerSpeaking = net.activeSpeakerIp == peer.ipAddress || peer.isTransmitting;

              return InkWell(
                onTap: () => net.togglePeerTarget(peer.ipAddress),
                borderRadius: BorderRadius.circular(14),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      colors: isPeerSpeaking
                          ? [const Color(0xFF00C896), const Color(0xFF046E58)]
                          : peer.isTargeted
                              ? [const Color(0xFF1499C7), const Color(0xFF0A6691)]
                              : [const Color(0xFF062C4D), const Color(0xFF041D35)],
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                    ),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(
                      color: isPeerSpeaking
                          ? Colors.greenAccent
                          : (peer.isTargeted ? cyanBright : cyanBright.withValues(alpha: 0.35)),
                      width: isPeerSpeaking || peer.isTargeted ? 1.6 : 1,
                    ),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        isPeerSpeaking ? Icons.volume_up : Icons.mic_none,
                        size: 18,
                        color: isPeerSpeaking ? Colors.greenAccent : cyanBright,
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              peer.callsign,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w900,
                                fontSize: 13,
                              ),
                            ),
                            Text(
                              isPeerSpeaking ? 'TRANSMITTING' : peer.ipAddress,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: isPeerSpeaking ? Colors.greenAccent : cyanSoft,
                                fontSize: 9.5,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
      ],
    );
  }

  /// 5. Tombol PTT Raksasa:
  /// - Menerapkan Floor Control (`TX_START` / `TX_STOP`).
  /// - Jika `net.isPttLocked == true` (ada anggota lain bicara & perangkat ini CLIENT),
  ///   tombol PTT terkunci/disable dan menampilkan `"RECEIVING FROM [NAMA]"`.
  /// - Jika perangkat ini adalah `HP MASTER` (`192.168.43.1`), Master memiliki hak OVERRIDE
  ///   untuk tetap menekan tombol PTT dan mengambil alih jalur bicara.
  Widget _buildGiantPttButton(
    BuildContext context,
    UdpNetworkService net,
    AudioService audioService,
  ) {
    final bool isTx = net.isTransmitting;
    final bool isRx = net.isReceiving;
    final bool isLocked = net.isPttLocked;
    final String speakerName = net.activeSpeakerCallsign ?? 'ANGGOTA';

    String centerLabel;
    if (isTx) {
      centerLabel = 'KLIK TUTUP PTT\n(RX OFF • ANTI-ECHO)';
    } else if (isRx) {
      centerLabel = net.isMaster
          ? 'RX: $speakerName\n(KLIK OVERRIDE)'
          : 'RECEIVING FROM\n$speakerName';
    } else {
      centerLabel = net.isMaster ? 'MASTER READY\n(KLIK BUKA PTT)' : 'CLIENT READY\n(KLIK BUKA PTT)';
    }

    return GestureDetector(
      onTap: () {
        if (isTx) {
          onStopTransmit(net, audioService);
        } else {
          onStartTransmit(context, net, audioService);
        }
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 215,
        height: 215,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: isLocked
                ? [const Color(0xFF5A2D38), const Color(0xFF331520), const Color(0xFF1C0B12)]
                : isTx
                    ? [cyanBright, const Color(0xFF087CA6), const Color(0xFF042D4A)]
                    : isRx
                        ? [const Color(0xFFFFB300), const Color(0xFF9E5800), const Color(0xFF3B1F00)]
                        : [const Color(0xFF1476A6), const Color(0xFF073A5E), const Color(0xFF031F36)],
          ),
          border: Border.all(
            color: isLocked
                ? Colors.redAccent
                : (isRx && net.isMaster ? Colors.amberAccent : cyanBright),
            width: isTx ? 4 : 2.5,
          ),
          boxShadow: [
            BoxShadow(
              color: (isLocked
                      ? Colors.redAccent
                      : (isRx && net.isMaster ? Colors.amberAccent : cyanBright))
                  .withValues(alpha: isTx ? 0.75 : 0.35),
              blurRadius: isTx ? 42 : 24,
              spreadRadius: isTx ? 6 : 1,
            ),
          ],
        ),
        child: Stack(
          alignment: Alignment.center,
          children: [
            SizedBox(
              width: 190,
              height: 190,
              child: CustomPaint(
                painter: _CurvedTextPainter(
                  text: isLocked
                      ? 'CHANNEL LOCKED • RX ONLY'
                      : (isRx && net.isMaster
                          ? 'HOLD FOR MASTER OVERRIDE'
                          : 'PUSH TO TALK & HOLD'),
                ),
              ),
            ),
            Container(
              width: 142,
              height: 142,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  colors: isLocked
                      ? [const Color(0xFF6B2232), const Color(0xFF361019)]
                      : [const Color(0xFF1A8EC4), const Color(0xFF073B5E)],
                ),
                border: Border.all(
                  color: isLocked
                      ? Colors.redAccent.withValues(alpha: 0.7)
                      : cyanSoft.withValues(alpha: 0.65),
                  width: 1.5,
                ),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    isLocked
                        ? Icons.lock_outline
                        : (isRx ? Icons.volume_up : Icons.sensors),
                    size: 40,
                    color: isTx || isLocked || isRx ? Colors.white : const Color(0xFF03233B),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    centerLabel,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w900,
                      fontSize: 12,
                      letterSpacing: 0.6,
                      height: 1.2,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// Banner Status Bawah: Menampilkan status Floor Control secara real-time
  Widget _buildBottomStatusBanner(UdpNetworkService net) {
    final bool isTx = net.isTransmitting;
    final bool isRx = net.isReceiving;
    final bool isLocked = net.isPttLocked;
    final String speakerName = net.activeSpeakerCallsign ?? 'ANGGOTA';

    String bannerText;
    if (isTx) {
      bannerText =
          'TRANSMITTING VOICE (CH ${net.currentChannel.toString().padLeft(2, '0')}) • SPEAKER MUTED';
    } else if (isRx) {
      bannerText = isLocked
          ? 'RECEIVING FROM $speakerName (PTT LOCKED)'
          : 'RECEIVING FROM $speakerName (MASTER OVERRIDE READY)';
    } else {
      bannerText = net.isMaster ? 'MASTER READY' : 'CLIENT READY';
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 10),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: isLocked
              ? [const Color(0xFFD32F2F), const Color(0xFF880E4F)]
              : isRx
                  ? [const Color(0xFFFFB300), const Color(0xFFE65100)]
                  : [const Color(0xFF28E0FF), const Color(0xFF09B6DF)],
        ),
        borderRadius: BorderRadius.circular(14),
        boxShadow: [
          BoxShadow(
            color: (isLocked ? Colors.redAccent : cyanBright).withValues(alpha: 0.45),
            blurRadius: 16,
          ),
        ],
      ),
      child: Text(
        bannerText,
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 14.5,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.0,
        ),
      ),
    );
  }

  /// 6. Bottom Navigation Bar dengan 4 ikon: Channels, Edit Nama, Barcode, Settings.
  Widget _buildBottomNavigationBar(BuildContext context, UdpNetworkService net) {
    final items = [
      (Icons.sensors, '[Channels]'),
      (Icons.edit_outlined, '[Edit Nama]'),
      (Icons.qr_code_2, '[Barcode]'),
      (Icons.settings_outlined, '[Settings]'),
    ];
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF031729),
        border: Border(top: BorderSide(color: cyanBright.withValues(alpha: 0.35))),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: List.generate(items.length, (i) {
          final isSelected = _selectedNavIndex == i;
          return InkWell(
            onTap: () {
              setState(() => _selectedNavIndex = i);
              if (i == 1) _showEditCallsignDialog(context, net);
              if (i == 2) _showBarcodeModal(context, net);
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(items[i].$1, color: isSelected ? cyanBright : Colors.white, size: 22),
                const SizedBox(height: 4),
                Text(
                  items[i].$2,
                  style: TextStyle(
                    color: isSelected ? cyanBright : Colors.white,
                    fontWeight: FontWeight.w700,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          );
        }),
      ),
    );
  }

  Widget _buildSignalBar(double height, bool active) {
    return Container(
      width: 4,
      height: height,
      decoration: BoxDecoration(
        color: active ? cyanBright : Colors.white24,
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }

  BoxDecoration _tacticalCardDecoration() {
    return BoxDecoration(
      gradient: const LinearGradient(
        colors: [Color(0xFF072D4F), Color(0xFF041C33)],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: cyanBright.withValues(alpha: 0.55), width: 1.4),
      boxShadow: [
        BoxShadow(color: cyanBright.withValues(alpha: 0.14), blurRadius: 14),
      ],
    );
  }
}

/// CustomPainter untuk teks melingkar "PUSH TO TALK & HOLD"
class _CurvedTextPainter extends CustomPainter {
  final String text;
  const _CurvedTextPainter({required this.text});

  @override
  void paint(Canvas canvas, Size size) {
    final radius = size.width / 2 - 14;
    final center = Offset(size.width / 2, size.height / 2);
    const totalArc = math.pi * 0.68;
    const startAngle = -math.pi / 2 - totalArc / 2;
    final charStep = totalArc / (text.length - 1);

    for (int i = 0; i < text.length; i++) {
      final angle = startAngle + i * charStep;
      final charOffset = Offset(
        center.dx + radius * math.cos(angle),
        center.dy + radius * math.sin(angle),
      );

      canvas.save();
      canvas.translate(charOffset.dx, charOffset.dy);
      canvas.rotate(angle + math.pi / 2);

      final tp = TextPainter(
        text: TextSpan(
          text: text[i],
          style: const TextStyle(
            color: Color(0xFF03233B),
            fontSize: 11.0,
            fontWeight: FontWeight.w900,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();

      tp.paint(canvas, Offset(-tp.width / 2, -tp.height / 2));
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _CurvedTextPainter oldDelegate) =>
      oldDelegate.text != text;
}

/// CustomPainter untuk motif grid transparan pada background navy blue
class _TacticalGridPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFF23DCFF).withValues(alpha: 0.06)
      ..strokeWidth = 1;

    const step = 28.0;
    for (double x = 0; x < size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (double y = 0; y < size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
