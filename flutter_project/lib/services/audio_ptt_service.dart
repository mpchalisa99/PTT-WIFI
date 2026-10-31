import 'dart:async';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:flutter_sound/flutter_sound.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';
import 'udp_network_service.dart';

/// ============================================================================
/// AUDIO PTT SERVICE - LOW LATENCY RAW PCM STREAMING
/// ============================================================================
/// Menggunakan:
/// - `AudioRecorder` (package: record) dengan konfigurasi ` AudioEncoder.pcm16bits`,
///   Sample Rate 16000 Hz, Mono (1 channel) untuk menangkap stream byte langsung
///   dari mikrofon saat tombol PTT ditekan (`onLongPress`).
/// - `FlutterSoundPlayer` (package: flutter_sound) dalam mode `startPlayerFromStream`
///   untuk langsung memutar setiap paket UDP suara yang masuk ke speaker perangkat
///   tanpa menyimpan ke file (Zero-Disk I/O, Real-Time Walkie Talkie).
/// ============================================================================
class AudioPttService {
  final UdpNetworkService networkService;
  final AudioRecorder _recorder = AudioRecorder();
  final FlutterSoundPlayer _player = FlutterSoundPlayer();

  StreamSubscription<Uint8List>? _micStreamSub;
  bool _isPlayerInitialized = false;

  /// Ukuran paket ideal per datagram UDP (1280 bytes = 40ms audio @ 16kHz 16-bit mono)
  /// Aman di bawah batas MTU WiFi (1472 bytes) sehingga bebas fragmentasi IP.
  static const int udpChunkSize = 1280;
  static const int sampleRate = 16000;

  AudioPttService({required this.networkService}) {
    // Hubungkan callback penerimaan paket UDP ke antrean pemutar suara
    networkService.onAudioPacketReceived = _handleIncomingPcmPacket;
  }

  Future<void> initialize() async {
    final status = await Permission.microphone.request();
    if (!status.isGranted) {
      debugPrint('Izin mikrofon ditolak oleh pengguna');
      return;
    }

    await _player.openPlayer();
    await _player.startPlayerFromStream(
      codec: Codec.pcm16,
      numChannels: 1,
      sampleRate: sampleRate,
    );
    _isPlayerInitialized = true;
  }

  /// Dipanggil saat tombol PTT utama menerima event `onLongPress`
  Future<void> startPushToTalk() async {
    if (!await _recorder.hasPermission()) return;

    networkService.setTransmitting(true);

    // Mulai menangkap stream raw PCM 16-bit langsung dari hardware mic
    final stream = await _recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: sampleRate,
        numChannels: 1,
        autoGain: true,
        echoCancel: true,
        noiseSuppress: true,
      ),
    );

    final List<int> accumulator = [];

    _micStreamSub = stream.listen((Uint8List data) {
      accumulator.addAll(data);

      // Potong menjadi paket 1280-byte dan langsung tembakkan ke socket UDP
      while (accumulator.length >= udpChunkSize) {
        final chunk = Uint8List.fromList(accumulator.sublist(0, udpChunkSize));
        accumulator.removeRange(0, udpChunkSize);
        networkService.sendRawAudioChunk(chunk);
      }
    });
  }

  /// Dipanggil saat tombol PTT utama dilepas (`onLongPressEnd`)
  Future<void> stopPushToTalk() async {
    await _micStreamSub?.cancel();
    _micStreamSub = null;
    if (await _recorder.isRecording()) {
      await _recorder.stop();
    }
    networkService.setTransmitting(false);
  }

  /// Memutar langsung paket suara UDP yang baru tiba dari anggota lain
  void _handleIncomingPcmPacket(Uint8List pcmBytes, String senderIp) {
    if (!_isPlayerInitialized || _player.foodSink == null) return;
    // Half-duplex: jangan memutar suara masuk saat kita sedang menekan PTT
    if (networkService.isTransmitting) return;

    _player.foodSink!.add(FoodData(pcmBytes));
  }

  Future<void> dispose() async {
    await stopPushToTalk();
    await _recorder.dispose();
    if (_isPlayerInitialized) {
      await _player.stopPlayer();
      await _player.closePlayer();
    }
  }
}
