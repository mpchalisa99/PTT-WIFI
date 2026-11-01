export interface FlutterSourceFile {
  path: string;
  title: string;
  category: 'Core UI' | 'UDP Network' | 'Audio Engine' | 'Model & Config';
  description: string;
  code: string;
}

export const FLUTTER_SOURCE_FILES: FlutterSourceFile[] = [
  {
    path: 'lib/main.dart (ALL-IN-ONE)',
    title: 'main.dart (Gabungan Lengkap)',
    category: 'Core UI',
    description:
      'Seluruh arsitektur aplikasi (Model PeerMember, UdpNetworkService, AudioService, dan UI Taktikal) digabung utuh dalam SATU file main.dart.',
    code: `// Lihat atau unduh file gabungan utuh di /flutter_project/lib/main.dart atau salin langsung dari panel ini.
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

  udpNetworkService.onAudioPacketReceived = (Uint8List pcmBytes, String senderIp) {
    audioService.playAudioChunk(pcmBytes);
  };

  await udpNetworkService.initialize();

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider<UdpNetworkService>.value(value: udpNetworkService),
        Provider<AudioService>.value(value: audioService),
      ],
      child: const DiskomlekauTacticalPttApp(),
    ),
  );
}`,
  },
  {
    path: 'pubspec.yaml',
    title: 'pubspec.yaml',
    category: 'Model & Config',
    description:
      'Konfigurasi environment SDK >=3.0.0 <4.0.0 beserta dependencies flutter, provider, udp, network_info_plus, record, dan audioplayers.',
    code: `name: diskomlekau_tactical_ptt
description: Aplikasi Android Push-to-Talk (PTT) Walkie Talkie Taktikal via LAN/WiFi Hotspot tanpa internet.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  provider: ^6.1.2
  udp: ^5.0.3
  network_info_plus: ^6.0.1
  record: ^5.1.2
  audioplayers: ^6.1.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0

flutter:
  uses-material-design: true`,
  },
  {
    path: 'lib/models/peer_member.dart',
    title: 'peer_member.dart',
    category: 'Model & Config',
    description:
      'Class PeerMember dengan properti id, callsign, ipAddress, channel, isTargeted (default true), lastSeen, lastPingMs, serta factory PeerMember.fromJson.',
    code: `class PeerMember {
  final String id;
  String callsign;
  final String ipAddress;
  final int channel;
  bool isTargeted;
  DateTime lastSeen;
  int lastPingMs;

  PeerMember({
    required this.id,
    required this.callsign,
    required this.ipAddress,
    required this.channel,
    this.isTargeted = true,
    this.lastPingMs = 24,
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
      lastPingMs: (json['ping'] as num?)?.toInt() ?? 24,
      lastSeen: DateTime.now(),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'callsign': callsign,
        'ip': ipAddress,
        'ch': channel,
        'isTargeted': isTargeted,
        'ping': lastPingMs,
      };
}`,
  },
  {
    path: 'lib/services/audio_service.dart',
    title: 'audio_service.dart',
    category: 'Audio Engine',
    description:
      'Service perekam & pemutar suara Raw PCM 16-bit 16kHz Mono menggunakan package record dan audioplayers (BytesSource in-memory WAV header) tanpa internet.',
    code: `import 'dart:async';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

/// ============================================================================
/// AUDIO SERVICE - STREAMING SUARA RAW PCM 16-BIT 16KHZ MONO TANPA INTERNET
/// ============================================================================
class AudioService {
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

  StreamSubscription<Uint8List>? _recordingSubscription;
  bool _isRecording = false;

  static const int sampleRate = 16000;
  static const int numChannels = 1;
  static const int bitsPerSample = 16;

  /// 1280 bytes = 40ms audio @ 16kHz 16-bit mono (aman di bawah MTU WiFi 1472B)
  static const int udpChunkSize = 1280;

  final BytesBuilder _playbackBuffer = BytesBuilder(copy: false);
  bool _isPlayingChunk = false;

  AudioService() {
    _player.setReleaseMode(ReleaseMode.stop);
    _player.setPlayerMode(PlayerMode.lowLatency);
  }

  /// 1 & 2. Mulai menangkap suara microphone (PCM 16-bit Mono 16000Hz) dan
  /// mengalirkan byte audio secara terus-menerus ke callback [onAudioChunk].
  Future<void> startRecording(void Function(Uint8List chunk) onAudioChunk) async {
    if (_isRecording) return;

    final hasPerm = await _recorder.hasPermission();
    if (!hasPerm) {
      debugPrint('Izin microphone belum diberikan.');
      return;
    }

    _isRecording = true;
    final List<int> accumulator = [];

    final Stream<Uint8List> micStream = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: numChannels,
        autoGain: true,
        echoCancel: true,
        noiseSuppress: true,
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
        debugPrint('Error pada stream microphone: \$err');
      },
    );
  }

  /// 3. Menghentikan perekaman microphone.
  Future<void> stopRecording() async {
    _isRecording = false;
    await _recordingSubscription?.cancel();
    _recordingSubscription = null;

    if (await _recorder.isRecording()) {
      await _recorder.stop();
    }
  }

  /// 4. Memutar data PCM mentah yang diterima dari jaringan UDP di memori RAM.
  Future<void> playAudioChunk(Uint8List pcmBytes) async {
    if (pcmBytes.isEmpty || _isRecording) return;

    _playbackBuffer.add(pcmBytes);

    if (_playbackBuffer.length < udpChunkSize * 3 || _isPlayingChunk) {
      return;
    }

    _isPlayingChunk = true;
    try {
      final rawPcm = _playbackBuffer.takeBytes();
      final wavBytes = _addWavHeader(rawPcm);
      await _player.play(BytesSource(wavBytes));
    } catch (e) {
      debugPrint('Gagal memutar chunk audio UDP: \$e');
    } finally {
      _isPlayingChunk = false;
    }
  }

  /// Membungkus Raw PCM 16-bit 16kHz Mono dengan header WAV 44-byte di RAM
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
    header.setUint16(20, 1, Endian.little);
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
}`,
  },
  {
    path: 'lib/main.dart',
    title: 'main.dart',
    category: 'Core UI',
    description:
      'Entry point MultiProvider dan UI utama TACTICAL NET-COMM SUBDISRUDAL yang otomatis me-refresh saat ada perangkat baru terhubung ke Hotspot.',
    code: `import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'models/peer_member.dart';
import 'services/audio_service.dart';
import 'services/udp_network_service.dart';

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

  udpNetworkService.onAudioPacketReceived = (pcmBytes, senderIp) {
    audioService.playAudioChunk(pcmBytes);
  };

  await udpNetworkService.initialize();

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
      home: const TacticalPttHomePage(),
    );
  }
}

class TacticalPttHomePage extends StatefulWidget {
  const TacticalPttHomePage({super.key});

  @override
  State<TacticalPttHomePage> createState() => _TacticalPttHomePageState();
}

class _TacticalPttHomePageState extends State<TacticalPttHomePage> {
  int _selectedNavIndex = 0;

  static const Color bgDarkNavy = Color(0xFF041D34);
  static const Color cyanBright = Color(0xFF23DCFF);
  static const Color cyanSoft = Color(0xFF7CE8FF);

  final List<PeerMember> _fallbackMembers = [
    PeerMember(id: 'M1', callsign: 'YUDHI', ipAddress: '192.168.43.1', channel: 12),
    PeerMember(id: 'M2', callsign: 'EKO', ipAddress: '192.168.43.102', channel: 12),
    PeerMember(id: 'M3', callsign: 'PUJI', ipAddress: '192.168.43.103', channel: 12),
    PeerMember(id: 'M4', callsign: 'JEFRY', ipAddress: '192.168.43.104', channel: 12),
    PeerMember(id: 'M5', callsign: 'YUSUF', ipAddress: '192.168.43.105', channel: 12),
    PeerMember(id: 'M6', callsign: 'EDWIN', ipAddress: '192.168.43.106', channel: 12),
  ];

  @override
  Widget build(BuildContext context) {
    return Consumer<UdpNetworkService>(
      builder: (context, net, _) {
        final audioService = context.read<AudioService>();
        final List<PeerMember> peers = net.activeChannelPeers.isNotEmpty
            ? net.activeChannelPeers
            : _fallbackMembers;
        final int activeCount = peers.length;

        return Scaffold(
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
                          // 1. Teks judul "TACTICAL NET-COMM SUBDISRUDAL"
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
                                shadows: [Shadow(color: cyanBright, blurRadius: 14)],
                              ),
                            ),
                          ),

                          // 2. Container Card Status Jaringan
                          _buildNetworkStatusCard(net, activeCount),
                          const SizedBox(height: 12),

                          // 3. Container Channel Selector
                          _buildChannelCard(net, activeCount),
                          const SizedBox(height: 14),

                          // 4. GridView Anggota
                          _buildMemberGridSection(net, peers),
                          const SizedBox(height: 18),

                          // 5. Tombol PTT Raksasa (GestureDetector)
                          _buildGiantPttButton(net, audioService),
                          const SizedBox(height: 16),

                          _buildBottomStatusBanner(net),
                        ],
                      ),
                    ),
                  ),

                  // 6. Bottom Navigation Bar (4 Ikon)
                  _buildBottomNavigationBar(),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildNetworkStatusCard(UdpNetworkService net, int activeCount) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tacticalCardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'PING: \${net.lastPingMs} ms',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 15),
              ),
              Text(
                net.isHighLatency ? 'LATENCY TINGGI' : 'LATENCY RENDAH',
                style: const TextStyle(color: cyanSoft, fontWeight: FontWeight.bold, fontSize: 12),
              ),
              InkWell(
                onTap: net.refreshPing,
                child: const Icon(Icons.sync, size: 18, color: cyanBright),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: cyanBright,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  net.isMaster ? 'MASTER' : 'CLIENT',
                  style: const TextStyle(color: Color(0xFF022038), fontWeight: FontWeight.w900, fontSize: 12),
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
                  'PERAN: \${net.isMaster ? "HP MASTER" : "HP CLIENT"} (\${net.localIp})',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
                ),
              ),
              Text(
                'Peer Aktif: \$activeCount',
                style: const TextStyle(color: cyanSoft, fontSize: 12, fontWeight: FontWeight.bold),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildChannelCard(UdpNetworkService net, int activeCount) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tacticalCardDecoration(),
      child: Column(
        children: [
          const Text(
            'CHANNEL SELECTOR - CLOUD & HOTSPOT SYNC',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 12),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              IconButton(
                onPressed: () => net.setChannel(net.currentChannel - 1),
                icon: const Icon(Icons.chevron_left, color: cyanBright, size: 32),
              ),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  decoration: BoxDecoration(
                    color: const Color(0xFF021629),
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.45)),
                  ),
                  child: Column(
                    children: [
                      Text(
                        'CHANNEL \${net.currentChannel.toString().padLeft(2, "0")}',
                        style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w900),
                      ),
                      Text(
                        'MASTER HOST - \${net.localIp}',
                        style: const TextStyle(color: cyanSoft, fontSize: 11.5),
                      ),
                    ],
                  ),
                ),
              ),
              IconButton(
                onPressed: () => net.setChannel(net.currentChannel + 1),
                icon: const Icon(Icons.chevron_right, color: cyanBright, size: 32),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            'HP MASTER AKTIF | \$activeCount MEMBERS ONLINE',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12),
          ),
        ],
      ),
    );
  }

  Widget _buildMemberGridSection(UdpNetworkService net, List<PeerMember> peers) {
    return GridView.builder(
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      itemCount: peers.length,
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        childAspectRatio: 2.15,
      ),
      itemBuilder: (context, index) {
        final peer = peers[index];
        return InkWell(
          onTap: () => net.togglePeerTarget(peer.ipAddress),
          borderRadius: BorderRadius.circular(14),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: peer.isTargeted
                    ? [const Color(0xFF1499C7), const Color(0xFF0A6691)]
                    : [const Color(0xFF062C4D), const Color(0xFF041D35)],
              ),
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: cyanBright),
            ),
            child: Row(
              children: [
                const Icon(Icons.mic_none, size: 18, color: cyanBright),
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
                        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 13),
                      ),
                      const Text(
                        'ALL AKTIF',
                        style: TextStyle(color: cyanSoft, fontSize: 10),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildGiantPttButton(UdpNetworkService net, AudioService audioService) {
    final bool isTx = net.isTransmitting;
    return GestureDetector(
      onLongPress: () async {
        net.setTransmitting(true);
        await audioService.startRecording((pcmChunk) {
          net.sendRawAudioChunk(pcmChunk);
        });
      },
      onLongPressEnd: (_) async {
        await audioService.stopRecording();
        net.setTransmitting(false);
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        width: 210,
        height: 210,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: isTx
                ? [cyanBright, const Color(0xFF087CA6), const Color(0xFF042D4A)]
                : [const Color(0xFF1476A6), const Color(0xFF073A5E), const Color(0xFF031F36)],
          ),
          border: Border.all(color: cyanBright, width: isTx ? 4 : 2.5),
          boxShadow: [
            BoxShadow(
              color: cyanBright.withValues(alpha: isTx ? 0.75 : 0.35),
              blurRadius: isTx ? 42 : 24,
              spreadRadius: isTx ? 6 : 1,
            ),
          ],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text(
              'PUSH TO TALK & HOLD',
              style: TextStyle(color: Color(0xFF03233B), fontSize: 11, fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 12),
            Icon(Icons.sensors, size: 44, color: isTx ? Colors.white : const Color(0xFF03233B)),
            const SizedBox(height: 6),
            Text(
              isTx ? 'TRANSMITTING' : 'MASTER READY',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: 14),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBottomStatusBanner(UdpNetworkService net) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        gradient: const LinearGradient(colors: [Color(0xFF28E0FF), Color(0xFF09B6DF)]),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        net.isTransmitting ? 'TRANSMITTING RAW PCM UDP...' : 'MASTER READY',
        textAlign: TextAlign.center,
        style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w900),
      ),
    );
  }

  Widget _buildBottomNavigationBar() {
    final items = [
      (Icons.sensors, '[Channels]'),
      (Icons.edit_outlined, '[Edit Nama]'),
      (Icons.qr_code_2, '[Barcode]'),
      (Icons.settings_outlined, '[Settings]'),
    ];
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 10),
      color: const Color(0xFF031729),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: List.generate(items.length, (i) {
          final isSelected = _selectedNavIndex == i;
          return InkWell(
            onTap: () => setState(() => _selectedNavIndex = i),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(items[i].\$1, color: isSelected ? cyanBright : Colors.white, size: 22),
                const SizedBox(height: 4),
                Text(
                  items[i].\$2,
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

  BoxDecoration _tacticalCardDecoration() {
    return BoxDecoration(
      gradient: const LinearGradient(
        colors: [Color(0xFF072D4F), Color(0xFF041C33)],
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
      ),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: cyanBright.withValues(alpha: 0.55), width: 1.4),
    );
  }
}

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
}`,
  },
  {
    path: 'lib/services/udp_network_service.dart',
    title: 'udp_network_service.dart',
    category: 'UDP Network',
    description:
      'Service Auto-Discovery via UDP Broadcast (Port 50000) & pengiriman paket suara Unicast/Broadcast (Port 50001) di LAN Hotspot 192.168.43.1 tanpa internet.',
    code: `import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:network_info_plus/network_info_plus.dart';
import 'package:udp/udp.dart';
import '../models/peer_member.dart';

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
  final String _deviceId = 'NODE-\${DateTime.now().millisecondsSinceEpoch % 10000}';
  int _currentChannel = 12;
  bool _isMaster = true;
  bool _talkAll = true;
  bool _isTransmitting = false;
  int _lastPingMs = 24;
  int _pingDeltaMs = 4;
  int _txSequence = 0;

  final Map<String, PeerMember> _peers = {};

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

  List<PeerMember> get activeChannelPeers => _peers.values
      .where((p) => p.channel == _currentChannel)
      .toList()
    ..sort((a, b) => a.callsign.compareTo(b.callsign));

  List<PeerMember> get targetedPeers => activeChannelPeers
      .where((p) => _talkAll || p.isTargeted)
      .toList();

  Future<void> initialize() async {
    await _detectLocalHotspotIp();
    await _bindDiscoverySocket();
    await _bindAudioSocket();

    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(
      const Duration(milliseconds: 1500),
      (_) => _sendDiscoveryAnnouncement(),
    );

    _pruneTimer?.cancel();
    _pruneTimer = Timer.periodic(
      const Duration(seconds: 3),
      (_) => _pruneStalePeers(),
    );

    await _sendDiscoveryAnnouncement();
  }

  int _subnetSweepCursor = 2;

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
      for (final iface in interfaces) {
        final name = iface.name.toLowerCase();
        final isHotspotIface = name.contains('ap') ||
            name.contains('wlan') ||
            name.contains('swlan') ||
            name.contains('rndis');
        for (final addr in iface.addresses) {
          final ip = addr.address;
          if (ip == masterDefaultIp) {
            detectedIp = masterDefaultIp;
            break;
          }
          if (isHotspotIface && (ip.startsWith('192.168.') || ip.startsWith('172.'))) {
            detectedIp = ip;
          } else if ((detectedIp == null || detectedIp.isEmpty) && ip.startsWith('192.168.')) {
            detectedIp = ip;
          }
        }
        if (detectedIp == masterDefaultIp) break;
      }
      _localIp = detectedIp ?? masterDefaultIp;
      _isMaster = _localIp == masterDefaultIp || _localIp.endsWith('.1');
      notifyListeners();
    } catch (_) {
      _localIp = masterDefaultIp;
      _isMaster = true;
    }
  }

  Future<void> _bindDiscoverySocket() async {
    _discoverySocket?.close();
    _discoverySocket = await UDP.bind(Endpoint.any(port: const Port(discoveryPort)));

    _discoverySocket!.asStream().listen((Datagram? datagram) {
      if (datagram == null) return;
      final senderIp = datagram.address.address;
      if (senderIp == _localIp) return;

      try {
        final Map<String, dynamic> data = jsonDecode(utf8.decode(datagram.data));
        final String type = data['type'] ?? '';

        if (type == 'ANNOUNCE') {
          final String peerIp = (data['ip'] ?? senderIp).toString();
          if (peerIp == _localIp) return;
          data['ip'] = peerIp;
          final bool isNew = !_peers.containsKey(peerIp);
          final incoming = PeerMember.fromJson(data);
          final existing = _peers[peerIp];
          if (existing != null) {
            incoming.isTargeted = existing.isTargeted;
            incoming.lastPingMs = existing.lastPingMs;
          }
          _peers[peerIp] = incoming;
          if (isNew) _sendDirectUnicastAnnounce(peerIp);
          if (_isMaster) _broadcastPeerListSyncFromMaster();
          notifyListeners();
        } else if (type == 'PEER_LIST_SYNC') {
          final List<dynamic>? list = data['peers'] as List<dynamic>?;
          if (list != null) {
            for (final item in list) {
              if (item is Map<String, dynamic>) {
                final String pIp = (item['ip'] ?? '').toString();
                if (pIp.isEmpty || pIp == _localIp) continue;
                _peers[pIp] = PeerMember.fromJson(item);
              }
            }
            notifyListeners();
          }
        } else if (type == 'PING') {
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
      } catch (_) {}
    });
  }

  Future<void> _sendDirectUnicastAnnounce(String targetIp) async {
    if (_discoverySocket == null || targetIp == _localIp) return;
    final bytes = utf8.encode(jsonEncode({
      'type': 'ANNOUNCE',
      'id': _deviceId,
      'callsign': _myCallsign,
      'ip': _localIp,
      'ch': _currentChannel,
      'ping': _lastPingMs,
    }));
    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(InternetAddress(targetIp), port: const Port(discoveryPort)),
      );
    } catch (_) {}
  }

  Future<void> _broadcastPeerListSyncFromMaster() async {
    if (_discoverySocket == null || !_isMaster) return;
    final allNodes = [
      {
        'id': _deviceId,
        'callsign': _myCallsign,
        'ip': _localIp,
        'ch': _currentChannel,
        'ping': _lastPingMs,
      },
      ..._peers.values.map((p) => p.toJson()),
    ];
    final bytes = utf8.encode(jsonEncode({
      'type': 'PEER_LIST_SYNC',
      'ch': _currentChannel,
      'peers': allNodes,
    }));
    for (final peer in _peers.values) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(InternetAddress(peer.ipAddress), port: const Port(discoveryPort)),
        );
      } catch (_) {}
    }
  }

  Future<void> _sendDiscoveryAnnouncement() async {
    if (_discoverySocket == null) return;
    final bytes = utf8.encode(jsonEncode({
      'type': 'ANNOUNCE',
      'id': _deviceId,
      'callsign': _myCallsign,
      'ip': _localIp,
      'ch': _currentChannel,
      'ping': _lastPingMs,
    }));

    final parts = _localIp.split('.');
    final subnetPrefix = parts.length == 4 ? '\${parts[0]}.\${parts[1]}.\${parts[2]}' : '192.168.43';
    final subnetBroadcast = '\$subnetPrefix.255';
    final subnetGateway = '\$subnetPrefix.1';

    // 1. Subnet Broadcast (dipisah try/catch agar bebas ENETUNREACH saat Hotspot Tanpa Internet)
    try {
      await _discoverySocket!.send(
        bytes,
        Endpoint.unicast(InternetAddress(subnetBroadcast), port: const Port(discoveryPort)),
      );
    } catch (_) {}

    // 2. Direct Unicast ke Gateway Master (.1) & Peer Aktif
    final Set<String> directTargets = {
      subnetGateway,
      masterDefaultIp,
      ..._peers.keys,
    }..remove(_localIp);

    for (final ip in directTargets) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(InternetAddress(ip), port: const Port(discoveryPort)),
        );
      } catch (_) {}
    }

    // 3. Rotating Unicast Subnet Sweep (.2 .. .254) agar tembus AP Broadcast Isolation
    for (int i = 0; i < 36; i++) {
      final hostOctet = _subnetSweepCursor;
      _subnetSweepCursor = _subnetSweepCursor >= 254 ? 2 : _subnetSweepCursor + 1;
      final candidateIp = '\$subnetPrefix.\$hostOctet';
      if (candidateIp == _localIp || directTargets.contains(candidateIp)) continue;
      try {
        _discoverySocket!.send(
          bytes,
          Endpoint.unicast(InternetAddress(candidateIp), port: const Port(discoveryPort)),
        );
      } catch (_) {}
    }
  }

  Future<void> _bindAudioSocket() async {
    _audioSocket?.close();
    _audioSocket = await UDP.bind(Endpoint.any(port: const Port(audioPort)));

    _audioSocket!.asStream().listen((Datagram? datagram) {
      if (datagram == null || datagram.data.length <= 6) return;
      final senderIp = datagram.address.address;
      if (senderIp == _localIp) return;

      final bytes = datagram.data;
      if (bytes[0] != _currentChannel) return;

      final flags = bytes[1];
      final bool isRelayed = (flags & 4) != 0;
      if (_isMaster && !isRelayed) {
        final relayed = Uint8List.fromList(bytes);
        relayed[1] = flags | 4;
        for (final peer in activeChannelPeers) {
          if (peer.ipAddress == senderIp || peer.ipAddress == _localIp) continue;
          try {
            _audioSocket!.send(
              relayed,
              Endpoint.unicast(InternetAddress(peer.ipAddress), port: const Port(audioPort)),
            );
          } catch (_) {}
        }
      }

      final pcmPayload = Uint8List.sublistView(bytes, 6);
      onAudioPacketReceived?.call(pcmPayload, senderIp);
    });
  }

  Future<void> sendRawAudioChunk(Uint8List pcmChunk) async {
    if (_audioSocket == null || pcmChunk.isEmpty) return;
    _txSequence = (_txSequence + 1) & 0xFFFF;

    final header = ByteData(6);
    header.setUint8(0, _currentChannel);
    header.setUint8(1, (_isMaster ? 1 : 0) | (_talkAll ? 2 : 0));
    header.setUint16(2, _txSequence, Endian.big);
    header.setUint16(4, pcmChunk.length, Endian.big);

    final packet = Uint8List(6 + pcmChunk.length);
    packet.setRange(0, 6, header.buffer.asUint8List());
    packet.setRange(6, packet.length, pcmChunk);

    final parts = _localIp.split('.');
    final subnetGateway = parts.length == 4 ? '\${parts[0]}.\${parts[1]}.\${parts[2]}.1' : masterDefaultIp;
    final Set<String> targetIps = {
      ...targetedPeers.map((p) => p.ipAddress),
      if (!_isMaster) subnetGateway,
    }..remove(_localIp);

    for (final ip in targetIps) {
      try {
        await _audioSocket!.send(
          packet,
          Endpoint.unicast(InternetAddress(ip), port: const Port(audioPort)),
        );
      } catch (_) {}
    }
  }

  Future<void> refreshPing() async {
    if (_discoverySocket == null) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final bytes = utf8.encode(jsonEncode({'type': 'PING', 'ts': now}));
    for (final peer in _peers.values) {
      try {
        await _discoverySocket!.send(
          bytes,
          Endpoint.unicast(InternetAddress(peer.ipAddress), port: const Port(discoveryPort)),
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
        Endpoint.unicast(InternetAddress(targetIp), port: const Port(discoveryPort)),
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
}`,
  },
];
