import 'package:flutter/material.dart';
import 'package:iris_remote/design/flow.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/tailscale_store.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class QrScannerScreen extends StatefulWidget {
  const QrScannerScreen({super.key});

  @override
  State<QrScannerScreen> createState() => _QrScannerScreenState();
}

class _QrScannerScreenState extends State<QrScannerScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );
  String? _error;
  String? _notice;
  bool _accepted = false;
  bool _storeOpened = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _openStore() async {
    if (_storeOpened) return;
    _storeOpened = true;
    final opened = await const TailscaleStore().open();
    if (!mounted) return;
    setState(() {
      if (opened) {
        _error = null;
        _notice = 'Play 스토어에서 Tailscale을 설치하고 컴퓨터과 같은 계정으로 로그인하세요. 그다음 컴퓨터에서 기기 추가를 눌러 나온 QR을 찍으세요.';
      } else {
        _error = 'Play 스토어를 열지 못했습니다. Tailscale 앱을 직접 설치하세요.';
      }
    });
  }

  void _onDetect(BarcodeCapture capture) {
    if (_accepted) return;
    for (final barcode in capture.barcodes) {
      final text = barcode.rawValue;
      if (text == null) continue;
      if (TailscaleStore.isInstallQr(text)) {
        _openStore();
        return;
      }
      try {
        final qr = PairingQr.parse(text);
        _accepted = true;
        _controller.stop();
        Navigator.of(context).pop(qr);
        return;
      } on ProtocolException catch (error) {
        setState(() => _error = error.message);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return QrScannerView(
      onBack: () => Navigator.of(context).pop(),
      error: _error,
      notice: _notice,
      camera: MobileScanner(
        controller: _controller,
        onDetect: _onDetect,
        errorBuilder: (context, error) => Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              '카메라를 열지 못했습니다. 카메라 권한을 확인하세요.',
              textAlign: TextAlign.center,
              style: TextStyle(color: context.iris.blocked),
            ),
          ),
        ),
      ),
    );
  }
}

class QrScannerView extends StatelessWidget {
  const QrScannerView({
    required this.camera,
    required this.onBack,
    this.error,
    this.notice,
    super.key,
  });

  final Widget camera;
  final VoidCallback onBack;
  final String? error;
  final String? notice;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            IrisFlowHeader(title: 'QR 코드 스캔', onBack: onBack),
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ClipRRect(
                    borderRadius: const BorderRadius.vertical(
                      top: Radius.circular(22),
                    ),
                    child: camera,
                  ),
                  Align(
                    alignment: Alignment.center,
                    child: Container(
                      key: const Key('qr-frame'),
                      width: 246,
                      height: 246,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(color: context.iris.brand, width: 2),
                      ),
                    ),
                  ),
                  Align(
                    alignment: Alignment.bottomCenter,
                    child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
                      color: context.iris.background.withValues(alpha: 0.92),
                      child: Text(
                        error ?? notice ?? '컴퓨터의 Iris 원격 화면에 표시된 QR 코드를 비추세요.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: error == null
                              ? context.iris.foreground
                              : context.iris.blocked,
                          fontSize: 15,
                          height: 1.5,
                        ),
                      ),
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
}
