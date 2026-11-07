import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/terminal_chrome.dart';
import 'package:iris_remote/design/terminal_grid.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/agent_screen.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/screens/terminal_question_card.dart';
import 'package:iris_remote/state/remote_state.dart';

// 화면에 보이는 터미널의 에이전트 표시. 알림 억제가 읽는 자리
class TerminalAgentMarker extends StatelessWidget {
  const TerminalAgentMarker({
    required this.agentRef,
    required this.child,
    super.key,
  });

  final String agentRef;
  final Widget child;

  @override
  Widget build(BuildContext context) => child;
}

class TerminalScreen extends StatefulWidget {
  const TerminalScreen({
    required this.state,
    required this.agentRef,
    this.onOpenBrowser,
    this.onOpenChat,
    this.githubFailed = false,
    super.key,
  });

  final RemoteState state;
  final String agentRef;
  final VoidCallback? onOpenBrowser;
  // 없으면 이 에이전트의 대화 화면으로 교체
  final VoidCallback? onOpenChat;
  final bool githubFailed;

  @override
  State<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends State<TerminalScreen> {
  late String _agentRef;
  StreamSubscription<TerminalFrame>? _frames;
  TerminalKeys? _keys;
  String _screen = '';
  int? _columns;
  int? _rows;
  String? _hash;
  TerminalScrollback? _history;
  bool _loadingHistory = false;
  bool _mouseMode = false;
  Offset _lastPoint = Offset.zero;
  double _cellWidth = 1, _cellHeight = 1;
  bool _dragging = false;
  Future<void> _mouseTail = Future<void>.value();
  DateTime _lastMouseSend = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastWheel = DateTime.fromMillisecondsSinceEpoch(0);
  String? _error;
  // 화면 갱신 멈춤 안내: 기존 화면은 유지
  bool _stale = false;
  bool _stick = true;
  final ScrollController _vScroll = ScrollController();
  final FocusNode _inputFocus = FocusNode();
  final TextEditingController _input = TextEditingController();

  @override
  void initState() {
    super.initState();
    _agentRef = widget.agentRef;
    _frames = widget.state.session.terminalFrames.listen((frame) {
      if (mounted && frame.agent == _agentRef) {
        setState(() {
          _screen = frame.text;
          _columns = frame.columns;
          _rows = frame.rows;
          _hash = frame.hash;
          _mouseMode = frame.mouseMode;
          _stale = frame.error == 'terminal-screen-stale';
          _error = frame.error == null || _stale
              ? null
              : terminalErrorMessage(frame.error!);
        });
      }
    });
    _watch();
    _input.addListener(() => setState(() {}));
    if (widget.state.supports('terminal.keys.get')) _loadKeys();
  }

  @override
  void dispose() {
    _frames?.cancel();
    _vScroll.dispose();
    _inputFocus.dispose();
    _input.dispose();
    super.dispose();
  }

  Future<bool> _watch() async {
    try {
      final frame = await widget.state.session.watchTerminal(_agentRef);
      if (mounted && frame.agent == _agentRef) {
        setState(() {
          _screen = frame.text;
          _columns = frame.columns;
          _rows = frame.rows;
          _hash = frame.hash;
          _mouseMode = frame.mouseMode;
          _stale = frame.error == 'terminal-screen-stale';
          _error = frame.error == null || _stale
              ? null
              : terminalErrorMessage(frame.error!);
        });
        return frame.error == null;
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
    return false;
  }

  Future<void> _loadKeys() async {
    try {
      final value = await widget.state.session.terminalKeys();
      if (mounted) setState(() => _keys = value);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  Future<void> _sendText() async {
    if (_input.text.isEmpty || !widget.state.supports('terminal.input')) return;
    try {
      await widget.state.session.inputTerminal(_agentRef, _input.text);
      if (mounted) {
        setState(() {
          _history = null;
          _stick = true;
          _input.clear();
        });
        _say('보냈습니다', error: false);
      }
    } on Object catch (error) {
      _say(
        error is RemoteFailure
            ? error.message
            : error is ProtocolException
            ? error.message
            : '컴퓨터와 연결이 끊겼습니다.',
      );
    }
  }

  Future<void> _pressKey(TerminalKeyButton key) async {
    if (!widget.state.supports('terminal.key')) return;
    try {
      for (final step in key.steps) {
        await widget.state.session.keyTerminal(
          _agentRef,
          step.key,
          step.modifiers,
        );
      }
      _say('보냈습니다', error: false);
    } on RemoteFailure catch (error) {
      _say(error.message);
    }
  }

  void _selectAgent(RemoteAgent agent) {
    if (agent.ref == _agentRef) return;
    setState(() {
      _agentRef = agent.ref;
      _screen = '';
      _columns = _rows = null;
      _hash = null;
      _history = null;
      _stick = true;
      _error = null;
      _stale = false;
    });
    _watch();
  }

  void _say(String message, {bool error = true}) {
    if (!mounted) return;
    showIrisToast(
      context,
      message,
      tone: error ? IrisToastTone.error : IrisToastTone.ok,
    );
  }

  void _showLive() {
    setState(() {
      _history = null;
      _stick = true;
    });
  }

  // 한 줄씩 이동 버튼. 마우스 화면은 휠, 그 밖은 스크롤과 기록 불러오기
  void _step(int direction) {
    final columns = _columns, rows = _rows;
    if (columns == null || rows == null) return;
    if (_mouseMode && _history == null) {
      final center = Offset(_cellWidth * columns / 2, _cellHeight * rows / 2);
      _mouseMotion('wheel', center, dy: direction);
      return;
    }
    if (!_vScroll.hasClients) return;
    if (_stick) setState(() => _stick = false);
    final position = _vScroll.position;
    if (direction < 0 && position.pixels <= 1) {
      if (_history == null) unawaited(_loadScrollback());
      return;
    }
    unawaited(
      _vScroll.animateTo(
        (position.pixels + direction * _cellHeight).clamp(
          position.minScrollExtent,
          position.maxScrollExtent,
        ),
        duration: const Duration(milliseconds: 120),
        curve: irisEase,
      ),
    );
  }

  Widget _sessionTabs(RemoteAgent agent, List<RemoteAgent> agents) {
    return SizedBox(
      key: const Key('terminal-sessions'),
      height: 56,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
        itemCount: agents.length + 1,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, index) {
          if (index == agents.length) {
            return TerminalSessionChip(
              leading: IrisIcon(
                'terminal-window',
                size: 14,
                color: context.iris.muted,
              ),
              label: 'shell',
              selected: false,
              onPressed: null,
            );
          }
          final other = agents[index];
          return TerminalSessionChip(
            key: Key('terminal-session-${other.ref}'),
            leading: IrisStatusDot(
              status: other.question ? 'question' : other.status,
              size: 9,
            ),
            label: other.name,
            selected: other.ref == agent.ref,
            onPressed: () => _selectAgent(other),
          );
        },
      ),
    );
  }

  // 더 보기 시트: GitHub, 내 키
  Future<void> _openMore(RemoteAgent agent, {required bool canGitHub}) async {
    final colors = context.iris;
    Widget row(
      String icon,
      String label,
      VoidCallback onTap, {
      required Key key,
      bool alert = false,
    }) => InkWell(
      key: key,
      onTap: onTap,
      child: Container(
        height: 52,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Row(
          children: [
            IrisIcon(icon, size: 22, color: colors.foreground2),
            const SizedBox(width: 14),
            Expanded(child: Text(label, style: const TextStyle(fontSize: 16))),
            if (alert)
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: colors.blocked,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
          ],
        ),
      ),
    );
    await showIrisSheet<void>(
      context: context,
      horizontalPadding: 0,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(spaced: true),
          if (canGitHub)
            row(
              'github-logo',
              'GitHub',
              () {
                Navigator.of(sheetContext).pop();
                showSourceControlSheet(
                  context: context,
                  session: widget.state.session,
                  agent: agent,
                );
              },
              key: const Key('terminal-more-github'),
              alert: widget.githubFailed,
            ),
          if (_keys != null)
            row('keyboard', '내 키', () {
              Navigator.of(sheetContext).pop();
              _openKeys();
            }, key: const Key('terminal-more-keys')),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  void _openChat() {
    unawaited(
      Navigator.of(context).pushReplacement<void, void>(
        MaterialPageRoute(
          builder: (_) => AgentScreen(state: widget.state, agentRef: _agentRef),
        ),
      ),
    );
  }

  Future<void> _openBrowser() async {
    final tab = await widget.state.browserTabForAgent(_agentRef);
    if (!mounted) return;
    if (tab == null) {
      showIrisToast(
        context,
        '이 스페이스에 브라우저 탭이 없습니다.',
        tone: IrisToastTone.error,
      );
      return;
    }
    await Navigator.of(context).pushReplacement<void, void>(
      MaterialPageRoute(
        builder: (_) => BrowserScreen(
          state: widget.state,
          agentRef: _agentRef,
          tabRef: tab.ref,
          onOpenTerminal: () =>
              Navigator.of(context).pushReplacement<void, void>(
                MaterialPageRoute(
                  builder: (_) =>
                      TerminalScreen(state: widget.state, agentRef: _agentRef),
                ),
              ),
        ),
      ),
    );
  }

  Widget _appBar(RemoteAgent agent) {
    final colors = context.iris;
    final canBrowser = widget.state.supports('browser.tabs');
    final canGitHub =
        agent.kind != 'terminal' &&
        (widget.state.supports('git.changes') ||
            widget.state.supports('github.pr'));
    return SizedBox(
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        child: Row(
          children: [
            TerminalIconButton(
              key: const Key('session-back'),
              icon: 'arrow-left',
              tooltip: '뒤로',
              onPressed: () => Navigator.of(context).pop(),
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '터미널',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        height: 22 / 17,
                      ),
                    ),
                    Text(
                      _columns == null
                          ? agent.name
                          : '${agent.name} · ${_history?.columns ?? _columns}열',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        height: 18 / 12.5,
                        color: colors.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (agent.kind != 'terminal')
              TerminalIconButton(
                key: const Key('session-chat'),
                icon: 'chat-circle-dots',
                tooltip: '대화로 이동',
                onPressed: widget.onOpenChat ?? _openChat,
              ),
            if (canBrowser)
              TerminalIconButton(
                key: const Key('session-browser'),
                icon: 'globe',
                tooltip: '브라우저로 이동',
                onPressed:
                    widget.onOpenBrowser ?? () => unawaited(_openBrowser()),
              ),
            if (canGitHub || _keys != null)
              TerminalIconButton(
                key: const Key('terminal-more'),
                icon: 'dots-three',
                tooltip: '더 보기',
                onPressed: () => _openMore(agent, canGitHub: canGitHub),
              ),
          ],
        ),
      ),
    );
  }

  Widget _screenArea(RemoteAgent agent, bool asking) {
    final colors = context.iris;
    final terminalColors = TerminalColors(
      foreground: colors.terminalFg,
      background: colors.terminal,
      dim: colors.termDim,
      red: colors.termRed,
      green: colors.termGreen,
      yellow: colors.termYellow,
      blue: colors.termBlue,
      cyan: colors.termCyan,
      cursor: colors.termSelection,
    );
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.terminal,
        border: Border.symmetric(
          horizontal: BorderSide(color: colors.separator),
        ),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          Widget message(String text) => Center(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(
                text,
                textAlign: TextAlign.center,
                style: TextStyle(color: colors.muted),
              ),
            ),
          );
          final Widget body;
          final columns = _history?.columns ?? _columns;
          final rows = _history?.lineCount ?? _rows;
          if (_error != null) {
            body = message(_error!);
          } else if (_columns == null || _rows == null) {
            body = message('터미널 화면 크기를 확인할 수 없습니다. 다시 연결하세요.');
          } else if (columns! * rows! > 262144) {
            body = message('터미널 화면이 너무 커 표시할 수 없습니다.');
          } else {
            body = _grid(constraints, columns, rows, terminalColors);
          }
          return Stack(
            children: [
              Positioned.fill(child: body),
              if (_stale && _error == null)
                Positioned(
                  left: 12,
                  right: 12,
                  bottom: 10,
                  child: IrisFadeIn(
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 8,
                      ),
                      decoration: BoxDecoration(
                        color: colors.level3,
                        borderRadius: BorderRadius.circular(IrisRadius.card),
                      ),
                      child: Text(
                        terminalErrorMessage('terminal-screen-stale'),
                        key: const Key('terminal-stale-notice'),
                        style: TextStyle(
                          color: colors.foreground2,
                          fontSize: 13,
                        ),
                      ),
                    ),
                  ),
                ),
              if (asking)
                const Positioned(
                  left: 12,
                  top: 10,
                  child: TerminalDetectChip(),
                ),
              Positioned(
                right: 8,
                top: 8,
                child: Opacity(
                  opacity: .92,
                  child: Column(
                    children: [
                      TerminalIconButton(
                        key: const Key('terminal-line-up'),
                        tooltip: '한 줄 위로',
                        background: colors.level2,
                        ring: true,
                        onPressed: () => _step(-1),
                        child: RotatedBox(
                          quarterTurns: 2,
                          child: IrisIcon(
                            'caret-down',
                            size: 20,
                            color: colors.foreground2,
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      TerminalIconButton(
                        key: const Key('terminal-line-down'),
                        tooltip: '한 줄 아래로',
                        background: colors.level2,
                        ring: true,
                        onPressed: () => _step(1),
                        child: IrisIcon(
                          'caret-down',
                          size: 20,
                          color: colors.foreground2,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _grid(
    BoxConstraints constraints,
    int columns,
    int rows,
    TerminalColors terminalColors,
  ) {
    final width = constraints.maxWidth - 24;
    final gridWidth = width;
    final mouseEnabled = _mouseMode && _history == null;
    final fontSize = terminalFontSize(gridWidth, columns, max: 16);
    _cellWidth = gridWidth / columns;
    _cellHeight = fontSize * 1.42;
    final grid = parseTerminalGrid(
      _history?.text ?? _screen,
      columns: columns,
      rows: rows,
      colors: terminalColors,
    );
    // 실시간 화면은 마지막으로 글자가 있는 줄이 아래 끝에 오도록 따라감
    final lastRow = grid.cells.lastIndexWhere(
      (row) => row.any((cell) => cell.value.trim().isNotEmpty),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_stick || _history != null || !_vScroll.hasClients) {
        return;
      }
      final position = _vScroll.position;
      final target =
          (8 + (lastRow + 1) * _cellHeight - constraints.maxHeight + 8).clamp(
            position.minScrollExtent,
            position.maxScrollExtent,
          );
      if ((position.pixels - target).abs() > 1) _vScroll.jumpTo(target);
    });
    return NotificationListener<ScrollNotification>(
      onNotification: (notice) {
        if (notice.metrics.axis != Axis.vertical) return false;
        if (notice is ScrollUpdateNotification && notice.dragDetails != null) {
          final follow =
              notice.metrics.pixels >= notice.metrics.maxScrollExtent - 4;
          if (follow != _stick) {
            _stick = follow;
            // 스크롤 알림은 레이아웃 중일 수 있어 다음 프레임에 표시를 갱신
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) setState(() {});
            });
          }
        }
        if (!_mouseMode &&
            _history == null &&
            (notice is OverscrollNotification && notice.overscroll < 0 ||
                notice is ScrollUpdateNotification &&
                    notice.metrics.pixels < notice.metrics.minScrollExtent)) {
          unawaited(_loadScrollback());
        }
        return false;
      },
      child: SingleChildScrollView(
        controller: _vScroll,
        physics: mouseEnabled
            ? const NeverScrollableScrollPhysics()
            : const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight - 16),
          child: Align(
            alignment: Alignment.bottomLeft,
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              physics: const NeverScrollableScrollPhysics(),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (detail) => _lastPoint = detail.localPosition,
                onDoubleTapDown: mouseEnabled
                    ? (detail) => _lastPoint = detail.localPosition
                    : null,
                onTap: () => mouseEnabled
                    ? _mouse('click', _lastPoint)
                    : _selectAt(_lastPoint),
                onDoubleTap: mouseEnabled
                    ? () => _mouse('double', _lastPoint)
                    : null,
                onLongPressStart: (detail) {
                  _lastPoint = detail.localPosition;
                  _dragging = false;
                },
                onLongPressMoveUpdate: mouseEnabled
                    ? (detail) {
                        if (!_dragging) {
                          _dragging = true;
                          unawaited(_mouse('down', _lastPoint));
                        }
                        _lastPoint = detail.localPosition;
                        _mouseMotion('drag', _lastPoint);
                      }
                    : null,
                onLongPressEnd: (detail) {
                  if (_dragging) {
                    unawaited(_mouse('up', detail.localPosition));
                    _dragging = false;
                  } else {
                    unawaited(_copyScreen(grid));
                  }
                },
                onPanUpdate: mouseEnabled
                    ? (detail) {
                        if (detail.delta.dy == 0) return;
                        _mouseMotion(
                          'wheel',
                          detail.localPosition,
                          dy: -detail.delta.dy.sign.toInt(),
                        );
                      }
                    : null,
                child: Semantics(
                  label: grid.plainText,
                  child: CustomPaint(
                    key: const Key('terminal-output'),
                    size: Size(gridWidth, rows * _cellHeight),
                    painter: TerminalGridPainter(
                      grid,
                      fontSize,
                      cursorColor: terminalColors.cursor,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _controls(RemoteAgent agent) {
    final colors = context.iris;
    final canInput = widget.state.supports('terminal.input');
    final row =
        _keys?.keys.take(5).toList(growable: false) ??
        const <TerminalKeyButton>[];
    final more =
        (_keys?.keys.length ?? 0) > 5 ||
        widget.state.supports('terminal.keys.set');
    final hasText = _input.text.isNotEmpty;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
          child: Row(
            children: [
              Expanded(
                child: TerminalSegment(
                  selected: _history == null && _stick ? 0 : 1,
                  items: [
                    TerminalSegmentItem(
                      label: '자동 따라가기',
                      leading: Container(
                        width: 7,
                        height: 7,
                        decoration: BoxDecoration(
                          color: colors.teal,
                          shape: BoxShape.circle,
                        ),
                      ),
                      onPressed: _showLive,
                    ),
                    TerminalSegmentItem(
                      label: '기록 보기',
                      leading: IrisIcon(
                        'clock-counter-clockwise',
                        size: 16,
                        color: _history == null
                            ? colors.muted
                            : colors.foreground,
                      ),
                      onPressed: widget.state.supports('terminal.scrollback')
                          ? () {
                              if (_history == null) _loadScrollback();
                            }
                          : null,
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              TerminalIconButton(
                key: const Key('terminal-open-keyboard'),
                icon: 'keyboard',
                size: 20,
                tooltip: '키 입력 열기',
                background: colors.level2,
                onPressed: canInput ? _inputFocus.requestFocus : null,
              ),
            ],
          ),
        ),
        if (row.isNotEmpty)
          Padding(
            key: const Key('terminal-key-row'),
            padding: const EdgeInsets.fromLTRB(8, 6, 8, 4),
            child: Row(
              children: [
                for (final (index, key) in row.indexed) ...[
                  if (index > 0) const SizedBox(width: 5),
                  Expanded(
                    flex: key.key == '/compact' ? 2 : 1,
                    child: TerminalKeyCap(
                      label: key.label,
                      onPressed: () => _pressKey(key),
                    ),
                  ),
                ],
                if (more) ...[
                  const SizedBox(width: 5),
                  Expanded(
                    child: TerminalKeyCap(
                      icon: 'dots-three',
                      tooltip: '키 더 보기',
                      onPressed: _openKeys,
                    ),
                  ),
                ],
              ],
            ),
          ),
        Padding(
          key: const Key('terminal-composer'),
          padding: EdgeInsets.fromLTRB(8, 4, 8, 8 + irisBottomInset(context)),
          child: Row(
            children: [
              Expanded(
                child: Container(
                  height: 44,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(
                    color: colors.level1,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: colors.line2),
                  ),
                  child: Row(
                    children: [
                      if (hasText) ...[
                        Text(
                          '❯',
                          style: TextStyle(
                            fontFamily: 'monospace',
                            fontSize: 14,
                            color: colors.termGreen,
                          ),
                        ),
                        const SizedBox(width: 8),
                      ],
                      Expanded(
                        child: TextField(
                          key: const Key('terminal-input'),
                          controller: _input,
                          focusNode: _inputFocus,
                          enabled: canInput,
                          style: TextStyle(
                            color: colors.foreground,
                            fontFamily: 'monospace',
                            fontSize: 14,
                          ),
                          cursorColor: colors.strong,
                          decoration: InputDecoration(
                            hintText: '명령 입력',
                            hintStyle: TextStyle(
                              color: colors.muted,
                              fontFamily: 'monospace',
                              fontSize: 14,
                            ),
                            isCollapsed: true,
                            filled: false,
                            border: InputBorder.none,
                            enabledBorder: InputBorder.none,
                            focusedBorder: InputBorder.none,
                            disabledBorder: InputBorder.none,
                          ),
                          onSubmitted: (_) => _sendText(),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (hasText) ...[
                const SizedBox(width: 6),
                TerminalRunButton(onPressed: canInput ? _sendText : null),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _assist(RemoteAgent agent, List<RemoteRequest> questions) {
    Widget nav(String label, String key) => Expanded(
      child: TerminalKeyCap(
        label: label,
        onPressed: () => _pressKey(
          TerminalKeyButton(
            id: 'nav-${key.toLowerCase()}',
            label: label,
            key: key,
            modifiers: const KeyModifiers(),
          ),
        ),
      ),
    );
    return ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .5,
      ),
      child: TerminalAssistPanel(
        bottomInset: irisBottomInset(context),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  children: [
                    for (final question in questions)
                      TerminalQuestionCard(
                        request: question,
                        agentName: agent.name,
                        session: widget.state.supports('terminal.select')
                            ? widget.state.session
                            : null,
                        onOpen: () {
                          _watch();
                        },
                      ),
                  ],
                ),
              ),
            ),
            Padding(
              key: const Key('terminal-nav-keys'),
              padding: const EdgeInsets.only(top: 10),
              child: Row(
                children: [
                  nav('↑', 'ArrowUp'),
                  const SizedBox(width: 6),
                  nav('↓', 'ArrowDown'),
                  const SizedBox(width: 6),
                  nav('Enter', 'Enter'),
                  const SizedBox(width: 6),
                  nav('Esc', 'Escape'),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final agent = widget.state.agent(_agentRef);
        if (agent == null) {
          return const Scaffold(body: Center(child: Text('에이전트를 찾을 수 없습니다.')));
        }
        final agents = widget.state.agents
            .where((item) => item.space == agent.space)
            .toList(growable: false);
        final questions = widget.state.terminalQuestions
            .where((q) => q.agent == _agentRef)
            .toList(growable: false);
        return TerminalAgentMarker(
          agentRef: _agentRef,
          child: Scaffold(
            backgroundColor: context.iris.background,
            body: SafeArea(
              bottom: false,
              child: Column(
                children: [
                  _appBar(agent),
                  _sessionTabs(agent, agents),
                  Expanded(child: _screenArea(agent, questions.isNotEmpty)),
                  if (questions.isNotEmpty)
                    _assist(agent, questions)
                  else
                    _controls(agent),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _loadScrollback() async {
    if (_loadingHistory || !widget.state.supports('terminal.scrollback')) {
      return;
    }
    _loadingHistory = true;
    final agent = _agentRef;
    try {
      final value = await widget.state.session.terminalScrollback(agent);
      if (mounted && _agentRef == agent) {
        setState(() {
          _history = value;
          _stick = false;
        });
      }
    } on RemoteFailure catch (error) {
      _say(error.message);
    } finally {
      _loadingHistory = false;
    }
  }

  void _mouseMotion(String action, Offset point, {int? dy}) {
    final now = DateTime.now();
    if (now.difference(_lastWheel).inMilliseconds < 150) return;
    _lastWheel = now;
    unawaited(_mouse(action, point, dy: dy));
  }

  Future<void> _mouse(String action, Offset point, {int? dy}) {
    if (_history != null ||
        !_mouseMode ||
        !widget.state.supports('terminal.mouse') ||
        _hash == null ||
        _columns == null ||
        _rows == null) {
      return Future<void>.value();
    }
    final agent = _agentRef, hash = _hash!, columns = _columns!, rows = _rows!;
    final cell = terminalCellAt(point, _cellWidth, _cellHeight, columns, rows);
    final next = _mouseTail.then((_) async {
      final elapsed = DateTime.now().difference(_lastMouseSend);
      if (elapsed < const Duration(milliseconds: 120)) {
        await Future<void>.delayed(const Duration(milliseconds: 120) - elapsed);
      }
      if (!mounted || _agentRef != agent || _history != null) return;
      _lastMouseSend = DateTime.now();
      try {
        await widget.state.session.mouseTerminal(
          agent,
          hash,
          columns,
          rows,
          cell.column,
          cell.row,
          action,
          dy: dy,
        );
      } on RemoteFailure catch (error) {
        _say(error.message);
        final refreshed = await _watch();
        // 뗌 실패 뒤 최신 화면에서 한 번만 해제
        if (action == 'up' &&
            refreshed &&
            mounted &&
            _agentRef == agent &&
            _mouseMode &&
            _hash != null &&
            _columns != null &&
            _rows != null) {
          await Future<void>.delayed(const Duration(milliseconds: 120));
          final latest = terminalCellAt(
            point,
            _cellWidth,
            _cellHeight,
            _columns!,
            _rows!,
          );
          try {
            await widget.state.session.mouseTerminal(
              agent,
              _hash!,
              _columns!,
              _rows!,
              latest.column,
              latest.row,
              'up',
            );
          } on RemoteFailure catch (error) {
            _say(error.message);
          }
        }
      }
    });
    _mouseTail = next.catchError((Object _) {});
    return next;
  }

  Future<void> _selectAt(Offset point) async {
    if (_history != null ||
        !widget.state.supports('terminal.select') ||
        _hash == null ||
        _columns == null ||
        _rows == null) {
      return;
    }
    final cell = terminalCellAt(
      point,
      _cellWidth,
      _cellHeight,
      _columns!,
      _rows!,
    );
    try {
      await widget.state.session.selectTerminal(
        _agentRef,
        _hash!,
        _columns!,
        _rows!,
        cell.row,
      );
    } on RemoteFailure catch (error) {
      _say(error.message);
      await _watch();
    }
  }

  Future<void> _copyScreen(TerminalGrid grid) async {
    await showIrisSheet<void>(
      context: context,
      builder: (sheetContext) => SizedBox(
        height: 420,
        child: Column(
          children: [
            const IrisSheetGrabber(),
            Row(
              children: [
                TextButton(
                  onPressed: () async {
                    await Clipboard.setData(
                      ClipboardData(text: grid.plainText),
                    );
                    if (sheetContext.mounted) Navigator.of(sheetContext).pop();
                  },
                  child: const Text('전체 복사'),
                ),
                if (_mouseMode && widget.state.supports('terminal.mouse'))
                  TextButton(
                    onPressed: () {
                      Navigator.of(sheetContext).pop();
                      unawaited(_mouse('context', _lastPoint));
                    },
                    child: const Text('오른쪽 클릭'),
                  ),
              ],
            ),
            Expanded(
              child: SingleChildScrollView(
                child: SelectableText(grid.plainText),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openKeys() async {
    final keys = _keys;
    if (keys == null) return;
    await showIrisSheet<void>(
      context: context,
      builder: (sheetContext) => SizedBox(
        height: 430,
        child: Column(
          children: [
            const IrisSheetGrabber(),
            const SizedBox(height: 14),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    '내 키',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                  ),
                ),
                if (widget.state.supports('terminal.keys.set'))
                  TextButton(
                    onPressed: () {
                      Navigator.of(sheetContext).pop();
                      _openSettings();
                    },
                    child: Text(
                      '편집',
                      style: TextStyle(color: context.iris.link, fontSize: 15),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            Expanded(
              child: GridView.count(
                crossAxisCount: 4,
                mainAxisSpacing: 6,
                crossAxisSpacing: 6,
                children: [
                  for (final key in keys.keys)
                    _TerminalKey(
                      keyButton: key,
                      onPressed: () => _pressKey(key),
                    ),
                  if (widget.state.supports('terminal.keys.set'))
                    _TerminalKey(
                      icon: 'plus',
                      subtitle: '키 추가',
                      onPressed: () {
                        Navigator.of(sheetContext).pop();
                        _addKey();
                      },
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _openSettings() async {
    final keys = _keys;
    if (keys == null) return;
    final changed = await Navigator.of(context).push<List<TerminalKeyButton>>(
      MaterialPageRoute(
        builder: (_) => TerminalKeySettingsScreen(
          macName: widget.state.macName,
          keys: keys.keys,
          onAdd: _showKeyEditor,
        ),
      ),
    );
    if (changed != null) await _saveKeys(changed);
  }

  Future<void> _addKey() async {
    final key = await _showKeyEditor(context);
    if (key != null) await _saveKeys([...?_keys?.keys, key]);
  }

  Future<TerminalKeyButton?> _showKeyEditor(BuildContext context) =>
      showIrisSheet<TerminalKeyButton>(
        context: context,
        builder: (_) => const TerminalKeyEditorSheet(),
      );

  Future<void> _saveKeys(List<TerminalKeyButton> keys) async {
    try {
      final result = await widget.state.session.setTerminalKeys(keys);
      if (mounted) setState(() => _keys = result);
    } on Object catch (error) {
      _say(
        error is RemoteFailure
            ? error.message
            : error is ProtocolException
            ? error.message
            : '컴퓨터와 연결이 끊겼습니다.',
      );
    }
  }
}

class _TerminalKey extends StatelessWidget {
  const _TerminalKey({
    this.keyButton,
    this.icon,
    this.subtitle,
    required this.onPressed,
  });
  final TerminalKeyButton? keyButton;
  final String? icon;
  final String? subtitle;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 48,
    child: TextButton(
      onPressed: onPressed,
      style: ButtonStyle(
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 4),
        ),
        backgroundColor: WidgetStatePropertyAll(context.iris.level2),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        ),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (icon != null)
            IrisIcon(icon!, size: 18)
          else
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                _keyDescription(keyButton!),
                maxLines: 1,
                softWrap: false,
                style: TextStyle(
                  color: context.iris.foreground,
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          if (subtitle != null || keyButton != null)
            Text(
              subtitle ?? keyButton!.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: context.iris.muted,
                fontSize: 10.5,
                fontWeight: FontWeight.w400,
              ),
            ),
        ],
      ),
    ),
  );
}

String _keyDescription(TerminalKeyButton key) {
  if (const {'enter', 'clear', 'status'}.contains(key.id)) {
    return '${key.key} ⏎';
  }
  final name = switch (key.key) {
    'Escape' => 'esc',
    'Tab' => key.modifiers.shift ? '⇥' : 'tab',
    'ArrowUp' => '↑',
    'ArrowDown' => '↓',
    'ArrowLeft' => '←',
    'ArrowRight' => '→',
    'Enter' => '⏎',
    final value when key.modifiers.ctrl => value.toUpperCase(),
    final value => value,
  };
  final parts = <String>[
    if (key.modifiers.ctrl) '⌃',
    if (key.modifiers.alt) '⌥',
    if (key.modifiers.shift) '⇧',
    if (key.modifiers.cmd) '⌘',
    name,
  ];
  return parts.join();
}

class TerminalKeySettingsScreen extends StatefulWidget {
  const TerminalKeySettingsScreen({
    required this.macName,
    required this.keys,
    required this.onAdd,
    this.otherMacNames = const [],
    this.initiallyEditing = false,
    super.key,
  });
  final String macName;
  final List<TerminalKeyButton> keys;
  final Future<TerminalKeyButton?> Function(BuildContext context) onAdd;
  final List<String> otherMacNames;
  final bool initiallyEditing;

  @override
  State<TerminalKeySettingsScreen> createState() =>
      _TerminalKeySettingsScreenState();
}

class _TerminalKeySettingsScreenState extends State<TerminalKeySettingsScreen> {
  late final List<TerminalKeyButton> _keys = [...widget.keys];
  late bool _editing = widget.initiallyEditing;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      bottom: false,
      child: Column(
        children: [
          SizedBox(
            key: const Key('key-settings-header'),
            height: 58,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SizedBox(width: 12),
                IrisRoundButton(
                  icon: 'caret-left',
                  tooltip: '뒤로',
                  onPressed: () => Navigator.of(context).pop(_keys),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    children: [
                      const Text(
                        '내 키',
                        style: TextStyle(
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        '터미널 키 줄',
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 60),
              ],
            ),
          ),
          if (!_editing)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Container(
                key: const Key('key-host'),
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: context.iris.level1,
                  borderRadius: BorderRadius.circular(14),
                ),
                padding: const EdgeInsets.all(4),
                child: Row(
                  children: [
                    for (final entry in [
                      widget.macName,
                      ...widget.otherMacNames,
                    ].indexed) ...[
                      if (entry.$1 > 0) const SizedBox(width: 4),
                      Expanded(
                        child: Container(
                          height: 36,
                          decoration: BoxDecoration(
                            color: entry.$2 == widget.macName
                                ? context.iris.level3
                                : Colors.transparent,
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const IrisIcon('monitor', size: 15),
                              const SizedBox(width: 7),
                              Text(
                                entry.$2,
                                style: TextStyle(
                                  color: entry.$2 == widget.macName
                                      ? context.iris.foreground
                                      : context.iris.muted,
                                  fontSize: 14.5,
                                  fontWeight: entry.$2 == widget.macName
                                      ? FontWeight.w600
                                      : FontWeight.w400,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          if (!_editing)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: context.iris.level1,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    IrisIcon('keyboard', size: 18, color: context.iris.muted),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text.rich(
                        TextSpan(
                          children: [
                            const TextSpan(text: '키 줄은 '),
                            TextSpan(
                              text: '컴퓨터마다 따로',
                              style: TextStyle(
                                color: context.iris.foreground2,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const TextSpan(
                              text: ' 저장합니다. 컴퓨터의 키 설정이 다르면 그 컴퓨터에 맞는 조합으로 지정해 두세요.',
                            ),
                          ],
                        ),
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13.5,
                          height: 1.5,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (!_editing)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 20.5, 16, 0),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: SizedBox(
                  height: 25,
                  child: Row(
                    children: [
                      Text(
                        '앞줄 · 끌어서 순서 변경',
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        '5 / 6',
                        style: TextStyle(
                          color: context.iris.faint,
                          fontSize: 13.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          if (!_editing)
            Expanded(
              child: ReorderableListView.builder(
                key: const Key('key-settings-list'),
                padding: const EdgeInsets.symmetric(horizontal: 16),
                buildDefaultDragHandles: false,
                itemCount: _keys.length + 1,
                onReorderItem: (oldIndex, newIndex) => setState(() {
                  if (oldIndex >= _keys.length) return;
                  _keys.insert(
                    newIndex.clamp(0, _keys.length),
                    _keys.removeAt(oldIndex),
                  );
                }),
                itemBuilder: (context, index) {
                  if (index == _keys.length) {
                    return Padding(
                      key: const ValueKey('add-key'),
                      padding: EdgeInsets.fromLTRB(
                        0,
                        22,
                        0,
                        irisBottomInset(context),
                      ),
                      child: Row(
                        children: [
                          IrisButton(
                            label: '키 추가',
                            icon: 'plus',
                            onPressed: () async {
                              setState(() => _editing = true);
                              final value = await widget.onAdd(context);
                              if (value != null && mounted) {
                                setState(() => _keys.add(value));
                              }
                              if (mounted) setState(() => _editing = false);
                            },
                          ),
                        ],
                      ),
                    );
                  }
                  final key = _keys[index];
                  final firstInGroup = index == 0 || index == 5;
                  final lastInGroup = index == 4 || index == _keys.length - 1;
                  final row = Container(
                    height: 54,
                    decoration: BoxDecoration(
                      color: context.iris.level1,
                      borderRadius: BorderRadius.vertical(
                        top: firstInGroup
                            ? const Radius.circular(18)
                            : Radius.zero,
                        bottom: lastInGroup
                            ? const Radius.circular(18)
                            : Radius.zero,
                      ),
                      border: lastInGroup
                          ? null
                          : Border(
                              bottom: BorderSide(color: context.iris.separator),
                            ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: Row(
                      children: [
                        ReorderableDragStartListener(
                          index: index,
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(14, 14, 12, 14),
                            child: IrisIcon(
                              'dots-six-vertical',
                              size: 18,
                              color: context.iris.faint,
                            ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            key.label,
                            style: const TextStyle(fontSize: 16),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Container(
                          height: 28,
                          alignment: Alignment.center,
                          padding: const EdgeInsets.symmetric(horizontal: 9),
                          decoration: BoxDecoration(
                            color: context.iris.level2,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            _keyDescription(key),
                            style: TextStyle(
                              color: context.iris.foreground2,
                              fontSize: 15,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 12, right: 14),
                          child: SizedBox.square(
                            dimension: 28,
                            child: IconButton(
                              padding: EdgeInsets.zero,
                              style: IconButton.styleFrom(
                                backgroundColor: context.iris.blocked
                                    .withValues(alpha: 0.16),
                              ),
                              onPressed: () =>
                                  setState(() => _keys.removeAt(index)),
                              icon: IrisIcon(
                                'x',
                                size: 13,
                                color: context.iris.blocked,
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                  return Column(
                    key: ValueKey(key.id),
                    children: [
                      if (index == 5)
                        Padding(
                          padding: const EdgeInsets.fromLTRB(4, 20.5, 4, 0),
                          child: SizedBox(
                            height: 25,
                            child: Row(
                              children: [
                                Text(
                                  '나머지',
                                  style: TextStyle(
                                    color: context.iris.muted,
                                    fontSize: 13.5,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                                const Spacer(),
                                Text(
                                  '더보기에 표시',
                                  style: TextStyle(
                                    color: context.iris.faint,
                                    fontSize: 13.5,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      row,
                    ],
                  );
                },
              ),
            ),
        ],
      ),
    ),
  );
}

class TerminalKeyEditorSheet extends StatefulWidget {
  const TerminalKeyEditorSheet({
    this.initialName = '',
    this.initialKey = '',
    this.initialCtrl = false,
    this.macName = '컴퓨터',
    super.key,
  });

  final String initialName;
  final String initialKey;
  final bool initialCtrl;
  final String macName;

  @override
  State<TerminalKeyEditorSheet> createState() => _TerminalKeyEditorSheetState();
}

// 서버가 이름으로 알아보는 키와 화면에 보일 글자
const _namedKeyChoices = <(String, String)>[
  ('Enter', '↵ Enter'),
  ('Escape', 'Esc'),
  ('Tab', 'Tab'),
  ('Backspace', '⌫'),
  ('Delete', '⌦'),
  ('ArrowUp', '↑'),
  ('ArrowDown', '↓'),
  ('ArrowLeft', '←'),
  ('ArrowRight', '→'),
  ('Home', 'Home'),
  ('End', 'End'),
  ('PageUp', 'PgUp'),
  ('PageDown', 'PgDn'),
];
const _letterKeyChoices = 'abcdefghijklmnopqrstuvwxyz';
const _digitKeyChoices = '0123456789';
const _symbolKeyChoices =
    r'/-=[]\;,.'
    "'";

String _keyShown(String key) {
  for (final (name, shown) in _namedKeyChoices) {
    if (name == key) return shown;
  }
  return key.length == 1 ? key.toUpperCase() : key;
}

String _modifierMarks(KeyModifiers modifiers) =>
    '${modifiers.ctrl ? '⌃' : ''}${modifiers.alt ? '⌥' : ''}'
    '${modifiers.shift ? '⇧' : ''}${modifiers.cmd ? '⌘' : ''}';

String _stepShown(TerminalKeyStep step) =>
    '${_modifierMarks(step.modifiers)}${_keyShown(step.key)}';

String _stepNamed(TerminalKeyStep step) =>
    '${[if (step.modifiers.ctrl) 'Control', if (step.modifiers.alt) 'Option', if (step.modifiers.shift) 'Shift', if (step.modifiers.cmd) 'Command'].map((name) => '$name + ').join()}'
    '${_keyShown(step.key)}';

class _TerminalKeyEditorSheetState extends State<TerminalKeyEditorSheet> {
  static const _maxSteps = 8;
  late final _name = TextEditingController(text: widget.initialName);
  late final _text = TextEditingController(
    text:
        widget.initialKey.length > 1 &&
            !_namedKeyChoices.any((choice) => choice.$1 == widget.initialKey)
        ? widget.initialKey
        : '',
  );
  late final List<TerminalKeyStep> _steps =
      _text.text.isNotEmpty || widget.initialKey.isEmpty
      ? []
      : [
          TerminalKeyStep(
            key: widget.initialKey,
            modifiers: KeyModifiers(ctrl: widget.initialCtrl),
          ),
        ];
  late bool _asText = _text.text.isNotEmpty;
  // 다음에 고를 키에 붙을 보조키
  late bool _ctrl = _steps.isEmpty && widget.initialCtrl;
  bool _alt = false;
  bool _shift = false;
  bool _cmd = false;

  @override
  void initState() {
    super.initState();
    _name.addListener(_refresh);
    _text.addListener(_refresh);
  }

  void _refresh() => setState(() {});

  @override
  void dispose() {
    _name.dispose();
    _text.dispose();
    super.dispose();
  }

  void _addStep(String key) {
    if (_steps.length >= _maxSteps) return;
    setState(() {
      _steps.add(
        TerminalKeyStep(
          key: key,
          modifiers: KeyModifiers(
            ctrl: _ctrl,
            alt: _alt,
            shift: _shift,
            cmd: _cmd,
          ),
        ),
      );
      _ctrl = _alt = _shift = _cmd = false;
    });
  }

  bool get _hasSent => _asText ? _text.text.isNotEmpty : _steps.isNotEmpty;

  // 이름을 비워 두면 고른 키들이 이름이 된다
  String get _autoName =>
      _asText ? _text.text : _steps.map(_stepShown).join(' ');

  String get _label {
    final typed = _name.text.trim();
    final value = typed.isEmpty ? _autoName : typed;
    return value.length > 24 ? value.substring(0, 24) : value;
  }

  bool get _ready => _hasSent && _label.isNotEmpty;

  String get _sentSummary => !_hasSent
      ? '고른 키'
      : _asText
      ? _text.text
      : _steps.map(_stepNamed).join(' → ');

  @override
  Widget build(BuildContext context) => Column(
    key: const Key('key-editor-sheet'),
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const IrisSheetGrabber(),
      const SizedBox(height: 14),
      SizedBox(
        height: 36,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '키 추가',
                  style: TextStyle(
                    color: context.iris.foreground,
                    fontSize: 19,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                height: 36,
                child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  style: const ButtonStyle(
                    minimumSize: WidgetStatePropertyAll(Size.zero),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    padding: WidgetStatePropertyAll(
                      EdgeInsets.symmetric(horizontal: 6),
                    ),
                  ),
                  child: Text(
                    '취소',
                    style: TextStyle(
                      color: context.iris.link,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      Container(
        margin: const EdgeInsets.only(top: 10),
        height: 44,
        padding: const EdgeInsets.all(4),
        decoration: BoxDecoration(
          color: context.iris.background,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            _Choice(
              label: '키 조합',
              selected: !_asText,
              onTap: () => setState(() => _asText = false),
            ),
            const SizedBox(width: 4),
            _Choice(
              label: '글자 입력',
              selected: _asText,
              onTap: () => setState(() => _asText = true),
            ),
          ],
        ),
      ),
      if (_asText)
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: SizedBox(
            height: 52,
            width: double.infinity,
            child: TextField(
              key: const Key('key-value-input'),
              controller: _text,
              maxLength: 24,
              decoration: InputDecoration(
                hintText: '보낼 글자 (예: /compact)',
                hintStyle: TextStyle(color: context.iris.muted, fontSize: 16),
                counterText: '',
              ),
            ),
          ),
        )
      else ...[
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Row(
            children: [
              _Modifier(
                '⌃',
                'Ctrl',
                _ctrl,
                () => setState(() => _ctrl = !_ctrl),
              ),
              const SizedBox(width: 8),
              _Modifier('⌥', 'Opt', _alt, () => setState(() => _alt = !_alt)),
              const SizedBox(width: 8),
              _Modifier(
                '⇧',
                'Shift',
                _shift,
                () => setState(() => _shift = !_shift),
              ),
              const SizedBox(width: 8),
              _Modifier('⌘', 'Cmd', _cmd, () => setState(() => _cmd = !_cmd)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: SizedBox(
            key: const Key('key-steps'),
            height: 40,
            child: _steps.isEmpty
                ? Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      '아래에서 누를 키를 차례로 고르세요 (최대 $_maxSteps개)',
                      style: TextStyle(
                        color: context.iris.muted,
                        fontSize: 13.5,
                      ),
                    ),
                  )
                : ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: _steps.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 6),
                    itemBuilder: (context, index) => _StepChip(
                      label: _stepShown(_steps[index]),
                      onRemove: () => setState(() => _steps.removeAt(index)),
                    ),
                  ),
          ),
        ),
        const SizedBox(height: 4),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 168),
          child: SingleChildScrollView(
            key: const Key('key-picker'),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _KeyGroup(
                  title: '특수 키',
                  choices: _namedKeyChoices,
                  onPick: _addStep,
                ),
                _KeyGroup(
                  title: '문자',
                  choices: [
                    for (final c in _letterKeyChoices.split(''))
                      (c, c.toUpperCase()),
                  ],
                  onPick: _addStep,
                ),
                _KeyGroup(
                  title: '숫자·기호',
                  choices: [
                    for (final c
                        in (_digitKeyChoices + _symbolKeyChoices).split(''))
                      (c, c),
                  ],
                  onPick: _addStep,
                ),
              ],
            ),
          ),
        ),
      ],
      const _Label('이름'),
      const SizedBox(height: 8),
      SizedBox(
        height: 52,
        width: double.infinity,
        child: TextField(
          key: const Key('key-name-input'),
          controller: _name,
          maxLength: 24,
          style: const TextStyle(fontSize: 17, height: 1.2),
          decoration: InputDecoration(
            hintText: _autoName.isEmpty ? '비워 두면 고른 키가 이름이 됩니다' : _autoName,
            hintStyle: TextStyle(color: context.iris.muted, fontSize: 16),
            counterText: '',
          ),
        ),
      ),
      const SizedBox(height: 14),
      Container(
        key: const Key('key-preview'),
        height: 76,
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: context.iris.background,
          borderRadius: BorderRadius.circular(14),
        ),
        child: Row(
          children: [
            Container(
              width: 72,
              height: 58,
              padding: const EdgeInsets.symmetric(horizontal: 4),
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    _autoName.isEmpty ? '?' : _autoName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    _label.isEmpty ? '미리 보기' : _label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: context.iris.muted, fontSize: 10.5),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text.rich(
                TextSpan(
                  text: '누르면 ${widget.macName} 터미널로 ',
                  children: [
                    TextSpan(
                      text: _sentSummary,
                      style: TextStyle(
                        color: context.iris.foreground,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    TextSpan(text: _asText ? ' 글자를 보냅니다.' : ' 키를 보냅니다.'),
                  ],
                ),
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      SizedBox(
        width: double.infinity,
        child: IrisButton(
          label: _hasSent ? '추가' : '키를 고르세요',
          tone: IrisButtonTone.primary,
          expand: false,
          onPressed: _ready ? _finish : null,
        ),
      ),
    ],
  );

  void _finish() {
    if (!_ready) return;
    final id = 'custom-${DateTime.now().microsecondsSinceEpoch}';
    if (_asText) {
      Navigator.of(context).pop(
        TerminalKeyButton(
          id: id,
          label: _label,
          key: _text.text,
          modifiers: const KeyModifiers(),
        ),
      );
      return;
    }
    Navigator.of(context).pop(
      TerminalKeyButton(
        id: id,
        label: _label,
        key: _steps.first.key,
        modifiers: _steps.first.modifiers,
        then: _steps.sublist(1),
      ),
    );
  }
}

class _StepChip extends StatelessWidget {
  const _StepChip({required this.label, required this.onRemove});
  final String label;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.only(left: 12, right: 4),
    decoration: BoxDecoration(
      color: context.iris.brand.withValues(alpha: 0.14),
      border: Border.all(color: context.iris.brand, width: 1.2),
      borderRadius: BorderRadius.circular(10),
    ),
    child: Row(
      children: [
        Text(
          label,
          style: TextStyle(
            color: context.iris.brand,
            fontSize: 15,
            fontWeight: FontWeight.w600,
          ),
        ),
        SizedBox(
          width: 32,
          height: 32,
          child: IconButton(
            tooltip: '$label 빼기',
            padding: EdgeInsets.zero,
            onPressed: onRemove,
            icon: Icon(Icons.close, size: 16, color: context.iris.brand),
          ),
        ),
      ],
    ),
  );
}

class _KeyGroup extends StatelessWidget {
  const _KeyGroup({
    required this.title,
    required this.choices,
    required this.onPick,
  });
  final String title;
  final List<(String, String)> choices;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 6),
        child: Text(
          title,
          style: TextStyle(
            color: context.iris.muted,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
      Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final (key, shown) in choices)
            _KeyChip(label: shown, onTap: () => onPick(key)),
        ],
      ),
      const SizedBox(height: 6),
    ],
  );
}

class _KeyChip extends StatelessWidget {
  const _KeyChip({required this.label, required this.onTap});
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 40,
    child: TextButton(
      onPressed: onTap,
      style: ButtonStyle(
        minimumSize: const WidgetStatePropertyAll(Size(44, 40)),
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 10),
        ),
        backgroundColor: WidgetStatePropertyAll(context.iris.level2),
        foregroundColor: WidgetStatePropertyAll(context.iris.foreground),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
      child: Text(
        label,
        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
      ),
    ),
  );
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: 35,
    width: double.infinity,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(4, 18, 4, 0),
      child: Text(
        text,
        style: TextStyle(
          color: context.iris.muted,
          fontSize: 13,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );
}

class _Choice extends StatelessWidget {
  const _Choice({
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Expanded(
    child: TextButton(
      onPressed: onTap,
      style: ButtonStyle(
        backgroundColor: WidgetStatePropertyAll(
          selected ? context.iris.level3 : Colors.transparent,
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: selected ? context.iris.foreground : context.iris.muted,
          fontSize: 14.5,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        ),
      ),
    ),
  );
}

class _Modifier extends StatelessWidget {
  const _Modifier(this.symbol, this.name, this.selected, this.onTap);
  final String symbol;
  final String name;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Expanded(
    child: SizedBox(
      height: 52,
      child: TextButton(
        onPressed: onTap,
        style: ButtonStyle(
          padding: const WidgetStatePropertyAll(EdgeInsets.zero),
          backgroundColor: WidgetStatePropertyAll(
            selected
                ? context.iris.brand.withValues(alpha: 0.14)
                : context.iris.level2,
          ),
          foregroundColor: WidgetStatePropertyAll(
            selected ? context.iris.brand : context.iris.muted,
          ),
          side: WidgetStatePropertyAll(
            selected
                ? BorderSide(color: context.iris.brand, width: 1.5)
                : BorderSide.none,
          ),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
          ),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(symbol, style: const TextStyle(fontSize: 19, height: 1.1)),
            Text(name, style: const TextStyle(fontSize: 10.5, height: 1.2)),
          ],
        ),
      ),
    ),
  );
}
