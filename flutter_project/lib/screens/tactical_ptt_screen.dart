import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/peer_member.dart';
import '../services/audio_ptt_service.dart';
import '../services/udp_network_service.dart';

class TacticalPttScreen extends StatefulWidget {
  final UdpNetworkService networkService;
  final AudioPttService audioService;

  const TacticalPttScreen({
    super.key,
    required this.networkService,
    required this.audioService,
  });

  @override
  State<TacticalPttScreen> createState() => _TacticalPttScreenState();
}

class _TacticalPttScreenState extends State<TacticalPttScreen> {
  int _selectedNavIndex = 0;

  // Fallback mock anggota taktikal ketika belum ada peer fisik di LAN,
  // atau digabungkan dengan peer nyata hasil Auto-Discovery UDP Port 50000.
  final List<PeerMember> _mockMembers = [
    PeerMember(id: 'M1', callsign: 'YUDHI', ipAddress: '192.168.43.1', channel: 12, isMaster: true),
    PeerMember(id: 'M2', callsign: 'EKO', ipAddress: '192.168.43.102', channel: 12),
    PeerMember(id: 'M3', callsign: 'PUJI', ipAddress: '192.168.43.103', channel: 12),
    PeerMember(id: 'M4', callsign: 'JEFRY', ipAddress: '192.168.43.104', channel: 12),
    PeerMember(id: 'M5', callsign: 'YUSUF', ipAddress: '192.168.43.105', channel: 12),
    PeerMember(id: 'M6', callsign: 'EDWIN', ipAddress: '192.168.43.106', channel: 12),
  ];

  static const Color bgDarkNavy = Color(0xFF041D34);
  static const Color panelNavy = Color(0xFF062A49);
  static const Color cyanBright = Color(0xFF23DCFF);
  static const Color cyanSoft = Color(0xFF7CE8FF);

  List<PeerMember> get _displayMembers {
    final discovered = widget.networkService.activeChannelPeers;
    if (discovered.isNotEmpty) return discovered;
    return _mockMembers;
  }

