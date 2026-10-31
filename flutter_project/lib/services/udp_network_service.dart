import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:udp/udp.dart';
import '../models/peer_member.dart';

/// ============================================================================
/// UDP NETWORK SERVICE - DISKOMLEKAU TACTICAL PTT
/// ============================================================================
/// Menangani 2 jalur komunikasi murni via Local Area Network (WiFi Hotspot)
/// TANPA koneksi internet:
/// 1. Port 50000 (Discovery & Control):
///    - Mengirim heartbeat JSON via UDP Broadcast (255.255.255.255 & x.x.x.255)
///      setiap 1.5 detik agar HP Master (192.168.43.1) dan hingga 10 HP Client
///      otomatis saling mendeteksi IP tanpa input manual.
///    - Menangani paket PING / PONG untuk mengukur latensi real-time (ms).
/// 2. Port 50001 (Real-Time Audio Stream):
///    - Mengirim & menerima paket raw PCM 16-bit audio dengan header 6-byte
///      [Channel(1B), Flags(1B), SeqNum(2B), PayloadLen(2B)] + PCM bytes.
///    - Mendukung mode TALK ALL (Unicast ke seluruh peer aktif di channel yang
///      sama atau Broadcast) maupun Unicast selektif ke anggota tertentu.
/// ============================================================================
class UdpNetworkService extends ChangeNotifier {
  static const int discoveryPort = 50000;
  static const int audioPort = 50001;
  static const String masterDefaultIp = '192.168.43.1';

  UDP? _discoverySocket;
  UDP? _audioSocket;
  Timer? _heartbeatTimer;
  Timer? _pruneTimer;

  String _localIp = masterDefaultIp;
  String _myCallsign = 'YUDHI';
  final String _deviceId = 'NODE-${DateTime.now().millisecondsSinceEpoch % 10000}';
  int _currentChannel = 12;
  bool _isMaster = true;
  bool _talkAll = true;
  bool _isTransmitting = false;
  int _lastPingMs = 24;
  int _pingDeltaMs = 4;
  int _txSequence = 0;

  /// Daftar peer online yang terdeteksi otomatis via UDP Broadcast (key: IP)
  final Map<String, PeerMember> _peers = {};

  /// Callback saat paket suara PCM diterima dari jaringan
  void Function(Uint8List pcmBytes, String senderIp)? onAudioPacketReceived;

  String get localIp => _localIp;
  String get myCallsign => _myCallsign;
  int get currentChannel => _currentChannel;
  bool get isMaster => _isMaster;
  bool get talkAll => _talkAll;
  bool get isTransmitting => _isTransmitting;
  int get lastPingMs => _lastPingMs;
  int get pingDeltaMs => _pingDeltaMs;
  bool get isHighLatency => _lastPingMs > 150;

  /// Mengembalikan daftar anggota yang online pada channel aktif
  List<PeerMember> get activeChannelPeers => _peers.values
      .where((p) => p.channel == _currentChannel)
      .toList()
    ..sort((a, b) => a.callsign.compareTo(b.callsign));

  /// Target pengiriman suara saat ini (Unicast ke semua activeClients atau terpilih)
  List<PeerMember> get targetedPeers => activeChannelPeers
      .where((p) => _talkAll || p.isTargeted)
      .toList();

  /// Inisialisasi IP lokal & buka socket UDP Port 50000 dan 50001
  Future<void> initialize() async {
    await _detectLocalHotspotIp();
    await _bindDiscoverySocket();
    await _bindAudioSocket();

    // Broadcast pengumuman diri setiap 1.5 detik untuk Auto-Discovery
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(
      const Duration(milliseconds: 1500),
      (_) => _sendDiscoveryAnnouncement(),
    );

    // Bersihkan peer yang tidak merespons lebih dari 7 detik (offline/putus WiFi)
    _pruneTimer?.cancel();
    _pruneTimer = Timer.periodic(
      const Duration(seconds: 3),
      (_) => _pruneStalePeers(),
    );

    // Kirim paket discovery pertama kali seketika
    await _sendDiscoveryAnnouncement();
  }

