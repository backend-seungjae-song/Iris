import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/design/terminal_grid.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/state/remote_state.dart';

class TerminalScreen extends StatefulWidget {
  const TerminalScreen({
    required this.state,
    required this.agentRef,
    this.onOpenBrowser,
    this.githubFailed = false,
    super.key,
  });

  final RemoteState state;
  final String agentRef;
  final VoidCallback? onOpenBrowser;
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
  String? _result;
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
          _error = frame.error == null
              ? null
              : terminalErrorMessage(frame.error!);
        });
      }
    });
    _watch();
    if (widget.state.supports('terminal.keys.get')) _loadKeys();
  }

  @override
  void dispose() {
    _frames?.cancel();
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
          _error = frame.error == null
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
          _result = '보냈습니다';
          _history = null;
          _input.clear();
        });
      }
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : error is ProtocolException
              ? error.message
              : 'Mac과 연결이 끊겼습니다.',
        );
      }
    }
  }

  Future<void> _pressKey(TerminalKeyButton key) async {
    if (!widget.state.supports('terminal.key')) return;
    try {
      await widget.state.session.keyTerminal(_agentRef, key.key, key.modifiers);
      if (mounted) setState(() => _result = '보냈습니다');
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
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
      _error = null;
    });
    _watch();
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
        final row =
            _keys?.keys.take(5).toList(growable: false) ??
            const <TerminalKeyButton>[];
        return Scaffold(
          backgroundColor: context.iris.terminal,
          body: SafeArea(
            bottom: false,
            child: Column(
              children: [
                ColoredBox(
                  color: context.iris.background,
                  child: IrisSessionHeader(
                    title: agent.name,
                    subtitle: agent.space,
                    agentKind: agent.kind,
                    mode: SessionMode.terminal,
                    tabs: [
                      for (final other in agents)
                        IrisAgentTab(
                          agent: other,
                          selected: other.ref == agent.ref,
                          onPressed: () => _selectAgent(other),
                        ),
                      const IrisShellTab(),
                    ],
                    onBack: () => Navigator.of(context).pop(),
                    canTerminal: true,
                    canChat: agent.kind != 'terminal',
                    canBrowser:
                        widget.onOpenBrowser != null &&
                        widget.state.supports('browser.tabs'),
                    onChat: () => Navigator.of(context).pop(),
                    onTerminal: () {},
                    onBrowser: widget.onOpenBrowser,
                    onGitHub:
                        agent.kind != 'terminal' &&
                            (widget.state.supports('git.changes') ||
                                widget.state.supports('github.pr'))
                        ? () => showSourceControlSheet(
                            context: context,
                            session: widget.state.session,
                            agent: agent,
                          )
                        : null,
                    githubFailed: widget.githubFailed,
                  ),
                ),
                if (_history != null)
                  TextButton(
                    onPressed: () => setState(() => _history = null),
                    child: const Text('현재 화면으로'),
                  ),
                if (!_mouseMode && widget.state.supports('terminal.mouse'))
                  const Text(
                    '이 화면은 마우스 입력을 받지 않습니다',
                    style: TextStyle(color: Color(0xffc9dcea), fontSize: 12),
                  ),
                if (_result != null)
                  Text(
                    _result!,
                    style: const TextStyle(
                      color: Color(0xffc9dcea),
                      fontSize: 13,
                    ),
                  ),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      if (_error != null) {
                        return Center(
                          child: Text(
                            _error!,
                            style: const TextStyle(color: Color(0xffc9dcea)),
                          ),
                        );
                      }
                      if (_columns == null || _rows == null) {
                        return const Center(
                          child: Text(
                            '터미널 화면 크기를 확인할 수 없습니다. 다시 연결하세요.',
                            style: TextStyle(color: Color(0xffc9dcea)),
                          ),
                        );
                      }
                      final width = constraints.maxWidth - 24;
                      final columns = _history?.columns ?? _columns!;
                      final rows = _history?.lineCount ?? _rows!;
                      if (columns * rows > 262144) {
                        return const Center(
                          child: Text('터미널 화면이 너무 커 표시할 수 없습니다.'),
                        );
                      }
                      final mouseEnabled = _mouseMode && _history == null;
                      final fontSize = terminalFontSize(width, columns);
                      _cellWidth = width / columns;
                      _cellHeight = fontSize * 1.35;
                      final grid = parseTerminalGrid(
                        _history?.text ?? _screen,
                        columns: columns,
                        rows: rows,
                      );
                      return NotificationListener<ScrollNotification>(
                        onNotification: (notice) {
                          if (!_mouseMode &&
                              _history == null &&
                              (notice is OverscrollNotification &&
                                      notice.overscroll < 0 ||
                                  notice is ScrollUpdateNotification &&
                                      notice.metrics.pixels <
                                          notice.metrics.minScrollExtent)) {
                            unawaited(_loadScrollback());
                          }
                          return false;
                        },
                        child: SingleChildScrollView(
                          physics: _mouseMode && _history == null
                              ? const NeverScrollableScrollPhysics()
                              : const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.symmetric(
                            horizontal: 12,
                            vertical: 12,
                          ),
                          child: GestureDetector(
                            behavior: HitTestBehavior.opaque,
                            onTapDown: (detail) =>
                                _lastPoint = detail.localPosition,
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
                                size: Size(width, rows * _cellHeight),
                                painter: TerminalGridPainter(grid, fontSize),
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
                if (row.isNotEmpty)
                  Container(
                    key: const Key('terminal-key-row'),
                    height: 58,
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 0),
                    color: context.iris.terminal,
                    child: Row(
                      children: [
                        for (final key in row) ...[
                          if (key.key == '/compact')
                            SizedBox(
                              width: 88,
                              child: _TerminalKey(
                                keyButton: key,
                                compact: true,
                                onPressed: () => _pressKey(key),
                              ),
                            )
                          else
                            Expanded(
                              child: _TerminalKey(
                                keyButton: key,
                                compact: true,
                                onPressed: () => _pressKey(key),
                              ),
                            ),
                          const SizedBox(width: 6),
                        ],
                        if ((_keys?.keys.length ?? 0) > 5 ||
                            widget.state.supports('terminal.keys.set'))
                          SizedBox(
                            width: 48,
                            child: _TerminalKey(
                              icon: 'dots-three',
                              onPressed: _openKeys,
                            ),
                          ),
                      ],
                    ),
                  ),
                Container(
                  key: const Key('terminal-composer'),
                  height: 58 + irisBottomInset(context),
                  padding: EdgeInsets.fromLTRB(
                    12,
                    10,
                    12,
                    irisBottomInset(context),
                  ),
                  color: context.iris.terminal,
                  child: Row(
                    children: [
                      Expanded(
                        child: TextField(
                          key: const Key('terminal-input'),
                          controller: _input,
                          enabled: widget.state.supports('terminal.input'),
                          style: TextStyle(
                            color: context.iris.foreground,
                            fontSize: 17,
                            height: 1.2,
                            letterSpacing: -0.17,
                          ),
                          decoration: InputDecoration(
                            hintText: '터미널에 입력',
                            hintStyle: TextStyle(
                              color: context.iris.faint,
                              fontSize: 17,
                              height: 1.2,
                              letterSpacing: -0.17,
                            ),
                            filled: true,
                            fillColor: context.iris.level1,
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 18,
                              vertical: 13,
                            ),
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(24),
                              borderSide: BorderSide.none,
                            ),
                          ),
                          onSubmitted: (_) => _sendText(),
                        ),
                      ),
                      const SizedBox(width: 8),
                      IrisRoundButton(
                        icon: 'arrow-up',
                        size: 48,
                        backgroundColor: context.iris.brand,
                        foregroundColor: context.iris.onBrand,
                        tooltip: '보내기',
                        onPressed: widget.state.supports('terminal.input')
                            ? _sendText
                            : null,
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

  Future<void> _loadScrollback() async {
    if (_loadingHistory || !widget.state.supports('terminal.scrollback')) {
      return;
    }
    _loadingHistory = true;
    final agent = _agentRef;
    try {
      final value = await widget.state.session.terminalScrollback(agent);
      if (mounted && _agentRef == agent) setState(() => _history = value);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
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
        if (mounted) setState(() => _result = error.message);
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
            if (mounted) setState(() => _result = error.message);
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
      if (mounted) setState(() => _result = error.message);
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
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : error is ProtocolException
              ? error.message
              : 'Mac과 연결이 끊겼습니다.',
        );
      }
    }
  }
}

class _TerminalKey extends StatelessWidget {
  const _TerminalKey({
    this.keyButton,
    this.icon,
    this.subtitle,
    this.compact = false,
    required this.onPressed,
  });
  final TerminalKeyButton? keyButton;
  final String? icon;
  final String? subtitle;
  final bool compact;
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
                _keyDescription(keyButton!, compact: compact),
                maxLines: 1,
                softWrap: false,
                style: TextStyle(
                  color: context.iris.foreground,
                  fontSize:
                      compact &&
                          _keyDescription(keyButton!, compact: true).length > 6
                      ? 13
                      : compact
                      ? 16
                      : 15,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          if (subtitle != null || keyButton != null)
            Text(
              subtitle ?? _keyLabel(keyButton!, compact: compact),
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

String _keyDescription(TerminalKeyButton key, {bool compact = false}) {
  if (compact && key.id == 'enter') return key.key;
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

String _keyLabel(TerminalKeyButton key, {required bool compact}) {
  if (!compact) return key.label;
  return switch (key.key) {
    'Tab' when key.modifiers.shift => '모드',
    'ArrowUp' => '이전',
    _ => key.label,
  };
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
                              text: 'Mac마다 따로',
                              style: TextStyle(
                                color: context.iris.foreground2,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const TextSpan(
                              text: ' 저장합니다. Mac의 키 설정이 다르면 그 Mac에 맞는 조합으로 지정해 두세요.',
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
    this.macName = 'Mac',
    super.key,
  });

  final String initialName;
  final String initialKey;
  final bool initialCtrl;
  final String macName;

  @override
  State<TerminalKeyEditorSheet> createState() => _TerminalKeyEditorSheetState();
}

class _TerminalKeyEditorSheetState extends State<TerminalKeyEditorSheet> {
  late final _name = TextEditingController(text: widget.initialName);
  late final _key = TextEditingController(text: widget.initialKey);
  bool _text = false;
  late bool _ctrl = widget.initialCtrl;
  bool _alt = false;
  bool _shift = false;
  bool _cmd = false;

  @override
  void initState() {
    super.initState();
    _name.addListener(_refresh);
    _key.addListener(_refresh);
  }

  void _refresh() => setState(() {});

  @override
  void dispose() {
    _name.dispose();
    _key.dispose();
    super.dispose();
  }

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
          decoration: const InputDecoration(hintText: '기록 검색', counterText: ''),
        ),
      ),
      const _Label('보낼 것'),
      Container(
        margin: const EdgeInsets.only(top: 8),
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
              selected: !_text,
              onTap: () => setState(() => _text = false),
            ),
            const SizedBox(width: 4),
            _Choice(
              label: '글자',
              selected: _text,
              onTap: () => setState(() => _text = true),
            ),
          ],
        ),
      ),
      if (!_text)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(
            children: [
              _Modifier('⌃', _ctrl, () => setState(() => _ctrl = !_ctrl)),
              const SizedBox(width: 8),
              _Modifier('⌥', _alt, () => setState(() => _alt = !_alt)),
              const SizedBox(width: 8),
              _Modifier('⇧', _shift, () => setState(() => _shift = !_shift)),
              const SizedBox(width: 8),
              _Modifier('⌘', _cmd, () => setState(() => _cmd = !_cmd)),
            ],
          ),
        ),
      const SizedBox(height: 8),
      SizedBox(
        height: 52,
        width: double.infinity,
        child: TextField(
          key: const Key('key-value-input'),
          controller: _key,
          maxLength: 24,
          decoration: InputDecoration(
            hintText: _text ? '/compact' : 'R',
            hintStyle: TextStyle(
              color: context.iris.foreground,
              fontSize: 20,
              fontWeight: FontWeight.w600,
            ),
            suffixText: _text ? null : '누를 키',
            suffixStyle: TextStyle(
              color: context.iris.muted,
              fontSize: 14,
              fontWeight: FontWeight.w400,
            ),
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
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '${_ctrl ? '⌃' : ''}${_key.text.isEmpty ? 'R' : _key.text}',
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    _name.text.isEmpty ? '미리 보기' : _name.text,
                    style: TextStyle(color: context.iris.muted, fontSize: 10.5),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) => OverflowBox(
                  alignment: Alignment.centerLeft,
                  minWidth: constraints.maxWidth / 0.94,
                  maxWidth: constraints.maxWidth / 0.94,
                  child: Transform.scale(
                    scaleX: 0.94,
                    alignment: Alignment.centerLeft,
                    child: Text.rich(
                      TextSpan(
                        text: '누르면 ${widget.macName} 터미널에 ',
                        children: [
                          TextSpan(
                            text:
                                '${_ctrl ? 'Control + ' : ''}${_key.text.isEmpty ? 'R' : _key.text}',
                            style: TextStyle(
                              color: context.iris.foreground,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const TextSpan(text: '을 보냅니다.'),
                        ],
                      ),
                      style: TextStyle(
                        color: context.iris.muted,
                        fontSize: 14,
                        height: 1.5,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 14),
      Row(
        children: [
          SizedBox(
            width: 120,
            child: IrisButton(label: '나머지에', expand: false, onPressed: _finish),
          ),
          const SizedBox(width: 10),
          IrisButton(
            label: '앞줄에 추가',
            tone: IrisButtonTone.primary,
            onPressed: _finish,
          ),
        ],
      ),
    ],
  );

  void _finish() {
    final name = _name.text.trim();
    final key = _key.text;
    if (name.isEmpty || key.isEmpty) return;
    final id = 'custom-${DateTime.now().microsecondsSinceEpoch}';
    Navigator.of(context).pop(
      TerminalKeyButton(
        id: id,
        label: name,
        key: key,
        modifiers: _text
            ? const KeyModifiers()
            : KeyModifiers(ctrl: _ctrl, alt: _alt, shift: _shift, cmd: _cmd),
      ),
    );
  }
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
  const _Modifier(this.label, this.selected, this.onTap);
  final String label;
  final bool selected;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Expanded(
    child: SizedBox(
      height: 52,
      child: TextButton(
        onPressed: onTap,
        style: ButtonStyle(
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
        child: Text(
          label,
          style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w400),
        ),
      ),
    ),
  );
}
