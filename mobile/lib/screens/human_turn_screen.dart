import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/response_host.dart';
import 'package:iris_remote/screens/response_kit.dart';
import 'package:iris_remote/state/remote_state.dart';

Future<String?> showHumanTurnSheet({
  required BuildContext context,
  required RemoteState state,
  required RemoteRequest request,
  required RemoteAgent agent,
  required VoidCallback onOpenTab,
}) {
  return showResponseHost(
    context: context,
    state: state,
    request: request,
    agentName: agent.name,
    agentKind: agent.kind,
    space: agent.space,
  );
}

class HumanTurnSheet extends StatefulWidget {
  const HumanTurnSheet({
    required this.state,
    required this.request,
    required this.agent,
    required this.onOpenTab,
    this.previewImage,
    this.previewUrl,
    this.nav,
    this.closedAs,
    this.initialChoice,
    this.onChoice,
    super.key,
  });

  final RemoteState state;
  final RemoteRequest request;
  final RemoteAgent agent;
  // 탭 열기 버튼은 미리보기 확대로 바뀌어 쓰지 않음. 호출부 시그니처만 유지
  final VoidCallback onOpenTab;
  final ui.Image? previewImage;
  final String? previewUrl;
  final ResponseNav? nav;
  // 목록에서 사라진 요청. gone 은 이유 불명, gone-expired 는 만료 시각이 지난 경우
  final String? closedAs;
  // 요청 사이를 오가도 고른 답을 보존
  final String? initialChoice;
  final ValueChanged<String>? onChoice;

  @override
  State<HumanTurnSheet> createState() => _HumanTurnSheetState();
}

class _HumanTurnSheetState extends State<HumanTurnSheet> {
  StreamSubscription<BrowserFrame>? _frames;
  final _jpeg = ValueNotifier<Uint8List?>(null);
  // 'done' 또는 'unable'
  late String? _choice = widget.initialChoice;
  String? _gone;
  bool _busy = false;

  BrowserUserRequestBody get _body =>
      widget.request.body as BrowserUserRequestBody;

