import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';

Future<void> showHumanTurnSheet({
  required BuildContext context,
  required RemoteState state,
  required RemoteRequest request,
  required RemoteAgent agent,
  required VoidCallback onOpenTab,
}) => showIrisSheet<void>(
  context: context,
  builder: (_) => HumanTurnSheet(
    state: state,
    request: request,
    agent: agent,
    onOpenTab: onOpenTab,
  ),
);

class HumanTurnSheet extends StatefulWidget {
  const HumanTurnSheet({
    required this.state,
    required this.request,
    required this.agent,
    required this.onOpenTab,
    this.previewImage,
    this.previewUrl,
    super.key,
  });

  final RemoteState state;
  final RemoteRequest request;
  final RemoteAgent agent;
  final VoidCallback onOpenTab;
  final ui.Image? previewImage;
  final String? previewUrl;

  @override
  State<HumanTurnSheet> createState() => _HumanTurnSheetState();
}

class _HumanTurnSheetState extends State<HumanTurnSheet> {
  StreamSubscription<BrowserFrame>? _frames;
  BrowserFrame? _frame;
  String? _result;
  bool _busy = false;

  BrowserUserRequestBody get _body =>
      widget.request.body as BrowserUserRequestBody;

  @override
  void initState() {
    super.initState();
    final tab = _body.tab;
    if (tab != null && widget.state.supports('browser.frame.watch')) {
      _frames = widget.state.session.browserFrames.listen((frame) {
        if (mounted && frame.tab == tab) setState(() => _frame = frame);
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
      if (mounted) setState(() => _result = error.message);
    }
  }

  @override
  void dispose() {
    _frames?.cancel();
    super.dispose();
  }

  Future<void> _answer(String choice) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final response = await widget.state.answerBrowserUser(
        widget.request,
        choice: choice,
      );
      if (!mounted) return;
      setState(() => _result = response.result);
      if (const {
        'delivered',
        'already-answered',
        'expired',
      }.contains(response.result)) {
        Navigator.of(context).pop();
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tab = _body.tab == null ? null : widget.state.browserTab(_body.tab!);
    final previewUrl = widget.previewUrl ?? tab?.url;
    return Column(
      key: const Key('human-turn-sheet'),
      mainAxisSize: MainAxisSize.min,
      children: [
        const IrisSheetGrabber(barKey: Key('human-turn-grabber')),
        const SizedBox(height: 14),
        SizedBox(
          key: const Key('human-turn-header'),
          height: 35,
          child: Row(
            children: [
              SizedBox(
                width: 32,
                height: 30,
                child: Center(
                  child: IrisAgentTile(
                    kind: widget.agent.kind,
                    status: 'blocked',
                    small: true,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '사람 차례 · ${widget.agent.name}',
                      style: TextStyle(
                        color: context.iris.foreground2,
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        height: 1.2,
                      ),
                    ),
                    Text(
                      '${tab?.title ?? widget.agent.space} 탭 · ${_relativeTime(widget.request.createdAt)} 전',
                      style: TextStyle(
                        color: context.iris.muted,
                        fontSize: 13,
                        height: 1.2,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        Padding(
          key: const Key('human-turn-title'),
          padding: const EdgeInsets.only(top: 14),
          child: Align(
            alignment: Alignment.topLeft,
            child: IrisMarkdown(
              _body.title,
              compact: true,
              baseStyle: TextStyle(
                color: context.iris.foreground,
                fontSize: 21,
                fontWeight: FontWeight.w700,
                height: 1.35,
                letterSpacing: -0.42,
              ),
            ),
          ),
        ),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 140),
          child: SingleChildScrollView(
            padding: const EdgeInsets.only(top: 4),
            child: Align(
              alignment: Alignment.topLeft,
              child: IrisMarkdown(
                _body.text,
                compact: true,
                baseStyle: TextStyle(
                  color: context.iris.muted,
                  fontSize: 14.5,
                  height: 1.5,
                ),
                textColor: context.iris.muted,
              ),
            ),
          ),
        ),
        const SizedBox(height: 14),
        Container(
          key: const Key('human-turn-frame'),
          height: 150,
          width: double.infinity,
          decoration: BoxDecoration(
            color: const Color(0xfff7f7f5),
            borderRadius: BorderRadius.circular(16),
          ),
          clipBehavior: Clip.antiAlias,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (widget.previewImage != null || _frame != null)
                widget.previewImage != null
                    ? RawImage(image: widget.previewImage, fit: BoxFit.cover)
                    : Image.memory(_frame!.jpeg, fit: BoxFit.cover)
              else
                const Center(
                  child: IrisIcon('globe', size: 28, color: Color(0xff56717f)),
                ),
              if (previewUrl?.isNotEmpty == true)
                Positioned(
                  right: 8,
                  top: 9,
                  child: Container(
                    height: 26,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: const Color(0xbf0a1620),
                      borderRadius: BorderRadius.circular(13),
                    ),
                    child: Row(
                      children: [
                        const IrisIcon(
                          'lock-simple',
                          size: 12,
                          color: Color(0xffeaf3fa),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          _publicLocation(previewUrl!),
                          style: const TextStyle(
                            color: Color(0xffeaf3fa),
                            fontSize: 12.5,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            IrisButton(
              label: '탭 열기',
              icon: 'globe',
              tone: IrisButtonTone.primary,
              onPressed:
                  _body.tab == null ||
                      !widget.state.supports('browser.frame.watch')
                  ? null
                  : widget.onOpenTab,
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            IrisButton(
              label: '다 했음',
              onPressed: _busy ? null : () => _answer('done'),
            ),
            const SizedBox(width: 10),
            IrisButton(
              label: '못 하겠음',
              onPressed: _busy ? null : () => _answer('unable'),
            ),
          ],
        ),
        if (_result != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              _result!,
              style: TextStyle(color: context.iris.muted, fontSize: 13),
            ),
          ),
      ],
    );
  }
}

String _publicLocation(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null || uri.host.isEmpty) return value;
  return '${uri.host}${uri.path == '/' ? '' : uri.path}';
}

String _relativeTime(int timestamp) {
  final minutes = ((DateTime.now().millisecondsSinceEpoch - timestamp) / 60000)
      .round();
  return minutes <= 0 ? '방금' : '$minutes분';
}