  /// Deteksi apakah perangkat ini adalah HP Master (192.168.43.1) atau Client
  Future<void> _detectLocalHotspotIp() async {
    try {
      final info = NetworkInfo();
      String? wifiIp = await info.getWifiIP();

      // Fallback scanning NetworkInterface jika HP bertindak sebagai Host Hotspot
      // karena Android Hotspot sering berada di interface ap0 / wlan0 (192.168.43.1)
      if (wifiIp == null || wifiIp.isEmpty || wifiIp == '0.0.0.0') {
        final interfaces = await NetworkInterface.list(
          type: InternetAddressType.IPv4,
          includeLoopback: false,
        );
        for (final iface in interfaces) {
          for (final addr in iface.addresses) {
            if (addr.address.startsWith('192.168.')) {
              wifiIp = addr.address;
              break;
            }
          }
        }
      }

      _localIp = wifiIp ?? masterDefaultIp;
      // Di Android, HP yang menyalakan Mobile Hotspot default memiliki IP .1
      _isMaster = _localIp.endsWith('.1');
      notifyListeners();
    } catch (e) {
      debugPrint('Gagal mendeteksi IP WiFi Hotspot, menggunakan default: $e');
      _localIp = masterDefaultIp;
      _isMaster = true;
    }
  }

  /// --------------------------------------------------------------------------
  /// 1. SOCKET AUTO-DISCOVERY & PING (UDP PORT 50000)
  /// --------------------------------------------------------------------------
  Future<void> _bindDiscoverySocket() async {
    _discoverySocket?.close();
    _discoverySocket = await UDP.bind(Endpoint.any(port: const Port(discoveryPort)));

    _discoverySocket!.asStream().listen((Datagram? datagram) {
      if (datagram == null) return;
      final senderIp = datagram.address.address;

      // Abaikan paket pantulan dari IP sendiri
      if (senderIp == _localIp) return;

      try {
        final payload = utf8.decode(datagram.data);
        final Map<String, dynamic> data = jsonDecode(payload);
        final String type = data['type'] ?? '';

        if (type == 'ANNOUNCE') {
          final incoming = PeerMember.fromJson(data);
          final existing = _peers[senderIp];
          if (existing != null) {
            incoming.isTargeted = existing.isTargeted;
            incoming.lastPingMs = existing.lastPingMs;
          }
          _peers[senderIp] = incoming;
          notifyListeners();
        } else if (type == 'PING') {
          // Balas langsung dengan PONG Unicast ke pengirim
          _sendPong(senderIp, data['ts'] as int);
        } else if (type == 'PONG') {
          final sentTs = data['ts'] as int;
          final rtt = DateTime.now().millisecondsSinceEpoch - sentTs;
          _pingDeltaMs = rtt - _lastPingMs;
          _lastPingMs = rtt.clamp(1, 999);
          if (_peers.containsKey(senderIp)) {
            _peers[senderIp]!.lastPingMs = _lastPingMs;
          }
          notifyListeners();
        }
      } catch (e) {
        debugPrint('Paket UDP Discovery tidak valid dari $senderIp: $e');
      }
    });
  }