  @override
  void initState() {
    super.initState();
    final tab = _body.tab;
    if (tab != null && widget.state.supports('browser.frame.watch')) {
      _frames = widget.state.session.browserFrames.listen((frame) {
        if (mounted && frame.tab == tab) _jpeg.value = frame.jpeg;
      });
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final width = browserFrameRequestWidth(
          logicalWidth: MediaQuery.sizeOf(context).width,
          devicePixelRatio: MediaQuery.devicePixelRatioOf(context),
          zoom: 1,
          desktop: false,
        );
        unawaited(_watchFrame(tab, width));
      });
    }
  }

  Future<void> _watchFrame(String tab, int width) async {
    try {
      await widget.state.session.watchBrowserFrame(tab, width: width);
    } on RemoteFailure catch (error) {
      if (mounted) {
        showIrisToast(context, error.message, tone: IrisToastTone.error);
      }
    }
  }

  @override
  void dispose() {
    _frames?.cancel();
    _jpeg.dispose();
    super.dispose();
  }

  void _pick(String choice) {
    setState(() => _choice = choice);
    widget.onChoice?.call(choice);
  }

  Future<void> _answer() async {
    final choice = _choice;
    if (_busy || choice == null) return;
    setState(() => _busy = true);
    try {
      final response = await widget.state.answerBrowserUser(
        widget.request,
        choice: choice,
      );
      if (!mounted) return;
      switch (response.result) {
        case 'delivered':
          showIrisToast(context, '에이전트에게 보냈습니다');
          Navigator.of(context).pop();
        case 'already-answered' || 'expired':
          setState(() => _gone = response.result);
        default:
          showIrisToast(
            context,
            requestAnswerResultText(response.result),
            tone: IrisToastTone.error,
          );
      }
    } on RemoteFailure catch (error) {
      if (mounted) {
        showIrisToast(context, error.message, tone: IrisToastTone.error);
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget? _image(Uint8List? jpeg, BoxFit fit, Alignment alignment) {
    if (widget.previewImage != null) {
      return RawImage(
        image: widget.previewImage,
        fit: fit,
        alignment: alignment,
      );
    }
    if (jpeg != null) {
      return Image.memory(jpeg, fit: fit, alignment: alignment);
    }
    return null;
  }

  void _zoom() {
    if (widget.previewImage == null && _jpeg.value == null) return;
    Navigator.of(context).push<void>(
      MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => _FrameZoom(
          jpeg: _jpeg,
          builder: (jpeg) =>
              _image(jpeg, BoxFit.contain, Alignment.center) ??
              const SizedBox.shrink(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final gone = _gone ?? (_busy ? null : widget.closedAs);
    if (gone != null) return _answered(context, gone);
    final colors = context.iris;
    final tab = _body.tab == null ? null : widget.state.browserTab(_body.tab!);
    final previewUrl = widget.previewUrl ?? tab?.url;
    final label = _busy
        ? '보내는 중…'
        : (_choice == null
              ? '답을 고르세요'
              : (_choice == 'done' ? '‘다 했음’ 보내기' : '‘못 하겠음’ 보내기'));
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agent.name,
      space: widget.agent.space,
      agentKind: widget.agent.kind,
      nav: widget.nav,
      bar: IrisActionBar(
        buttons: [
          IrisButton(
            key: const Key('human-turn-later'),
            label: '나중에',
            tone: IrisButtonTone.ghost,
            onPressed: _busy ? null : () => Navigator.of(context).maybePop(),
          ),
          IrisButton(
            key: const Key('human-turn-send'),
            label: label,
            tone: IrisButtonTone.primary,
            onPressed: _choice == null || _busy ? null : _answer,
          ),
        ],
      ),
      children: [
        ResponseKindRow(
          label: '사람이 할 일',
          tone: ResponseTone.human,
          icon: 'hand-pointing',
          time: responseAgo(widget.request.createdAt),
        ),
        ResponseTitle(
          key: const Key('human-turn-title'),
          _body.title,
          child: (style) =>
              IrisMarkdown(_body.title, compact: true, baseStyle: style),
        ),
        if (_body.text.isNotEmpty)
          IrisMarkdown(
            _body.text,
            compact: true,
            baseStyle: responseLeadStyle(context),
            textColor: colors.muted,
          ),
        const SizedBox(height: 14),
        _preview(context, tab?.title ?? widget.agent.space, previewUrl),
        const ResponseSectionLabel('답'),
        ResponseOption(
          key: const Key('human-turn-done'),
          title: '다 했음',
          description: '에이전트가 다음 단계로 진행합니다',
          selected: _choice == 'done',
          onTap: _busy ? null : () => _pick('done'),
        ),
        const SizedBox(height: 8),
        ResponseOption(
          key: const Key('human-turn-unable'),
          title: '못 하겠음',
          description: '에이전트가 이 단계를 건너뛰고 다른 방법을 찾습니다',
          negative: true,
          selected: _choice == 'unable',
          onTap: _busy ? null : () => _pick('unable'),
        ),
      ],
    );
  }

  // 페이지 미리보기. 누르면 전체 화면 확대 뷰
  Widget _preview(BuildContext context, String title, String? url) {
    final colors = context.iris;
    return GestureDetector(
      key: const Key('human-turn-frame'),
      onTap: _zoom,
      behavior: HitTestBehavior.opaque,
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: colors.level1,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: colors.line2),
        ),
        child: Column(
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
              decoration: BoxDecoration(
                border: Border(bottom: BorderSide(color: colors.separator)),
              ),
              child: Row(
                children: [
                  IrisIcon('lock-simple', size: 14, color: colors.foreground2),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: colors.foreground2, fontSize: 13),
                    ),
                  ),
                  if (url?.isNotEmpty == true) ...[
                    const SizedBox(width: 8),
                    Flexible(
                      child: Text(
                        _publicLocation(url!),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: IrisType.mono.copyWith(
                          color: colors.muted,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            SizedBox(
              height: 200,
              width: double.infinity,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  const ColoredBox(color: Color(0xffF7F9FB)),
                  ValueListenableBuilder<Uint8List?>(
                    valueListenable: _jpeg,
                    builder: (context, jpeg, _) =>
                        _image(jpeg, BoxFit.fitWidth, Alignment.topCenter) ??
                        const Center(
                          child: IrisIcon(
                            'globe',
                            size: 28,
                            color: Color(0xff56717f),
                          ),
                        ),
                  ),
                  Positioned(
                    right: 10,
                    top: 10,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 7,
                        vertical: 1,
                      ),
                      decoration: BoxDecoration(
                        color: const Color(0xbf1B2630),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: const Text(
                        'Mac 화면',
                        style: TextStyle(color: Colors.white, fontSize: 11),
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

  Widget _answered(BuildContext context, String gone) {
    final remaining = gone.startsWith('gone')
        ? (widget.nav?.count ?? 0)
        : ((widget.nav?.count ?? 1) - 1).clamp(0, 99);
    return ResponseFrame(
      header: ResponseHeader.titledNext,
      title: widget.agent.name,
      space: widget.agent.space,
      agentKind: widget.agent.kind,
      bar: responseAnsweredBar(
        onHome: () => Navigator.of(context).pop(),
        remaining: remaining,
        onNext: widget.nav?.onNext,
      ),
      children: [
        ResponseAnswered(
          title: responseGoneText(gone).$1,
          detail: responseGoneText(gone).$2,
          badge: responseGoneBadge(gone),
          kindLabel: '사람이 할 일',
          kindIcon: 'hand-pointing',
          kindTone: ResponseTone.human,
          ghost: responseGhostCode(context, _body.title),
        ),
      ],
    );
  }
}

// 미리보기 확대 뷰. 두 손가락으로 확대·축소, 왼쪽 위 X 로 닫음
class _FrameZoom extends StatelessWidget {
  const _FrameZoom({required this.jpeg, required this.builder});

  final ValueNotifier<Uint8List?> jpeg;
  final Widget Function(Uint8List? jpeg) builder;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('human-turn-zoom'),
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          InteractiveViewer(
            minScale: 1,
            maxScale: 6,
            child: ValueListenableBuilder<Uint8List?>(
              valueListenable: jpeg,
              builder: (context, value, _) => Center(child: builder(value)),
            ),
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.topLeft,
              child: Padding(
                padding: const EdgeInsets.all(6),
                child: GestureDetector(
                  key: const Key('human-turn-zoom-close'),
                  onTap: () => Navigator.of(context).pop(),
                  behavior: HitTestBehavior.opaque,
                  child: Container(
                    width: 44,
                    height: 44,
                    decoration: const BoxDecoration(
                      color: Color(0x99000000),
                      shape: BoxShape.circle,
                    ),
                    child: const Center(
                      child: IrisIcon('x', size: 22, color: Colors.white),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _publicLocation(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null || uri.host.isEmpty) return value;
  return '${uri.host}${uri.path == '/' ? '' : uri.path}';
}