  void _showEditCallsignDialog({PeerMember? targetMember}) {
    final controller = TextEditingController(
      text: targetMember != null
          ? targetMember.callsign
          : widget.networkService.myCallsign,
    );
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF05233E),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: cyanBright, width: 1.5),
        ),
        title: Text(
          targetMember != null ? 'UBAH CALLSIGN ANGGOTA' : 'EDIT CALLSIGN SAYA',
          style: const TextStyle(color: cyanBright, fontWeight: FontWeight.bold, fontSize: 16),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
          decoration: InputDecoration(
            hintText: 'Masukkan Nama / Callsign',
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
              final val = controller.text.trim().toUpperCase();
              if (val.isNotEmpty) {
                setState(() {
                  if (targetMember != null) {
                    targetMember.callsign = val;
                  } else {
                    widget.networkService.setCallsign(val);
                    _mockMembers[0].callsign = val;
                  }
                });
              }
              Navigator.pop(ctx);
            },
            child: const Text('SIMPAN', style: TextStyle(color: Color(0xFF021627), fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  void _showBarcodeDialog() {
    final net = widget.networkService;
    final payload = 'DISKOMLEKAU://JOIN?host=${net.localIp}&ch=${net.currentChannel}&port=50000';
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF05233E),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(18),
          side: const BorderSide(color: cyanBright, width: 1.5),
        ),
        title: const Text(
          'BARCODE SINKRONISASI HOTSPOT',
          textAlign: TextAlign.center,
          style: TextStyle(color: cyanBright, fontWeight: FontWeight.bold, fontSize: 15),
        ),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
              ),
              child: const Icon(Icons.qr_code_2, size: 170, color: Color(0xFF03192E)),
            ),
            const SizedBox(height: 12),
            Text(
              'CH ${net.currentChannel} • HOST ${net.localIp}:50000',
              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 4),
            Text(
              payload,
              textAlign: TextAlign.center,
              style: const TextStyle(color: cyanSoft, fontSize: 11),
            ),
          ],
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
    return AnimatedBuilder(
      animation: widget.networkService,
      builder: (context, _) {
        final net = widget.networkService;
        final members = _displayMembers;
        final activeClientsCount = members.length > 1 ? members.length - 1 : 3;

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
                          // 1. HEADER TEKS
                          const Padding(
                            padding: EdgeInsets.symmetric(vertical: 8),
                            child: Text(
                              'DISKOMLEKAU TACTICAL PTT',
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                color: Color(0xFFE5FAFF),
                                fontSize: 24,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.4,
                                shadows: [
                                  Shadow(color: cyanBright, blurRadius: 14),
                                ],
                              ),
                            ),
                          ),

                          // 2. CARD STATUS JARINGAN (TOP PANEL)
                          _buildNetworkStatusCard(net, activeClientsCount),
                          const SizedBox(height: 12),

                          // 3. CARD CHANNEL SELECTOR
                          _buildChannelSelectorCard(net, members.length),
                          const SizedBox(height: 14),

                          // 4. GRID USER / ANGGOTA
                          _buildMembersSection(net, members),
                          const SizedBox(height: 18),

                          // 5. TOMBOL PTT UTAMA (CENTER)
                          _buildCenterPttButton(net),
                          const SizedBox(height: 16),

                          // STATUS BANNER BAWAH TOMBOL PTT
                          _buildMasterReadyBanner(net),
                        ],
                      ),
                    ),
                  ),

                  // 6. BOTTOM NAVIGATION BAR
                  _buildBottomNavBar(),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _buildNetworkStatusCard(UdpNetworkService net, int activeClients) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tacticalCardDecoration(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // Indikator Sinyal 4 Bar
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  color: const Color(0xFF03192D),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: cyanBright.withValues(alpha: 0.4)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    _signalBar(8, true),
                    const SizedBox(width: 3),
                    _signalBar(12, true),
                    const SizedBox(width: 3),
                    _signalBar(16, true),
                    const SizedBox(width: 3),
                    _signalBar(20, !net.isHighLatency),
                  ],
                ),
              ),
              const SizedBox(width: 10),
              // PING: [X] ms
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'PING:',
                    style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                  ),
                  Text(
                    '${net.lastPingMs} ms',
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 15),
                  ),
                ],
              ),
              const SizedBox(width: 6),
              Text(
                '(+${net.pingDeltaMs.abs()}ms)',
                style: const TextStyle(color: cyanSoft, fontSize: 12),
              ),
              const SizedBox(width: 8),
              // Status LATENCY TINGGI / RENDAH
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
                      fontSize: 11,
                      height: 1.15,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Tombol Refresh Ping
              InkWell(
                onTap: net.refreshPing,
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                  decoration: BoxDecoration(
                    color: const Color(0xFF04223C),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: cyanBright.withValues(alpha: 0.6)),
                  ),
                  child: const Row(
                    children: [
                      Icon(Icons.sync, size: 15, color: cyanBright),
                      SizedBox(width: 4),
                      Text('Ping', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 12)),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 6),
              // Label Status MASTER atau CLIENT
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(
                  color: cyanBright,
                  borderRadius: BorderRadius.circular(8),
                  boxShadow: [BoxShadow(color: cyanBright.withValues(alpha: 0.5), blurRadius: 10)],
                ),
                child: Row(
                  children: [
                    const Icon(Icons.star, size: 14, color: Color(0xFF022038)),
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
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  'PERAN: ${net.isMaster ? "HP MASTER" : "HP CLIENT"}\n(${net.localIp})',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600, height: 1.35),
                ),
              ),
              Expanded(
                child: Text(
                  'Peer Aktif: $activeClients • Target: $activeClients activeClients\n(Unicast)',
                  style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600, height: 1.35),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildChannelSelectorCard(UdpNetworkService net, int membersCount) {
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
                  fontSize: 12.5,
                  letterSpacing: 0.6,
                ),
              ),
              Icon(Icons.arrow_drop_down, color: cyanSoft, size: 18),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              // Knob Kiri (Turunkan Channel)
              _buildRotaryKnob(
                onTap: () => net.setChannel(net.currentChannel - 1),
                angle: -math.pi / 4,
              ),
              const SizedBox(width: 12),
              // Layar Tengah CHANNEL
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
                      Text(
                        'MASTER HOST - ${net.localIp}',
                        style: const TextStyle(
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
              // Knob Kanan (Naikkan Channel)
              _buildRotaryKnob(
                onTap: () => net.setChannel(net.currentChannel + 1),
                angle: math.pi / 4,
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'HP MASTER AKTIF | $membersCount MEMBERS ONLINE',
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w800,
                  fontSize: 12,
                  letterSpacing: 0.5,
                ),
              ),
              InkWell(
                onTap: _showBarcodeDialog,
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

  Widget _buildRotaryKnob({required VoidCallback onTap, required double angle}) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(32),
      child: Container(
        width: 54,
        height: 54,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: const RadialGradient(
            colors: [Color(0xFF0D4C73), Color(0xFF042038)],
          ),
          border: Border.all(color: cyanBright.withValues(alpha: 0.7), width: 2),
          boxShadow: [BoxShadow(color: cyanBright.withValues(alpha: 0.25), blurRadius: 8)],
        ),
        child: Center(
          child: Transform.rotate(
            angle: angle,
            child: Align(
              alignment: Alignment.bottomCenter,
              child: Container(
                margin: const EdgeInsets.only(bottom: 8),
                width: 3,
                height: 12,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildMembersSection(UdpNetworkService net, List<PeerMember> members) {
    return Column(
      children: [
        // Baris Atas: Tombol (•) TALK ALL, ID SAYA: YUDHI, dan Edit Nama
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
                      child: RichText(
                        overflow: TextOverflow.ellipsis,
                        text: TextSpan(
                          style: const TextStyle(fontSize: 13, color: cyanSoft),
                          children: [
                            const TextSpan(text: 'ID SAYA: '),
                            TextSpan(
                              text: net.myCallsign,
                              style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w900),
                            ),
                          ],
                        ),
                      ),
                    ),
                    InkWell(
                      onTap: () => _showEditCallsignDialog(),
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

        // Baris Bawah: Grid 2x3 berisi tombol untuk user yang online
        GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          itemCount: members.length,
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 3,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 2.15,
          ),
          itemBuilder: (ctx, index) {
            final member = members[index];
            final isHighlighted = member.callsign == 'JEFRY' || member.isTalking;
            return InkWell(
              onTap: () {
                setState(() {
                  member.isTargeted = !member.isTargeted;
                });
              },
              borderRadius: BorderRadius.circular(14),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: isHighlighted
                        ? [const Color(0xFF1499C7), const Color(0xFF0A6691)]
                        : [const Color(0xFF062C4D), const Color(0xFF041D35)],
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                  ),
                  borderRadius: BorderRadius.circular(14),
                  border: Border.all(
                    color: member.isTargeted ? cyanBright : cyanBright.withValues(alpha: 0.35),
                    width: member.isTargeted ? 1.5 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Container(
                          width: 28,
                          height: 28,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: const Color(0xFF03192E),
                            border: Border.all(color: cyanBright.withValues(alpha: 0.6)),
                          ),
                          child: const Icon(Icons.mic_none, size: 16, color: cyanBright),
                        ),
                        Positioned(
                          right: -1,
                          top: -1,
                          child: Container(
                            width: 8,
                            height: 8,
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              color: cyanBright,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            member.callsign,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w900,
                              fontSize: 13,
                            ),
                          ),
                          Text(
                            index == 0 ? '• ID AW..' : 'ALL AKTIF',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: cyanSoft,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ],
                      ),
                    ),
                    InkWell(
                      onTap: () => _showEditCallsignDialog(targetMember: member),
                      child: Container(
                        width: 22,
                        height: 22,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: cyanBright.withValues(alpha: 0.5)),
                        ),
                        child: const Icon(Icons.edit, size: 12, color: Colors.white),
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

  /// 5. TOMBOL PTT UTAMA (CENTER) DENGAN EVENT onLongPress & onLongPressEnd
  Widget _buildCenterPttButton(UdpNetworkService net) {
    final isTx = net.isTransmitting;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        // Indikator gelombang kiri
        _buildSideWaveform(isTx, reversed: true),
        const SizedBox(width: 12),
        GestureDetector(
          onLongPress: () => widget.audioService.startPushToTalk(),
          onLongPressEnd: (_) => widget.audioService.stopPushToTalk(),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 150),
            width: 215,
            height: 215,
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
            child: Stack(
              alignment: Alignment.center,
              children: [
                // Teks melingkar "PUSH TO TALK & HOLD" di bagian atas lingkaran
                const SizedBox(
                  width: 190,
                  height: 190,
                  child: CustomPaint(
                    painter: _CurvedTextPainter(text: 'PUSH TO TALK & HOLD'),
                  ),
                ),
                // Lingkaran dalam tombol
                Container(
                  width: 142,
                  height: 142,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const RadialGradient(
                      colors: [Color(0xFF1A8EC4), Color(0xFF073B5E)],
                    ),
                    border: Border.all(color: cyanSoft.withValues(alpha: 0.65), width: 1.5),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.sensors,
                        size: 44,
                        color: isTx ? Colors.white : const Color(0xFF03233B),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        isTx ? 'TRANSMITTING' : 'MASTER READY',
                        style: const TextStyle(
                          color: Colors.white,
                          fontWeight: FontWeight.w900,
                          fontSize: 13.5,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(width: 12),
        // Indikator gelombang kanan
        _buildSideWaveform(isTx, reversed: false),
      ],
    );
  }

  Widget _buildSideWaveform(bool active, {required bool reversed}) {
    final heights = [4.0, 5.0, 6.0, 7.0, 8.0, 10.0, 12.0, 14.0];
    final list = reversed ? heights : heights.reversed.toList();
    return Row(
      children: list
          .map(
            (h) => Container(
              margin: const EdgeInsets.symmetric(horizontal: 1.8),
              width: 3.5,
              height: active ? h * 1.6 : h,
              decoration: BoxDecoration(
                color: cyanBright.withValues(alpha: active ? 0.95 : 0.55),
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          )
          .toList(),
    );
  }

  Widget _buildMasterReadyBanner(UdpNetworkService net) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 14),
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [Color(0xFF28E0FF), Color(0xFF09B6DF)],
        ),
        borderRadius: BorderRadius.circular(14),
        boxShadow: [
          BoxShadow(color: cyanBright.withValues(alpha: 0.45), blurRadius: 16),
        ],
      ),
      child: Text(
        net.isTransmitting ? 'UDP AUDIO STREAMING (PORT 50001)...' : 'MASTER READY',
        textAlign: TextAlign.center,
        style: const TextStyle(
          color: Colors.white,
          fontSize: 16,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  Widget _buildBottomNavBar() {
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
          final selected = _selectedNavIndex == i;
          return InkWell(
            onTap: () {
              setState(() => _selectedNavIndex = i);
              if (i == 1) _showEditCallsignDialog();
              if (i == 2) _showBarcodeDialog();
            },
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(items[i].$1, color: selected ? cyanBright : Colors.white, size: 22),
                const SizedBox(height: 4),
                Text(
                  items[i].$2,
                  style: TextStyle(
                    color: selected ? cyanBright : Colors.white,
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

  Widget _signalBar(double height, bool active) {
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

/// Painter untuk menggambar teks melingkar "PUSH TO TALK & HOLD"
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
            fontSize: 11.5,
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
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

/// Painter untuk motif grid transparan pada latar belakang biru tua taktikal
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