  /// Mengirim paket Broadcast UDP ke seluruh subnet Hotspot (mis. 192.168.43.255)
  Future<void> _sendDiscoveryAnnouncement() async {
    if (_discoverySocket == null) return;

    final packet = jsonEncode({
      'type': 'ANNOUNCE',
      'id': _deviceId,
      'callsign': _myCallsign,
      'ip': _localIp,
      'ch': _currentChannel,
      'master': _isMaster,
      'talking': _isTransmitting,
    });
    final bytes = utf8.encode(packet);

    // Hitung alamat subnet broadcast (contoh: 192.168.43.1 -> 192.168.43.255)
    final subnetParts = _localIp.split('.');
    final subnetBroadcast = subnetParts.length == 4
        ? '${subnetParts[0]}.${subnetParts[1]}.${subnetParts[2]}.255'
        : '192.168.43.255';

    try {
      // Kirim ke Subnet Broadcast Hotspot
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(
          InternetAddress(subnetBroadcast),
          port: const Port(discoveryPort),
        ),
      );
      // Kirim juga ke Global Broadcast (255.255.255.255)
      await _discoverySocket!.send(
        bytes,
        Endpoint.broadcast(port: const Port(discoveryPort)),
      );
    } catch (e) {
      debugPrint('Broadcast discovery gagal: $e');
    }
  }

  /// --------------------------------------------------------------------------
  /// 2. SOCKET TRANSMISI SUARA REAL-TIME (UDP PORT 50001)
  /// --------------------------------------------------------------------------
  Future<void> _bindAudioSocket() async {
    _audioSocket?.close();
    _audioSocket = await UDP.bind(Endpoint.any(port: const Port(audioPort)));

    _audioSocket!.asStream().listen((Datagram? datagram) {
      if (datagram == null || datagram.data.length <= 6) return;
      final senderIp = datagram.address.address;
      if (senderIp == _localIp) return;

      final bytes = datagram.data;
      final packetChannel = bytes[0];

      // Hanya putar paket suara jika berasal dari CHANNEL yang sama
      if (packetChannel != _currentChannel) return;

      // Ekstrak raw PCM audio (setelah 6-byte tactical header)
      final pcmPayload = Uint8List.sublistView(bytes, 6);
      onAudioPacketReceived?.call(pcmPayload, senderIp);
    });
  }

  /// Mengirim potongan buffer suara PCM 16-bit via UDP Unicast ke seluruh
  /// activeClients yang ditargetkan agar bebas collision dan latensi sangat rendah.
  Future<void> sendRawAudioChunk(Uint8List pcmChunk) async {
    if (_audioSocket == null || pcmChunk.isEmpty) return;

    _txSequence = (_txSequence + 1) & 0xFFFF;

    // Header 6-Byte:
    // Byte 0: Channel (1-99)
    // Byte 1: Flags (Bit 0 = Master, Bit 1 = TalkAll)
    // Byte 2-3: Sequence Number (Uint16 Big Endian)
    // Byte 4-5: Panjang PCM Payload
    final header = ByteData(6);
    header.setUint8(0, _currentChannel);
    header.setUint8(1, (_isMaster ? 1 : 0) | (_talkAll ? 2 : 0));
    header.setUint16(2, _txSequence, Endian.big);
    header.setUint16(4, pcmChunk.length, Endian.big);

    final packet = Uint8List(6 + pcmChunk.length);
    packet.setRange(0, 6, header.buffer.asUint8List());
    packet.setRange(6, packet.length, pcmChunk);

    final targets = targetedPeers;
    for (final peer in targets) {
      try {
        await _audioSocket!.send(
          packet,
          Endpoint.unicast(
            InternetAddress(peer.ipAddress),
            port: const Port(audioPort),
          ),
        );
      } catch (e) {
        debugPrint('Gagal mengirim paket audio ke ${peer.ipAddress}: $e');
      }
    }
  }

  /// Mengukur ulang latensi (Refresh Ping) ke seluruh peer aktif
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
    _peers.removeWhere((_, peer) => now.difference(peer.lastSeen).inSeconds > 7);
    notifyListeners();
  }

  void setChannel(int newChannel) {
    _currentChannel = newChannel.clamp(1, 99);
    _sendDiscoveryAnnouncement();
    notifyListeners();
  }

  void setCallsign(String newName) {
    if (newName.trim().isEmpty) return;
    _myCallsign = newName.trim().toUpperCase();
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

  void setTransmitting(bool value) {
    _isTransmitting = value;
    _sendDiscoveryAnnouncement();
    notifyListeners();
  }

  @override
  void dispose() {
    _heartbeatTimer?.cancel();
    _pruneTimer?.cancel();
    _discoverySocket?.close();
    _audioSocket?.close();
    super.dispose();
  }
}
