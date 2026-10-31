import 'dart:async';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';
import 'package:record/record.dart';

/// ============================================================================
/// AUDIO SERVICE - STREAMING SUARA RAW PCM 16-BIT 16KHZ MONO TANPA INTERNET
/// ============================================================================
/// 1. Menggunakan package `record` (AudioRecorder) untuk menangkap stream
///    suara dari microphone dalam format Raw PCM 16-bit Mono 16000 Hz.
/// 2. Memotong stream menjadi chunk berukuran 1280 byte (40ms @ 16kHz) agar
///    bebas fragmentasi MTU ketika dikirim lewat socket UDP.
/// 3. Menggunakan package `audioplayers` (BytesSource di memori RAM dengan
///    header WAV ringan 44-byte) untuk memutar buffer PCM mentah yang diterima
///    dari jaringan tanpa menulis file ke storage.
/// ============================================================================
class AudioService {
  final AudioRecorder _recorder = AudioRecorder();
  final AudioPlayer _player = AudioPlayer();

  StreamSubscription<Uint8List>? _recordingSubscription;
  bool _isRecording = false;

  /// Konfigurasi standar audio taktikal: 16kHz, 16-bit, Mono (1 channel)
  static const int sampleRate = 16000;
  static const int numChannels = 1;
  static const int bitsPerSample = 16;

  /// 1280 bytes = 40ms audio @ 16kHz 16-bit mono (aman di bawah MTU WiFi 1472B)
  static const int udpChunkSize = 1280;

  /// Buffer penampung sementara untuk merangkai frame micro-jaringan agar mulus
  final BytesBuilder _playbackBuffer = BytesBuilder(copy: false);
  bool _isPlayingChunk = false;

  AudioService() {
    // Set AudioPlayer ke mode Low Latency untuk komunikasi Walkie-Talkie
    _player.setReleaseMode(ReleaseMode.stop);
    _player.setPlayerMode(PlayerMode.lowLatency);
  }

  /// Mulai merekam suara dari microphone dan mengalirkan byte PCM secara
  /// terus-menerus ke callback [onAudioChunk] untuk dikirim via UDP.
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

        // Kirim setiap 1280 byte ke jaringan UDP secara real-time
        while (accumulator.length >= udpChunkSize) {
          final chunk = Uint8List.fromList(accumulator.sublist(0, udpChunkSize));
          accumulator.removeRange(0, udpChunkSize);
          onAudioChunk(chunk);
        }
      },
      onError: (Object err) {
        debugPrint('Error pada stream microphone: $err');
      },
    );
  }

  /// Hentikan perekaman microphone saat tombol PTT dilepas (`onLongPressEnd`).
  Future<void> stopRecording() async {
    _isRecording = false;
    await _recordingSubscription?.cancel();
    _recordingSubscription = null;

    if (await _recorder.isRecording()) {
      await _recorder.stop();
    }
  }

  /// Memutar data PCM mentah (16-bit 16kHz Mono) yang diterima dari paket UDP.
  /// Menggabungkan chunk pendek di memori RAM dan membungkusnya dengan header
  /// WAV 44-byte in-memory agar `audioplayers` dapat memutarnya langsung via
  /// `BytesSource` tanpa menyentuh disk/file system.
  Future<void> playAudioChunk(Uint8List pcmBytes) async {
    if (pcmBytes.isEmpty || _isRecording) return;

    _playbackBuffer.add(pcmBytes);

    // Kumpulkan minimal ~120ms audio (3840 bytes) agar pemutaran bebas jitter
    if (_playbackBuffer.length < udpChunkSize * 3 || _isPlayingChunk) {
      return;
    }

    _isPlayingChunk = true;
    try {
      final rawPcm = _playbackBuffer.takeBytes();
      final wavBytes = _addWavHeader(rawPcm);
      await _player.play(BytesSource(wavBytes));
    } catch (e) {
      debugPrint('Gagal memutar chunk audio UDP: $e');
    } finally {
      _isPlayingChunk = false;
    }
  }

  /// Membuat header WAV 44-byte di memori untuk membungkus Raw PCM 16-bit 16kHz Mono
  Uint8List _addWavHeader(Uint8List pcmData) {
    final int dataLength = pcmData.length;
    final int fileSize = dataLength + 36;
    final int byteRate = sampleRate * numChannels * (bitsPerSample ~/ 8);
    final int blockAlign = numChannels * (bitsPerSample ~/ 8);

    final header = ByteData(44);
    // "RIFF"
    header.setUint8(0, 0x52);
    header.setUint8(1, 0x49);
    header.setUint8(2, 0x46);
    header.setUint8(3, 0x46);
    header.setUint32(4, fileSize, Endian.little);
    // "WAVE"
    header.setUint8(8, 0x57);
    header.setUint8(9, 0x41);
    header.setUint8(10, 0x56);
    header.setUint8(11, 0x45);
    // "fmt "
    header.setUint8(12, 0x66);
    header.setUint8(13, 0x6D);
    header.setUint8(14, 0x74);
    header.setUint8(15, 0x20);
    header.setUint32(16, 16, Endian.little); // Subchunk1Size (16 untuk PCM)
    header.setUint16(20, 1, Endian.little); // AudioFormat (1 = PCM)
    header.setUint16(22, numChannels, Endian.little);
    header.setUint32(24, sampleRate, Endian.little);
    header.setUint32(28, byteRate, Endian.little);
    header.setUint16(32, blockAlign, Endian.little);
    header.setUint16(34, bitsPerSample, Endian.little);
    // "data"
    header.setUint8(36, 0x64);
    header.setUint8(37, 0x61);
    header.setUint8(38, 0x74);
    header.setUint8(39, 0x61);
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
