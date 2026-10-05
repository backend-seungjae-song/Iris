import 'package:iris_remote/design/browser_groups.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/composer.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/state/remote_state.dart';

enum BrowserTool { none, pick, record, sketch, direct }

enum BrowserInputMode { trackpad, direct }

class BrowserScreen extends StatefulWidget {
  const BrowserScreen({
    required this.state,
    required this.agentRef,
    required this.tabRef,
    this.humanRequest,
    this.onOpenTerminal,
    this.frameIncludesOverlays = false,
    this.frameImage,
    this.selectionFrameImage,
    this.recordFrameImage,
    this.sketchFrameImage,
    this.desktopFrameImage,
    this.elementComponent,
    this.elementSource,
    this.profileDetails = const {},
    this.showChromeImport = false,
    this.overlayBuilder,
    super.key,
  });

  final RemoteState state;
  final String agentRef;
  final String tabRef;
  final RemoteRequest? humanRequest;
  final VoidCallback? onOpenTerminal;
  final bool frameIncludesOverlays;
  final ui.Image? frameImage;
  final ui.Image? selectionFrameImage;
  final ui.Image? recordFrameImage;
  final ui.Image? sketchFrameImage;
  final ui.Image? desktopFrameImage;
  final String? elementComponent;
  final String? elementSource;
  final Map<String, String> profileDetails;
  final bool showChromeImport;
  @visibleForTesting
  final Widget Function(BuildContext context, BrowserTool tool)? overlayBuilder;

  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  late String _tabRef;
  late String _agentRef;
  StreamSubscription<BrowserFrame>? _frames;
  StreamSubscription<RemoteConnectionStatus>? _connectionStates;
  BrowserFrame? _frame;
  BrowserTool _tool = BrowserTool.none;
  BrowserRecordResult? _record;
  bool _recordPaused = false;
  bool _desktop = false;
  BrowserInputMode _inputMode = BrowserInputMode.trackpad;
  Offset _cursor = const Offset(0.5, 0.5);
  double _frameZoom = 1;
  BrowserElementHoverResult? _hoveredElement;
  BrowserFocusResult? _pageFocus;
  int _watchedWidth = 0;
  bool _moreSelected = false;
  final Set<String> _collapsedTabGroups = <String>{};
  final Set<String> _initializedTabGroups = <String>{};
  bool _busy = false;
  bool _reconnecting = false;
  bool _sendingMessage = false;
  String? _result;
  String? _messageResult;
  String? _error;
  final TextEditingController _address = TextEditingController();
  final TextEditingController _directInput = TextEditingController();
  final TextEditingController _recordNote = TextEditingController();
  final TextEditingController _sketchText = TextEditingController();
  late final TextEditingController _messageText;
  final GlobalKey _sketchKey = GlobalKey();
  final List<_Stroke> _strokes = [];
  _Stroke? _activeStroke;
  Color _penColor = const Color(0xffff7a72);
  bool _eraser = false;
  Timer? _mouseMotionTimer;
  Timer? _pageTextTimer;
  Timer? _postClickTimer;
  String _pendingPageText = '';
  bool _dialogShowing = false;
  _PendingMouseMotion? _pendingMouseMotion;
  bool _mouseMotionSending = false;
  int _hoverGeneration = 0;
  DateTime _lastMouseMotion = DateTime.fromMillisecondsSinceEpoch(0);

  @override
  void initState() {
    super.initState();
    _tabRef = widget.tabRef;
    _agentRef = widget.agentRef;
    _messageText = TextEditingController(
      text: widget.state.composerTextFor(_agentRef),
    )..addListener(_messageTextChanged);
    if (!widget.state.supports('browser.mouse')) {
      _inputMode = BrowserInputMode.direct;
    }
    if (widget.humanRequest != null) _tool = BrowserTool.direct;
    _frames = widget.state.session.browserFrames.listen((frame) {
      if (mounted && frame.tab == _tabRef) setState(() => _frame = frame);
    });
    _connectionStates = widget.state.session.connectionStates.listen((status) {
      if (!mounted) return;
      setState(() {
        _reconnecting = status == RemoteConnectionStatus.reconnecting;
        if (_reconnecting) {
          _invalidateElementHighlight();
          _tool = BrowserTool.none;
        }
      });
    });
    _syncAddress();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_watch());
    });
  }

  @override
  void dispose() {
    _frames?.cancel();
    _connectionStates?.cancel();
    _invalidateElementHighlight();
    _mouseMotionTimer?.cancel();
    _pageTextTimer?.cancel();
    _postClickTimer?.cancel();
    _address.dispose();
    _directInput.dispose();
    _recordNote.dispose();
    _sketchText.dispose();
    _messageText
      ..removeListener(_messageTextChanged)
      ..dispose();
    super.dispose();
  }

  BrowserTab? get _tab => widget.state.browserTab(_tabRef);

  void _messageTextChanged() {
    widget.state.setComposerText(_agentRef, _messageText.text);
    if (_messageResult != null && mounted) {
      setState(() => _messageResult = null);
    }
  }

  Future<void> _sendMessage() async {
    final text = _messageText.text;
    final drafts = widget.state.composerDraftsFor(_agentRef);
    if (_sendingMessage || (text.isEmpty && drafts.isEmpty)) return;
    setState(() => _sendingMessage = true);
    try {
      final response = await widget.state.sendComposerMessage(_agentRef, text);
      final sent = const {'sent', 'delivered'}.contains(response.result);
      if (!mounted) return;
      if (sent) _messageText.clear();
      setState(() => _messageResult = agentMessageResultText(response.result));
    } on ProtocolException catch (error) {
      if (mounted) setState(() => _messageResult = error.message);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _messageResult = error.message);
    } finally {
      if (mounted) setState(() => _sendingMessage = false);
    }
  }

  void _syncAddress() {
    _address.text = _tab?.url ?? '';
  }

  Future<void> _watch() async {
    if (!widget.state.supports('browser.frame.watch')) return;
    if (mounted) setState(() => _error = null);
    try {
      final width = _requestedFrameWidth();
      await widget.state.session.watchBrowserFrame(
        _tabRef,
        width: width,
        desktop: _desktop,
      );
      _watchedWidth = width;
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  int _requestedFrameWidth() => browserFrameRequestWidth(
    logicalWidth: MediaQuery.sizeOf(context).width,
    devicePixelRatio: MediaQuery.devicePixelRatioOf(context),
    zoom: _frameZoom,
    desktop: _desktop,
  );

  void _selectTab(BrowserTab tab, {String? agentRef}) {
    if (tab.ref == _tabRef && (agentRef == null || agentRef == _agentRef)) {
      return;
    }
    _invalidateElementHighlight();
    setState(() {
      final candidates = widget.state.agents.where(
        (agent) => agent.kind != 'terminal' && agent.spaceRef == tab.space,
      );
      final owned = candidates.where(
        (agent) => tab.sessions.contains(agent.ref),
      );
      final next =
          owned.where((agent) => agent.ref == agentRef).firstOrNull ??
          owned.where((agent) => agent.ref == _agentRef).firstOrNull ??
          owned.firstOrNull ??
          candidates.where((agent) => agent.ref == _agentRef).firstOrNull ??
          candidates.firstOrNull;
      if (next?.ref != _agentRef) {
        _agentRef = next?.ref ?? '';
        _messageText.text = widget.state.composerTextFor(_agentRef);
        _messageResult = null;
      }
      _tabRef = tab.ref;
      _frame = null;
      _error = null;
      _tool = BrowserTool.none;
      _cursor = const Offset(0.5, 0.5);
      _frameZoom = 1;
      _hoveredElement = null;
      _pageFocus = null;
    });
    _syncAddress();
    _watch();
  }

  void _invalidateElementHighlight() {
    _hoverGeneration++;
    if (_pendingMouseMotion?.hover == true) {
      _pendingMouseMotion = null;
    }
    _mouseMotionTimer?.cancel();
    _mouseMotionTimer = null;
    _hoveredElement = null;
  }

  void _setTool(BrowserTool tool) {
    _invalidateElementHighlight();
    setState(() => _tool = tool);
  }

  Future<void> _action(
    Future<RemoteActionResult> Function() call, {
    VoidCallback? after,
  }) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final response = await call();
      if (mounted) setState(() => _result = response.result);
      after?.call();
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : error is ProtocolException
              ? error.message
              : '컴퓨터과 연결이 끊겼습니다.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final tab = _tab;
        final agent = widget.state.agent(_agentRef);
        if (tab == null) {
          return const Scaffold(
            body: Center(child: Text('브라우저 탭을 찾을 수 없습니다.')),
          );
        }
        final space =
            widget.state.browserSpace(tab.space)?.name ??
            agent?.space ??
            '스페이스';
        for (final item in widget.state.browserTabGroups) {
          if (_initializedTabGroups.add(item.ref) && item.collapsed) {
            _collapsedTabGroups.add(item.ref);
          }
        }
        return Scaffold(
          body: SafeArea(
            bottom: false,
            child: Column(
              children: [
                IrisSessionHeader(
                  title: _host(tab),
                  subtitle: '$space 스페이스 탭',
                  mode: SessionMode.browser,
                  tabs: [
                    for (final group in browserTabGroups(
                      tab,
                      widget.state.browserTabs,
                      widget.state.browserTabGroups,
                    )) ...[
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        child: ActionChip(
                          label: Text(
                            group.name,
                            style: TextStyle(
                              color: group.color == null
                                  ? null
                                  : browserGroupColor(group.color),
                            ),
                          ),
                          onPressed: group.ref == null
                              ? null
                              : () => setState(() {
                                  if (!_collapsedTabGroups.add(group.ref!)) {
                                    _collapsedTabGroups.remove(group.ref!);
                                  }
                                }),
                        ),
                      ),
                      if (group.ref == null ||
                          !_collapsedTabGroups.contains(group.ref))
                        for (final item in group.tabs)
                          IrisBrowserTab(
                            tab: item,
                            selected: item.ref == tab.ref,
                            onPressed: () => _selectTab(item),
                          ),
                    ],
                    if (widget.state.supports('browser.tab.new'))
                      IrisNewBrowserTab(onPressed: () => _newTab(tab.space)),
                  ],
                  onBack: () => Navigator.of(context).pop(),
                  canTerminal:
                      widget.onOpenTerminal != null &&
                      widget.state.supports('terminal.watch'),
                  canChat: agent != null,
                  canBrowser: true,
                  onChat: () => Navigator.of(context).pop(),
                  onTerminal: widget.onOpenTerminal,
                  onBrowser: () {},
                ),
                _AddressBar(
                  controller: _address,
                  profile: tab.profile,
                  desktop: _desktop,
                  canNavigate: widget.state.supports('browser.navigate'),
                  onNavigate: _navigate,
                  onBookmark: widget.state.supports('browser.bookmark.set')
                      ? () => _bookmark(true)
                      : null,
                ),
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            _FrameSurface(
                              key: const Key('browser-frame'),
                              frame: _frame,
                              referenceImage: _desktop
                                  ? widget.desktopFrameImage
                                  : switch (_tool) {
                                      BrowserTool.pick =>
                                        widget.selectionFrameImage ??
                                            widget.frameImage,
                                      BrowserTool.record =>
                                        widget.recordFrameImage ??
                                            widget.frameImage,
                                      BrowserTool.sketch =>
                                        widget.sketchFrameImage ??
                                            widget.frameImage,
                                      _ => widget.frameImage,
                                    },
                              error: _error,
                              inputMode: _tool == BrowserTool.pick
                                  ? (widget.state.supports(
                                          'browser.element.hover',
                                        )
                                        ? BrowserInputMode.trackpad
                                        : BrowserInputMode.direct)
                                  : !widget.state.supports('browser.mouse')
                                  ? BrowserInputMode.direct
                                  : _inputMode,
                              cursor: _cursor,
                              zoom: _frameZoom,
                              highlightedElement: _tool == BrowserTool.pick
                                  ? _hoveredElement
                                  : null,
                              canDirectTap: widget.state.supports(
                                'browser.pointer',
                              ),
                              canDirectScroll: widget.state.supports(
                                'browser.scroll',
                              ),
                              onCursor: (value, point, action) {
                                setState(() => _cursor = value);
                                if (_tool == BrowserTool.pick) {
                                  _queueElementHover(point);
                                } else {
                                  _queueMouseMotion(point, action);
                                }
                              },
                              onMouse: _handleMouseAction,
                              onDirectTap: (point, action) =>
                                  action == 'click' || _tool == BrowserTool.pick
                                  ? _handleFrameTap(point)
                                  : _sendPoint(point, action),
                              onDirectScroll: (dy) => _action(
                                () => widget.state.session.browserScroll(
                                  _tabRef,
                                  dy,
                                ),
                              ),
                              onZoom: (value) =>
                                  setState(() => _frameZoom = value),
                              onZoomEnd: _refreshZoomedFrame,
                            ),
                            if (!_desktop && widget.overlayBuilder != null)
                              Positioned.fill(
                                child: IgnorePointer(
                                  child: widget.overlayBuilder!(context, _tool),
                                ),
                              ),
                            if (!widget.frameIncludesOverlays &&
                                tab.aiControlled &&
                                _tool == BrowserTool.none) ...[
                              IgnorePointer(
                                child: DecoratedBox(
                                  decoration: BoxDecoration(
                                    border: Border.all(
                                      color: const Color(0xfff4a1a7),
                                      width: 2,
                                    ),
                                    boxShadow: const [
                                      BoxShadow(
                                        color: Color(0x73f4a1a7),
                                        blurRadius: 28,
                                        spreadRadius: -4,
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                              Positioned(
                                bottom: 14,
                                left: 0,
                                right: 0,
                                child: Center(
                                  child: Container(
                                    width: 165,
                                    height: 32,
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 10,
                                    ),
                                    decoration: BoxDecoration(
                                      color: const Color(0xd1140a0c),
                                      borderRadius: BorderRadius.circular(16),
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Container(
                                          width: 7,
                                          height: 7,
                                          decoration: const BoxDecoration(
                                            color: Color(0xfff4a1a7),
                                            shape: BoxShape.circle,
                                          ),
                                        ),
                                        const SizedBox(width: 8),
                                        Flexible(
                                          child: Text(
                                            _typingLabel(tab.controlling),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              color: Color(0xffffd9dc),
                                              fontSize: 13,
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ],
                            if (_reconnecting)
                              const Positioned(
                                top: 8,
                                left: 12,
                                right: 12,
                                child: _ConnectionNotice(),
                              ),
                            if (_tool == BrowserTool.sketch)
                              Positioned.fill(
                                child: RepaintBoundary(
                                  key: _sketchKey,
                                  child: GestureDetector(
                                    behavior: HitTestBehavior.opaque,
                                    onPanStart: _startStroke,
                                    onPanUpdate: _updateStroke,
                                    onPanEnd: (_) => _endStroke(),
                                    child: widget.frameIncludesOverlays
                                        ? const SizedBox.expand()
                                        : CustomPaint(
                                            painter: _SketchPainter(
                                              _strokes,
                                              _activeStroke,
                                            ),
                                          ),
                                  ),
                                ),
                              ),
                            if (_tool == BrowserTool.direct)
                              Positioned(
                                top: 6,
                                left: 12,
                                right: 12,
                                child: Opacity(
                                  opacity: widget.frameIncludesOverlays ? 0 : 1,
                                  child: const _HumanBanner(
                                    text: '직접 조작 중 · 에이전트는 기다립니다',
                                  ),
                                ),
                              ),
                            if (_tool == BrowserTool.record && _record != null)
                              Positioned(
                                top: 6,
                                left: 12,
                                right: 12,
                                child: Opacity(
                                  opacity: widget.frameIncludesOverlays ? 0 : 1,
                                  child: _RecordBanner(
                                    result: _record!,
                                    paused: _recordPaused,
                                    onPause: _pauseRecord,
                                  ),
                                ),
                              ),
                            if (_desktop && _tool == BrowserTool.none)
                              Positioned(
                                left: 12,
                                right: 12,
                                bottom: 12,
                                child: Opacity(
                                  opacity: widget.frameIncludesOverlays ? 0 : 1,
                                  child: const _HumanBanner(
                                    text: '컴퓨터 창 폭 1280px로 그립니다 · 두 손가락 확대',
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (_tool == BrowserTool.sketch)
                        _SketchControls(
                          controller: _sketchText,
                          color: _penColor,
                          eraser: _eraser,
                          onColor: (color) => setState(() {
                            _penColor = color;
                            _eraser = false;
                          }),
                          onPen: () => setState(() => _eraser = false),
                          onEraser: () => setState(() => _eraser = true),
                          onUndo: _strokes.isEmpty
                              ? null
                              : () => setState(() => _strokes.removeLast()),
                          onSend: _sendSketch,
                        )
                      else if (_tool == BrowserTool.direct)
                        _DirectControls(
                          controller: _directInput,
                          human: widget.humanRequest != null,
                          canType: widget.state.supports('browser.type'),
                          onType: _typeDirect,
                          onBack: () => Navigator.of(context).pop(),
                          onUnable: widget.humanRequest == null
                              ? null
                              : () => _answerHuman('unable'),
                          onDone: widget.humanRequest == null
                              ? null
                              : () => _answerHuman('done'),
                        )
                      else if (_tool == BrowserTool.record)
                        Padding(
                          padding: EdgeInsets.fromLTRB(
                            8,
                            0,
                            8,
                            irisSheetBottom(context),
                          ),
                          child: IrisSheetFrame(
                            key: const Key('browser-record-sheet'),
                            child: _RecordControls(
                              controller: _recordNote,
                              steps: _record?.steps ?? const [],
                              location:
                                  '${_host(tab)}${Uri.tryParse(tab.url)?.path ?? ''}',
                              destination: agent?.name ?? '세션 없음',
                              canFinish: widget.state.supports(
                                'browser.record.finish',
                              ),
                              onCancel: () => setState(() {
                                _invalidateElementHighlight();
                                _tool = BrowserTool.none;
                                _record = null;
                              }),
                              onFinish: _finishRecord,
                            ),
                          ),
                        )
                      else ...[
                        if (_messageResult != null)
                          _BrowserMessageResult(text: _messageResult!),
                        if (agent?.can.message == true)
                          IrisComposer(
                            controller: _messageText,
                            drafts: widget.state.composerDraftsFor(_agentRef),
                            sending: _sendingMessage,
                            stopping: false,
                            working: false,
                            workingLabel: '작업 중',
                            onSend: _sendMessage,
                            onRemoveDraft: (ref) => widget.state
                                .removeComposerDraft(_agentRef, ref),
                            onTap: _focusMessageComposer,
                            includeBottomInset: false,
                            composerKey: const Key('browser-composer'),
                            inputBoxKey: const Key('browser-composer-box'),
                            inputKey: const Key('browser-composer-input'),
                            actionKey: const Key('browser-composer-action'),
                          ),
                        if (_pageFocus != null)
                          _PageInputControls(
                            focus: _pageFocus!,
                            onText: _queuePageText,
                            onKey: _sendPageKey,
                            onPaste: _pastePageText,
                            onCopy: _copyPageSelection,
                            onClose: _closePageInput,
                          )
                        else
                          _BrowserToolbar(
                            selected: _tool,
                            moreSelected: _moreSelected,
                            canBack: widget.state.supports('browser.history'),
                            canPick:
                                agent?.can.message == true &&
                                widget.state.supports('browser.element'),
                            canRecord:
                                agent?.can.message == true &&
                                widget.state.supports('browser.record.start'),
                            canSketch:
                                agent?.can.message == true &&
                                widget.state.supports('browser.sketch.send'),
                            onBack: () => _history('back'),
                            onPick: () {
                              _closePageInput();
                              _setTool(
                                _tool == BrowserTool.pick
                                    ? BrowserTool.none
                                    : BrowserTool.pick,
                              );
                            },
                            onRecord: _startRecord,
                            onSketch: () => _setTool(BrowserTool.sketch),
                            onMore: () => _openMore(tab),
                          ),
                      ],
                    ],
                  ),
                ),
                if (_result != null) Offstage(child: Text(_result!)),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _handleFrameTap(_FramePoint point) async {
    if (_tool == BrowserTool.pick &&
        widget.state.supports('browser.element.pick')) {
      await _pickFramePoint(point);
    } else if (_tool != BrowserTool.sketch &&
        widget.state.supports('browser.pointer')) {
      await _sendPoint(point, 'click');
    }
  }

  Future<void> _pickFramePoint(_FramePoint point) async {
    try {
      final draft = await widget.state.session.pickBrowserElement(
        _tabRef,
        _agentRef,
        x: point.x,
        y: point.y,
        width: point.width,
        height: point.height,
      );
      if (!mounted) return;
      widget.state.addBrowserDraft(_agentRef, draft);
      setState(() => _result = '요소를 입력칸에 추가했습니다.');
    } on Object catch (error) {
      if (!mounted) return;
      setState(
        () => _result = error is RemoteFailure
            ? error.message
            : error is ProtocolException
            ? error.message
            : '컴퓨터과 연결이 끊겼습니다.',
      );
    }
  }

  Future<void> _sendPoint(_FramePoint point, String action) async {
    await _action(
      () => widget.state.session.browserPointer(
        _tabRef,
        x: point.x,
        y: point.y,
        width: point.width,
        height: point.height,
        action: action,
      ),
    );
    if (action == 'click' || action == 'double') await _afterPageClick();
  }

  Future<void> _handleMouseAction(
    _FramePoint point,
    String action, [
    int? dy,
  ]) async {
    if (action != 'move') {
      _postClickTimer?.cancel();
      _postClickTimer = null;
    }
    if (_tool == BrowserTool.pick) {
      if (action == 'click' || action == 'double') {
        await _pickFramePoint(point);
      }
      return;
    }
    await _sendMouse(point, action, dy);
    if (action == 'click' || action == 'double') await _afterPageClick();
  }

  void _queueMouseMotion(_FramePoint point, String action) {
    _pendingMouseMotion = _PendingMouseMotion(point, action, hover: false);
    _scheduleMouseMotion();
  }

  void _queueElementHover(_FramePoint point) {
    _pendingMouseMotion = _PendingMouseMotion(point, 'move', hover: true);
    _scheduleMouseMotion();
  }

  void _scheduleMouseMotion() {
    if (_mouseMotionTimer != null || _mouseMotionSending) return;
    final elapsed = DateTime.now().difference(_lastMouseMotion);
    final delay = elapsed >= const Duration(milliseconds: 150)
        ? Duration.zero
        : const Duration(milliseconds: 150) - elapsed;
    _mouseMotionTimer = Timer(delay, _drainMouseMotion);
  }

  Future<void> _drainMouseMotion() async {
    _mouseMotionTimer = null;
    if (_mouseMotionSending) return;
    final pending = _pendingMouseMotion;
    _pendingMouseMotion = null;
    if (pending == null) return;
    _mouseMotionSending = true;
    try {
      if (pending.hover) {
        await _enqueueElementHover(pending.point);
      } else {
        await _enqueueMouse(pending.point, pending.action);
      }
      _lastMouseMotion = DateTime.now();
    } finally {
      _mouseMotionSending = false;
      if (_pendingMouseMotion != null) {
        _scheduleMouseMotion();
      }
    }
  }

  Future<void> _enqueueElementHover(_FramePoint point) async {
    final generation = _hoverGeneration;
    final tab = _tabRef;
    try {
      final response = await widget.state.session.hoverBrowserElement(
        tab,
        x: point.x,
        y: point.y,
        width: point.width,
        height: point.height,
      );
      if (response != null &&
          mounted &&
          generation == _hoverGeneration &&
          tab == _tabRef &&
          _tool == BrowserTool.pick) {
        setState(() => _hoveredElement = response);
      }
    } on Object catch (error) {
      if (!mounted) return;
      if (error is RemoteFailure &&
          widget.state.session.connectionStatus ==
              RemoteConnectionStatus.reconnecting) {
        return;
      }
      setState(
        () => _result = error is RemoteFailure
            ? error.message
            : error is ProtocolException
            ? error.message
            : '컴퓨터과 연결이 끊겼습니다.',
      );
    }
  }

  Future<void> _sendMouse(_FramePoint point, String action, [int? dy]) async {
    _mouseMotionTimer?.cancel();
    _mouseMotionTimer = null;
    final pending = _pendingMouseMotion;
    _pendingMouseMotion = null;
    if (action == 'up' && pending != null) {
      if (!pending.hover) await _enqueueMouse(pending.point, pending.action);
    }
    await _enqueueMouse(point, action, dy);
  }

  Future<void> _enqueueMouse(
    _FramePoint point,
    String action, [
    int? dy,
  ]) async {
    try {
      final response = await widget.state.session.browserMouse(
        _tabRef,
        x: point.x,
        y: point.y,
        width: point.width,
        height: point.height,
        action: action,
        dy: dy,
      );
      if (response != null && mounted) {
        setState(() => _result = response.result);
      }
    } on Object catch (error) {
      if (!mounted) return;
      if (error is RemoteFailure &&
          widget.state.session.connectionStatus ==
              RemoteConnectionStatus.reconnecting) {
        return;
      }
      setState(
        () => _result = error is RemoteFailure
            ? error.message
            : error is ProtocolException
            ? error.message
            : '컴퓨터과 연결이 끊겼습니다.',
      );
    }
  }

  Future<void> _afterPageClick() async {
    if (widget.state.supports('browser.dialog')) {
      try {
        final response = await widget.state.session.browserDialog(_tabRef);
        if (response.dialog != null) {
          await _showPageDialog(response.dialog!);
          _schedulePostClickCheck();
          return;
        }
      } on RemoteFailure catch (error) {
        if (mounted) setState(() => _result = error.message);
        return;
      }
    }
    if (!widget.state.supports('browser.focus')) {
      _schedulePostClickCheck();
      return;
    }
    try {
      final focus = await widget.state.session.browserFocus(_tabRef);
      if (!mounted) return;
      if (focus.editable || focus.kind == 'select') {
        setState(() => _pageFocus = focus);
      } else {
        _closePageInput();
        _schedulePostClickCheck();
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  void _schedulePostClickCheck() {
    _postClickTimer?.cancel();
    _postClickTimer = Timer(const Duration(milliseconds: 900), () async {
      _postClickTimer = null;
      await widget.state.refreshBrowserTabs();
      if (!mounted ||
          _dialogShowing ||
          !widget.state.supports('browser.dialog')) {
        return;
      }
      try {
        final response = await widget.state.session.browserDialog(_tabRef);
        if (mounted && response.dialog != null) {
          await _showPageDialog(response.dialog!);
        }
      } on RemoteFailure catch (error) {
        if (mounted) setState(() => _result = error.message);
      }
    });
  }

  Future<void> _showPageDialog(BrowserDialog dialog) async {
    if (_dialogShowing || !mounted) return;
    _dialogShowing = true;
    final input = TextEditingController();
    final action = await showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        key: const Key('browser-page-dialog'),
        title: Text(dialog.kind == 'alert' ? '페이지 알림' : '페이지 확인'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(dialog.message),
            if (dialog.kind == 'prompt') ...[
              const SizedBox(height: 14),
              TextField(
                key: const Key('browser-dialog-input'),
                controller: input,
                autofocus: true,
                maxLength: 2000,
              ),
            ],
          ],
        ),
        actions: [
          if (dialog.kind != 'alert')
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop('cancel'),
              child: const Text('취소'),
            ),
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop('accept'),
            child: const Text('확인'),
          ),
        ],
      ),
    );
    _dialogShowing = false;
    if (!mounted || action == null) {
      input.dispose();
      return;
    }
    BrowserDialog? nextDialog;
    try {
      final response = await widget.state.session.browserDialog(
        _tabRef,
        action: action,
        text: action == 'accept' && dialog.kind == 'prompt' ? input.text : null,
      );
      nextDialog = response.dialog;
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } finally {
      input.dispose();
    }
    if (nextDialog != null) await _showPageDialog(nextDialog);
  }

  void _queuePageText(String text) {
    if (text.isEmpty) return;
    _pendingPageText += text;
    _pageTextTimer?.cancel();
    _pageTextTimer = Timer(const Duration(milliseconds: 120), _flushPageText);
  }

  Future<void> _flushPageText() async {
    _pageTextTimer?.cancel();
    _pageTextTimer = null;
    final text = _pendingPageText;
    _pendingPageText = '';
    if (text.isEmpty || !widget.state.supports('browser.type')) return;
    try {
      for (var offset = 0; offset < text.length; offset += 4000) {
        final end = (offset + 4000).clamp(0, text.length);
        await widget.state.session.browserType(
          _tabRef,
          text.substring(offset, end),
        );
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _sendPageKey(String key) async {
    _postClickTimer?.cancel();
    _postClickTimer = null;
    await _flushPageText();
    if (!widget.state.supports('browser.key')) return;
    try {
      await widget.state.session.browserKey(_tabRef, key, const KeyModifiers());
      if (key == 'Escape') _closePageInput();
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _pastePageText() async {
    final value = await Clipboard.getData(Clipboard.kTextPlain);
    final text = value?.text;
    if (text == null || text.isEmpty) return;
    _queuePageText(text);
    await _flushPageText();
  }

  Future<void> _copyPageSelection() async {
    if (!widget.state.supports('browser.focus')) return;
    try {
      final focus = await widget.state.session.browserFocus(_tabRef);
      if (focus.selectedText.isNotEmpty) {
        await Clipboard.setData(ClipboardData(text: focus.selectedText));
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  void _focusMessageComposer() {
    if (_pageFocus != null) _closePageInput(unfocus: false);
  }

  void _closePageInput({bool unfocus = true}) {
    if (_pendingPageText.isNotEmpty) {
      unawaited(_flushPageText());
    } else {
      _pageTextTimer?.cancel();
      _pageTextTimer = null;
    }
    if (unfocus) FocusManager.instance.primaryFocus?.unfocus();
    if (mounted && _pageFocus != null) setState(() => _pageFocus = null);
  }

  void _refreshZoomedFrame() {
    final width = _requestedFrameWidth();
    if (width != _watchedWidth) unawaited(_watch());
  }

  Future<void> _navigate() async {
    if (!widget.state.supports('browser.navigate')) return;
    await _action(
      () => widget.state.session.browserNavigate(_tabRef, _address.text),
      after: widget.state.refreshBrowserTabs,
    );
  }

  Future<void> _newTab(String space) async {
    await _action(
      () => widget.state.session.browserNewTab(space),
      after: widget.state.refreshBrowserTabs,
    );
  }

  Future<void> _history(String action) =>
      _action(() => widget.state.session.browserHistory(_tabRef, action));

  Future<void> _bookmark(bool value) =>
      _action(() => widget.state.session.setBrowserBookmark(_tabRef, value));

  Future<void> _typeDirect() async {
    if (_directInput.text.isEmpty) return;
    await _action(
      () => widget.state.session.browserType(_tabRef, _directInput.text),
      after: _directInput.clear,
    );
  }

  Future<void> _answerHuman(String choice) async {
    final request = widget.humanRequest;
    if (request == null) return;
    try {
      final response = await widget.state.answerBrowserUser(
        request,
        choice: choice,
      );
      if (mounted &&
          const {
            'delivered',
            'already-answered',
            'expired',
          }.contains(response.result)) {
        Navigator.of(context).pop();
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _startRecord() async {
    if (_tool == BrowserTool.pick) _setTool(BrowserTool.none);
    try {
      final response = await widget.state.session.startBrowserRecord(_tabRef);
      if (mounted) {
        setState(() {
          _record = response;
          _recordPaused = false;
          _invalidateElementHighlight();
          _tool = BrowserTool.record;
        });
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _pauseRecord() async {
    try {
      final response = await widget.state.session.pauseBrowserRecord(
        !_recordPaused,
      );
      if (mounted) {
        setState(() {
          _record = response;
          _recordPaused = !_recordPaused;
        });
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _finishRecord() async {
    try {
      final note = _recordNote.text.trim();
      final response = await widget.state.session.finishBrowserRecord(
        _agentRef,
        note: note.isEmpty ? null : note,
      );
      if (mounted) {
        widget.state.addBrowserDraft(_agentRef, response);
        Navigator.of(context).pop(true);
      }
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : error is ProtocolException
              ? error.message
              : '컴퓨터과 연결이 끊겼습니다.',
        );
      }
    }
  }

  void _startStroke(DragStartDetails details) {
    final point = details.localPosition;
    if (_eraser) {
      setState(
        () => _strokes.removeWhere(
          (stroke) => stroke.points.any(
            (candidate) => (candidate - point).distance < 18,
          ),
        ),
      );
      return;
    }
    setState(() => _activeStroke = _Stroke(_penColor, [point]));
  }

  void _updateStroke(DragUpdateDetails details) {
    if (_eraser) {
      final point = details.localPosition;
      setState(
        () => _strokes.removeWhere(
          (stroke) => stroke.points.any(
            (candidate) => (candidate - point).distance < 18,
          ),
        ),
      );
    } else if (_activeStroke != null) {
      setState(() => _activeStroke!.points.add(details.localPosition));
    }
  }

  void _endStroke() {
    if (_activeStroke == null) return;
    setState(() {
      _strokes.add(_activeStroke!);
      _activeStroke = null;
    });
  }

  Future<void> _sendSketch() async {
    if (_sketchText.text.trim().isEmpty || _strokes.isEmpty) return;
    try {
      final boundary =
          _sketchKey.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final bytes = data!.buffer.asUint8List();
      if (bytes.length > 36 * 1024) {
        throw const ProtocolException('스케치가 너무 큽니다. 일부 선을 지우고 다시 보내세요.');
      }
      final encoded = 'data:image/png;base64,${base64Encode(bytes)}';
      final response = await widget.state.session.sendBrowserSketch(
        _agentRef,
        _tabRef,
        encoded,
        _sketchText.text.trim(),
      );
      if (mounted) {
        widget.state.addBrowserDraft(_agentRef, response);
        Navigator.of(context).pop(true);
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } on ProtocolException catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  Future<void> _showMore(BrowserTab tab) => showIrisSheet<void>(
    context: context,
    builder: (sheetContext) => BrowserMoreSheet(
      session: widget.state.session,
      tab: tab,
      desktop: _desktop,
      inputMode: _inputMode,
      onDesktop: (enabled) async {
        Navigator.of(context, rootNavigator: true).pop();
        await _action(
          () => widget.state.session.setBrowserDesktop(_tabRef, enabled),
        );
        if (mounted) {
          setState(() {
            _desktop = enabled;
            _frame = null;
          });
        }
        await _watch();
      },
      onDirect: () async {
        Navigator.of(sheetContext).pop();
        if (_tool == BrowserTool.pick) _setTool(BrowserTool.none);
        await _action(
          () => widget.state.session.takeBrowserControl(_tabRef),
          after: () {
            if (mounted) _setTool(BrowserTool.direct);
          },
        );
      },
      onInputMode: (mode) {
        Navigator.of(sheetContext).pop();
        setState(() => _inputMode = mode);
      },
      onReload: () {
        Navigator.of(sheetContext).pop();
        _history('reload');
      },
      onForward: () {
        Navigator.of(sheetContext).pop();
        _history('forward');
      },
      onNewTab: () {
        Navigator.of(sheetContext).pop();
        _newTab(tab.space);
      },
      onTranslate: () {
        Navigator.of(sheetContext).pop();
        _action(() => widget.state.session.translateBrowser(_tabRef));
      },
      onBookmark: () {
        Navigator.of(sheetContext).pop();
        _showBookmarks(tab);
      },
      onCopy: () {
        Clipboard.setData(ClipboardData(text: tab.url));
        Navigator.of(sheetContext).pop();
      },
      onContext: widget.state.supports('browser.mouse') && _frame != null
          ? () {
              Navigator.of(sheetContext).pop();
              final frame = _frame!;
              unawaited(
                _sendMouse(
                  _FramePoint(
                    x: _cursor.dx * frame.width,
                    y: _cursor.dy * frame.height,
                    width: frame.width,
                    height: frame.height,
                  ),
                  'context',
                ),
              );
            }
          : null,
      onProfile: (profile) {
        Navigator.of(sheetContext).pop();
        _action(
          () => widget.state.session.setBrowserProfile(_tabRef, profile),
          after: widget.state.refreshBrowserTabs,
        );
      },
      profileDetails: widget.profileDetails,
      showChromeImport: widget.showChromeImport,
    ),
  );

  Future<void> _openMore(BrowserTab tab) async {
    setState(() => _moreSelected = true);
    await _showMore(tab);
    if (mounted) setState(() => _moreSelected = false);
  }

  Future<void> _showBookmarks(BrowserTab tab) async {
    if (!widget.state.supports('browser.bookmarks')) {
      await _bookmark(true);
      return;
    }
    try {
      final result = await widget.state.session.browserBookmarks(tab.space);
      if (!mounted) return;
      await showIrisSheet<void>(
        context: context,
        builder: (sheetContext) => BrowserBookmarksSheet(
          bookmarks: result.bookmarks,
          canSave: widget.state.supports('browser.bookmark.set'),
          onSave: () {
            Navigator.of(sheetContext).pop();
            _bookmark(true);
          },
          onOpen: (bookmark) {
            Navigator.of(sheetContext).pop();
            _address.text = bookmark.url;
            _navigate();
          },
        ),
      );
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  String _host(BrowserTab tab) => Uri.tryParse(tab.url)?.host.isNotEmpty == true
      ? Uri.parse(tab.url).host
      : tab.title;
}

class _AddressBar extends StatefulWidget {
  const _AddressBar({
    required this.controller,
    required this.profile,
    required this.desktop,
    required this.canNavigate,
    required this.onNavigate,
    this.onBookmark,
  });
  final TextEditingController controller;
  final String profile;
  final bool desktop;
  final bool canNavigate;
  final VoidCallback onNavigate;
  final VoidCallback? onBookmark;

  @override
  State<_AddressBar> createState() => _AddressBarState();
}

class _AddressBarState extends State<_AddressBar> {
  final FocusNode _focus = FocusNode();

  @override
  void initState() {
    super.initState();
    _focus.addListener(_focusChanged);
  }

  @override
  void dispose() {
    _focus
      ..removeListener(_focusChanged)
      ..dispose();
    super.dispose();
  }

  void _focusChanged() => setState(() {});

  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('browser-address-area'),
    height: 54,
    child: Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      child: Container(
        key: const Key('browser-address'),
        height: 42,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: context.iris.level1,
          borderRadius: BorderRadius.circular(13),
        ),
        child: Row(
          children: [
            IrisIcon(
              widget.desktop ? 'monitor' : 'lock-simple',
              size: 15,
              color: context.iris.foreground2,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Stack(
                alignment: Alignment.centerLeft,
                children: [
                  TextField(
                    focusNode: _focus,
                    controller: widget.controller,
                    readOnly: !widget.canNavigate,
                    maxLines: 1,
                    onSubmitted: (_) {
                      widget.onNavigate();
                      _focus.unfocus();
                    },
                    onTapOutside: (_) => _focus.unfocus(),
                    style: TextStyle(
                      color: _focus.hasFocus
                          ? context.iris.foreground
                          : Colors.transparent,
                      fontSize: 15,
                    ),
                    cursorColor: context.iris.foreground,
                    decoration: const InputDecoration(
                      border: InputBorder.none,
                      enabledBorder: InputBorder.none,
                      focusedBorder: InputBorder.none,
                      filled: false,
                      isDense: true,
                      contentPadding: EdgeInsets.zero,
                    ),
                  ),
                  if (!_focus.hasFocus)
                    IgnorePointer(child: _AddressText(widget.controller.text)),
                ],
              ),
            ),
            if (widget.onBookmark != null)
              IconButton(
                onPressed: widget.onBookmark,
                padding: EdgeInsets.zero,
                constraints: const BoxConstraints.tightFor(
                  width: 34,
                  height: 34,
                ),
                icon: const IrisIcon('bookmark-simple', size: 17),
              ),
            Container(
              height: 28,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Row(
                children: [
                  if (!widget.desktop) ...[
                    IrisIcon('user', size: 13, color: context.iris.foreground2),
                    const SizedBox(width: 5),
                  ],
                  Text(
                    widget.desktop ? '데스크톱' : widget.profile,
                    style: TextStyle(
                      color: widget.desktop
                          ? context.iris.brand
                          : context.iris.foreground2,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _AddressText extends StatelessWidget {
  const _AddressText(this.value);

  final String value;

  @override
  Widget build(BuildContext context) {
    final uri = Uri.tryParse(value);
    final host = uri?.host.isNotEmpty == true ? uri!.host : value;
    final path = uri?.host.isNotEmpty == true
        ? '${uri!.path}${uri.hasQuery ? '?${uri.query}' : ''}'
        : '';
    return Text.rich(
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      TextSpan(
        style: TextStyle(fontSize: 15, color: context.iris.foreground2),
        children: [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: SizedBox(
              width: 66,
              height: 18,
              child: FittedBox(
                fit: BoxFit.fill,
                alignment: Alignment.centerLeft,
                child: SizedBox(
                  width: 70,
                  height: 18,
                  child: Text(
                    host,
                    maxLines: 1,
                    softWrap: false,
                    style: TextStyle(
                      color: context.iris.foreground,
                      fontSize: 15,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ),
          const WidgetSpan(child: SizedBox(width: 8)),
          TextSpan(text: path),
        ],
      ),
    );
  }
}

String _typingLabel(List<String> controlling) {
  if (controlling.isEmpty) return '에이전트가 입력 중';
  final name = controlling.join(', ');
  final last = name.runes.last;
  final hasFinalConsonant =
      last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 != 0;
  return '$name${hasFinalConsonant ? '이' : '가'} 입력 중';
}

class _FramePoint {
  const _FramePoint({
    required this.x,
    required this.y,
    required this.width,
    required this.height,
  });
  final double x;
  final double y;
  final int width;
  final int height;
}

class _PendingMouseMotion {
  const _PendingMouseMotion(this.point, this.action, {required this.hover});

  final _FramePoint point;
  final String action;
  final bool hover;
}

class _FrameViewport {
  const _FrameViewport({
    required this.size,
    required this.frameWidth,
    required this.frameHeight,
    required this.zoom,
    required this.pan,
  });

  final Size size;
  final int frameWidth;
  final int frameHeight;
  final double zoom;
  final Offset pan;

  Rect get baseRect {
    final scale = (size.width / frameWidth < size.height / frameHeight)
        ? size.width / frameWidth
        : size.height / frameHeight;
    final shown = Size(frameWidth * scale, frameHeight * scale);
    return Rect.fromCenter(
      center: size.center(Offset.zero),
      width: shown.width,
      height: shown.height,
    );
  }

  Offset clampPan(Offset value, [double? atZoom]) {
    final rect = baseRect;
    final scale = atZoom ?? zoom;
    final maximum = Offset(
      rect.width * (scale - 1) / 2,
      rect.height * (scale - 1) / 2,
    );
    return Offset(
      value.dx.clamp(-maximum.dx, maximum.dx),
      value.dy.clamp(-maximum.dy, maximum.dy),
    );
  }

  Rect get imageRect {
    final rect = baseRect;
    final value = clampPan(pan);
    return Rect.fromCenter(
      center: rect.center + value,
      width: rect.width * zoom,
      height: rect.height * zoom,
    );
  }

  Offset frameToLocal(Offset normalized) => Offset(
    imageRect.left + imageRect.width * normalized.dx,
    imageRect.top + imageRect.height * normalized.dy,
  );

  _FramePoint? localToFrame(Offset local) {
    final rect = imageRect;
    final x = (local.dx - rect.left) / rect.width;
    final y = (local.dy - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return _FramePoint(
      x: x * frameWidth,
      y: y * frameHeight,
      width: frameWidth,
      height: frameHeight,
    );
  }

  _FramePoint normalizedPoint(Offset normalized) => _FramePoint(
    x: normalized.dx * frameWidth,
    y: normalized.dy * frameHeight,
    width: frameWidth,
    height: frameHeight,
  );
}

@visibleForTesting
Offset browserCursorFollowPan({
  required Size size,
  required Size frameSize,
  required double zoom,
  required Offset pan,
  required Offset cursor,
}) {
  if (zoom <= 1 || size.isEmpty || frameSize.isEmpty) return pan;
  final viewport = _FrameViewport(
    size: size,
    frameWidth: frameSize.width.round(),
    frameHeight: frameSize.height.round(),
    zoom: zoom,
    pan: pan,
  );
  final local = viewport.frameToLocal(cursor);
  final marginX = (size.width * 0.16).clamp(36.0, 64.0);
  final marginY = (size.height * 0.14).clamp(36.0, 64.0);
  var delta = Offset.zero;
  if (local.dx < marginX) {
    delta = Offset(marginX - local.dx, delta.dy);
  } else if (local.dx > size.width - marginX) {
    delta = Offset(size.width - marginX - local.dx, delta.dy);
  }
  if (local.dy < marginY) {
    delta = Offset(delta.dx, marginY - local.dy);
  } else if (local.dy > size.height - marginY) {
    delta = Offset(delta.dx, size.height - marginY - local.dy);
  }
  if (delta == Offset.zero) return pan;
  return viewport.clampPan(pan + delta * 0.45);
}

class _FrameSurface extends StatefulWidget {
  const _FrameSurface({
    required this.frame,
    required this.referenceImage,
    required this.error,
    required this.inputMode,
    required this.cursor,
    required this.zoom,
    required this.highlightedElement,
    required this.canDirectTap,
    required this.canDirectScroll,
    required this.onCursor,
    required this.onMouse,
    required this.onDirectTap,
    required this.onDirectScroll,
    required this.onZoom,
    required this.onZoomEnd,
    super.key,
  });
  final BrowserFrame? frame;
  final ui.Image? referenceImage;
  final String? error;
  final BrowserInputMode inputMode;
  final Offset cursor;
  final double zoom;
  final BrowserElementHoverResult? highlightedElement;
  final bool canDirectTap;
  final bool canDirectScroll;
  final void Function(Offset cursor, _FramePoint point, String action) onCursor;
  final Future<void> Function(_FramePoint point, String action, [int? dy])
  onMouse;
  final void Function(_FramePoint point, String action) onDirectTap;
  final ValueChanged<int> onDirectScroll;
  final ValueChanged<double> onZoom;
  final VoidCallback onZoomEnd;

  @override
  State<_FrameSurface> createState() => _FrameSurfaceState();
}

class _FrameSurfaceState extends State<_FrameSurface> {
  static const _moveThreshold = 6.0;
  static const _cursorSpeed = 1.35;
  final Map<int, Offset> _pointers = {};
  final Set<int> _multiMovedPointers = {};
  late Offset _cursor;
  Offset _pan = Offset.zero;
  Offset _primaryDown = Offset.zero;
  Offset _primaryLast = Offset.zero;
  Offset _multiStartCenter = Offset.zero;
  Offset _multiLastCenter = Offset.zero;
  Offset _multiStartPan = Offset.zero;
  double _multiStartDistance = 1;
  double _multiStartZoom = 1;
  double _directDragDy = 0;
  double _wheelDy = 0;
  bool _primaryMoved = false;
  bool _dragging = false;
  bool _multi = false;
  bool _pinching = false;
  bool _scrolling = false;
  bool _suppressUntilAllUp = false;
  Timer? _longPressTimer;
  Timer? _singleTapTimer;

  @override
  void initState() {
    super.initState();
    _cursor = widget.cursor;
  }

  @override
  void didUpdateWidget(covariant _FrameSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.cursor != oldWidget.cursor && widget.cursor != _cursor) {
      _cursor = widget.cursor;
    }
    if (widget.zoom <= 1 && oldWidget.zoom > 1) _pan = Offset.zero;
  }

  @override
  void dispose() {
    _longPressTimer?.cancel();
    _singleTapTimer?.cancel();
    super.dispose();
  }

  _FrameViewport? _viewport(Size size) {
    final frame = widget.frame;
    if (frame == null || size.isEmpty) return null;
    return _FrameViewport(
      size: size,
      frameWidth: frame.width,
      frameHeight: frame.height,
      zoom: widget.zoom,
      pan: _pan,
    );
  }

  List<Offset> get _twoPointers => _pointers.values.take(2).toList();

  Offset _center(List<Offset> points) => (points[0] + points[1]) / 2;

  double _distance(List<Offset> points) => (points[0] - points[1]).distance;

  void _beginMulti() {
    final points = _twoPointers;
    if (points.length < 2) return;
    _longPressTimer?.cancel();
    _singleTapTimer?.cancel();
    _multi = true;
    _pinching = false;
    _scrolling = false;
    _multiMovedPointers.clear();
    _primaryMoved = true;
    _multiStartCenter = _center(points);
    _multiLastCenter = _multiStartCenter;
    _multiStartDistance = _distance(points).clamp(1, double.infinity);
    _multiStartZoom = widget.zoom;
    _multiStartPan = _pan;
    _wheelDy = 0;
  }

  void _startLongPress(Size size) {
    _longPressTimer?.cancel();
    if (widget.inputMode != BrowserInputMode.trackpad) return;
    _longPressTimer = Timer(const Duration(milliseconds: 360), () {
      if (!mounted || _pointers.length != 1 || _primaryMoved || _multi) return;
      final viewport = _viewport(size);
      if (viewport == null) return;
      _dragging = true;
      unawaited(widget.onMouse(viewport.normalizedPoint(_cursor), 'down'));
    });
  }

  void _pointerDown(PointerDownEvent event, Size size) {
    _pointers[event.pointer] = event.localPosition;
    if (_pointers.length == 1) {
      _primaryDown = event.localPosition;
      _primaryLast = event.localPosition;
      _primaryMoved = false;
      _directDragDy = 0;
      _suppressUntilAllUp = false;
      _startLongPress(size);
    } else if (_pointers.length == 2) {
      _beginMulti();
    }
  }

  void _pointerMove(PointerMoveEvent event, Size size) {
    if (!_pointers.containsKey(event.pointer)) return;
    _pointers[event.pointer] = event.localPosition;
    final viewport = _viewport(size);
    if (viewport == null) return;
    if (_pointers.length >= 2) {
      if (!_multi) _beginMulti();
      _multiMovedPointers.add(event.pointer);
      final points = _twoPointers;
      final center = _center(points);
      final ratio = _distance(points) / _multiStartDistance;
      if (!_pinching && !_scrolling) {
        if (_multiMovedPointers.length < 2) return;
        final distanceChange = (_distance(points) - _multiStartDistance).abs();
        final centerMove = (center - _multiStartCenter).distance;
        if (distanceChange >= _moveThreshold &&
            distanceChange > centerMove * 0.75) {
          _pinching = true;
        } else if (centerMove >= _moveThreshold) {
          _scrolling = true;
          _wheelDy = center.dy - _multiStartCenter.dy;
          _multiLastCenter = center;
          return;
        } else {
          return;
        }
      }
      if (_pinching) {
        final zoom = (_multiStartZoom * ratio).clamp(1.0, 4.0);
        final base = viewport.baseRect;
        final source =
            (_multiStartCenter - base.center - _multiStartPan) /
            _multiStartZoom;
        final nextPan = center - base.center - source * zoom;
        setState(() => _pan = viewport.clampPan(nextPan, zoom));
        widget.onZoom(zoom);
      } else if (_scrolling) {
        _wheelDy += center.dy - _multiLastCenter.dy;
      }
      _multiLastCenter = center;
      return;
    }
    if (_suppressUntilAllUp) return;
    final delta = event.localPosition - _primaryLast;
    _primaryLast = event.localPosition;
    if ((event.localPosition - _primaryDown).distance >= _moveThreshold) {
      _primaryMoved = true;
      _longPressTimer?.cancel();
    }
    if (!_primaryMoved && !_dragging) return;
    if (widget.inputMode == BrowserInputMode.trackpad) {
      final rect = viewport.imageRect;
      final cursor = Offset(
        (_cursor.dx + delta.dx * _cursorSpeed / rect.width).clamp(0.0, 1.0),
        (_cursor.dy + delta.dy * _cursorSpeed / rect.height).clamp(0.0, 1.0),
      );
      _cursor = cursor;
      final followedPan = browserCursorFollowPan(
        size: size,
        frameSize: Size(
          widget.frame!.width.toDouble(),
          widget.frame!.height.toDouble(),
        ),
        zoom: widget.zoom,
        pan: _pan,
        cursor: cursor,
      );
      if (followedPan != _pan) setState(() => _pan = followedPan);
      widget.onCursor(
        cursor,
        viewport.normalizedPoint(cursor),
        _dragging ? 'drag' : 'move',
      );
    } else if (widget.canDirectScroll) {
      _directDragDy += delta.dy;
    }
  }

  void _pointerUp(PointerEvent event, Size size) {
    final wasMulti = _multi;
    _pointers.remove(event.pointer);
    _longPressTimer?.cancel();
    final viewport = _viewport(size);
    if (wasMulti) {
      if (_pointers.length < 2) {
        _multi = false;
        _suppressUntilAllUp = true;
        if (_pinching) {
          widget.onZoomEnd();
        } else if (viewport != null && _wheelDy.abs() >= _moveThreshold) {
          final dy =
              (-_wheelDy * widget.frame!.height / viewport.baseRect.height)
                  .round()
                  .clamp(-20000, 20000);
          if (dy != 0) {
            if (widget.inputMode == BrowserInputMode.trackpad) {
              unawaited(
                widget.onMouse(viewport.normalizedPoint(_cursor), 'wheel', dy),
              );
            } else if (widget.canDirectScroll) {
              widget.onDirectScroll(dy);
            }
          }
        }
        _pinching = false;
        _scrolling = false;
        _multiMovedPointers.clear();
        _wheelDy = 0;
      }
      if (_pointers.isEmpty) _suppressUntilAllUp = false;
      return;
    }
    if (_dragging && viewport != null) {
      _dragging = false;
      unawaited(widget.onMouse(viewport.normalizedPoint(_cursor), 'up'));
      return;
    }
    if (_primaryMoved) {
      if (widget.inputMode == BrowserInputMode.direct &&
          widget.canDirectScroll &&
          viewport != null &&
          _directDragDy.abs() >= _moveThreshold) {
        final dy =
            (-_directDragDy * widget.frame!.height / viewport.baseRect.height)
                .round()
                .clamp(-20000, 20000);
        if (dy != 0) widget.onDirectScroll(dy);
      }
      return;
    }
    if (_suppressUntilAllUp || viewport == null) return;
    final point = widget.inputMode == BrowserInputMode.trackpad
        ? viewport.normalizedPoint(_cursor)
        : viewport.localToFrame(event.localPosition);
    if (point == null ||
        (widget.inputMode == BrowserInputMode.direct && !widget.canDirectTap)) {
      return;
    }
    if (_singleTapTimer?.isActive == true) {
      _singleTapTimer!.cancel();
      _singleTapTimer = null;
      if (widget.inputMode == BrowserInputMode.trackpad) {
        unawaited(widget.onMouse(point, 'double'));
      } else {
        widget.onDirectTap(point, 'double');
      }
      return;
    }
    _singleTapTimer = Timer(const Duration(milliseconds: 260), () {
      _singleTapTimer = null;
      if (!mounted) return;
      if (widget.inputMode == BrowserInputMode.trackpad) {
        unawaited(widget.onMouse(point, 'click'));
      } else {
        widget.onDirectTap(point, 'click');
      }
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final size = constraints.biggest;
      final viewport = _viewport(size);
      final imageRect = viewport?.imageRect;
      final cursor = viewport?.frameToLocal(_cursor);
      final highlighted = widget.highlightedElement;
      Rect? highlightRect;
      String? highlightLabel;
      final highlightLabelWidth = (size.width * 0.72).clamp(160.0, 280.0);
      if (viewport != null && highlighted?.element != null) {
        final current = highlighted!;
        final highlightedElement = current.element!;
        final source = highlightedElement.rect;
        final sourceSize = current.viewport;
        final topLeft = viewport.frameToLocal(
          Offset(source.x / sourceSize.width, source.y / sourceSize.height),
        );
        final bottomRight = viewport.frameToLocal(
          Offset(
            (source.x + source.width) / sourceSize.width,
            (source.y + source.height) / sourceSize.height,
          ),
        );
        highlightRect = Rect.fromPoints(topLeft, bottomRight);
        highlightLabel =
            '${highlightedElement.selector}  '
            '${source.width.round()}×${source.height.round()}';
      }
      return Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: (event) => _pointerDown(event, size),
        onPointerMove: (event) => _pointerMove(event, size),
        onPointerUp: (event) => _pointerUp(event, size),
        onPointerCancel: (event) => _pointerUp(event, size),
        child: ClipRect(
          child: ColoredBox(
            color: const Color(0xfff7f7f5),
            child: widget.error != null
                ? Center(
                    child: Text(
                      widget.error!,
                      style: const TextStyle(color: Color(0xff555555)),
                    ),
                  )
                : widget.frame == null
                ? const Center(child: CircularProgressIndicator())
                : Stack(
                    clipBehavior: Clip.hardEdge,
                    children: [
                      if (imageRect != null)
                        Positioned.fromRect(
                          rect: imageRect,
                          child: widget.referenceImage != null
                              ? RawImage(
                                  image: widget.referenceImage,
                                  fit: BoxFit.fill,
                                  filterQuality: FilterQuality.medium,
                                )
                              : Image.memory(
                                  widget.frame!.jpeg,
                                  fit: BoxFit.fill,
                                  gaplessPlayback: true,
                                  filterQuality: FilterQuality.medium,
                                ),
                        ),
                      if (highlightRect != null && highlightLabel != null) ...[
                        Positioned.fromRect(
                          rect: highlightRect,
                          child: IgnorePointer(
                            child: Container(
                              key: const Key('browser-element-highlight'),
                              decoration: BoxDecoration(
                                color: const Color(0x3df4a1a7),
                                borderRadius: BorderRadius.circular(3),
                                border: Border.all(
                                  color: const Color(0xfff4a1a7),
                                  width: 3,
                                ),
                              ),
                            ),
                          ),
                        ),
                        Positioned(
                          left: highlightRect.left.clamp(
                            4.0,
                            (size.width - highlightLabelWidth - 8).clamp(
                              4.0,
                              size.width,
                            ),
                          ),
                          top: (highlightRect.top - 30).clamp(
                            4.0,
                            (size.height - 28).clamp(4.0, size.height),
                          ),
                          child: IgnorePointer(
                            child: Container(
                              key: const Key('browser-element-highlight-label'),
                              constraints: BoxConstraints(
                                maxWidth: highlightLabelWidth,
                              ),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                                vertical: 4,
                              ),
                              decoration: BoxDecoration(
                                color: const Color(0xfff4a1a7),
                                borderRadius: BorderRadius.circular(3),
                                boxShadow: const [
                                  BoxShadow(
                                    color: Color(0x66000000),
                                    blurRadius: 5,
                                    offset: Offset(0, 2),
                                  ),
                                ],
                              ),
                              child: Text(
                                highlightLabel,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  color: Color(0xff1a1a1a),
                                  fontFamily: 'monospace',
                                  fontSize: 12,
                                  height: 1.4,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                      if (widget.inputMode == BrowserInputMode.trackpad &&
                          cursor != null)
                        Positioned(
                          key: const Key('browser-cursor'),
                          left: cursor.dx - 1.3,
                          top: cursor.dy - 1.3,
                          width: 18,
                          height: 22,
                          child: IgnorePointer(
                            child: Semantics(
                              label: '마우스 커서',
                              child: const CustomPaint(
                                painter: _CursorPainter(),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
          ),
        ),
      );
    },
  );
}

class _CursorPainter extends CustomPainter {
  const _CursorPainter();

  @override
  void paint(Canvas canvas, Size size) {
    // 28×34 기준 모양을 받은 크기에 맞춰 축소
    canvas.scale(size.width / 28, size.height / 34);
    final path = Path()
      ..moveTo(3, 2)
      ..lineTo(3, 26)
      ..lineTo(9, 20)
      ..lineTo(14, 31)
      ..lineTo(20, 28)
      ..lineTo(15, 18)
      ..lineTo(24, 18)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xff111820)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 5
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.fill,
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xff111820)
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.2
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _ConnectionNotice extends StatelessWidget {
  const _ConnectionNotice();

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      key: const Key('browser-reconnecting'),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xe6111820),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: const Color(0x66ffffff)),
      ),
      child: const Text(
        '컴퓨터과 다시 연결하고 있습니다.',
        style: TextStyle(
          color: Colors.white,
          fontSize: 12,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );
}

class _BrowserMessageResult extends StatelessWidget {
  const _BrowserMessageResult({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Container(
    key: const Key('browser-message-result'),
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(20, 7, 20, 0),
    color: context.iris.background,
    child: Text(
      text,
      style: TextStyle(color: context.iris.muted, fontSize: 13),
    ),
  );
}

class _BrowserToolbar extends StatelessWidget {
  const _BrowserToolbar({
    required this.selected,
    required this.moreSelected,
    required this.canBack,
    required this.canPick,
    required this.canRecord,
    required this.canSketch,
    required this.onBack,
    required this.onPick,
    required this.onRecord,
    required this.onSketch,
    required this.onMore,
  });
  final BrowserTool selected;
  final bool moreSelected;
  final bool canBack;
  final bool canPick;
  final bool canRecord;
  final bool canSketch;
  final VoidCallback onBack;
  final VoidCallback onPick;
  final VoidCallback onRecord;
  final VoidCallback onSketch;
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    final actions = <Widget>[
      if (canBack) _ToolButton(icon: 'arrow-left', label: '뒤로', onTap: onBack),
      if (canPick)
        _ToolButton(
          icon: 'cursor-click',
          label: '요소 선택',
          selected: selected == BrowserTool.pick,
          onTap: onPick,
        ),
      if (canRecord)
        _ToolButton(icon: 'record', label: '조작 기록', onTap: onRecord),
      if (canSketch)
        _ToolButton(icon: 'scribble-loop', label: '스케치', onTap: onSketch),
      _ToolButton(
        icon: 'dots-three',
        label: '더보기',
        selected: moreSelected,
        onTap: onMore,
      ),
    ];
    return Container(
      key: const Key('browser-toolbar'),
      height: 60 + irisBottomInset(context),
      padding: EdgeInsets.fromLTRB(8, 6, 8, irisBottomInset(context)),
      decoration: BoxDecoration(
        color: context.iris.background,
        border: Border(top: BorderSide(color: context.iris.separator)),
      ),
      child: Row(
        children: [for (final action in actions) Expanded(child: action)],
      ),
    );
  }
}

class _ToolButton extends StatelessWidget {
  const _ToolButton({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
  });
  final String icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) => TextButton(
    onPressed: onTap,
    style: ButtonStyle(
      padding: const WidgetStatePropertyAll(EdgeInsets.zero),
      foregroundColor: WidgetStatePropertyAll(
        selected ? context.iris.brand : context.iris.foreground2,
      ),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
    ),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        IrisIcon(icon, size: 21),
        const SizedBox(height: 4),
        Text(
          label,
          style: TextStyle(
            color: selected ? context.iris.brand : context.iris.foreground2,
            fontSize: 11,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    ),
  );
}

class _PageInputControls extends StatefulWidget {
  const _PageInputControls({
    required this.focus,
    required this.onText,
    required this.onKey,
    required this.onPaste,
    required this.onCopy,
    required this.onClose,
  });

  final BrowserFocusResult focus;
  final ValueChanged<String> onText;
  final ValueChanged<String> onKey;
  final VoidCallback onPaste;
  final VoidCallback onCopy;
  final VoidCallback onClose;

  @override
  State<_PageInputControls> createState() => _PageInputControlsState();
}

class _PageInputControlsState extends State<_PageInputControls>
    with WidgetsBindingObserver {
  static const _sentinel = '\u200b';
  final _controller = TextEditingController(text: _sentinel);
  final _focusNode = FocusNode();
  String _committed = '';
  bool _restoring = false;
  bool _keyboardWasVisible = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller.addListener(_editingChanged);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focusNode.requestFocus();
    });
  }

  @override
  void didChangeMetrics() {
    final views = WidgetsBinding.instance.platformDispatcher.views;
    final visible = views.isNotEmpty && views.first.viewInsets.bottom > 0;
    if (_keyboardWasVisible && !visible && mounted) widget.onClose();
    _keyboardWasVisible = visible;
  }

  void _editingChanged() {
    if (_restoring) return;
    final value = _controller.value;
    if (!value.text.startsWith(_sentinel)) {
      widget.onKey('Backspace');
      _restoring = true;
      _controller.value = const TextEditingValue(
        text: _sentinel,
        selection: TextSelection.collapsed(offset: 1),
      );
      _restoring = false;
      _committed = '';
      return;
    }
    final composing = value.composing;
    final committedEnd = composing.isValid && !composing.isCollapsed
        ? composing.start.clamp(1, value.text.length)
        : value.text.length;
    final current = value.text.substring(1, committedEnd);
    var common = 0;
    while (common < current.length &&
        common < _committed.length &&
        current.codeUnitAt(common) == _committed.codeUnitAt(common)) {
      common++;
    }
    final removed = _committed.substring(common).runes.length;
    for (var index = 0; index < removed; index++) {
      widget.onKey('Backspace');
    }
    final inserted = current.substring(common);
    if (inserted.isNotEmpty) widget.onText(inserted);
    _committed = current;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller
      ..removeListener(_editingChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => TextFieldTapRegion(
    child: Container(
      key: const Key('browser-page-input-controls'),
      padding: EdgeInsets.fromLTRB(8, 7, 8, irisSheetBottom(context) + 7),
      decoration: BoxDecoration(
        color: context.iris.level1,
        border: Border(top: BorderSide(color: context.iris.separator)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: 1,
            height: 1,
            child: Opacity(
              opacity: 0,
              child: TextField(
                key: const Key('browser-page-input'),
                controller: _controller,
                focusNode: _focusNode,
                autofocus: true,
                keyboardType: widget.focus.multiline
                    ? TextInputType.multiline
                    : TextInputType.text,
                textInputAction: widget.focus.multiline
                    ? TextInputAction.newline
                    : TextInputAction.none,
                maxLines: widget.focus.multiline ? null : 1,
              ),
            ),
          ),
          SizedBox(
            height: 38,
            child: ListView(
              scrollDirection: Axis.horizontal,
              children: [
                _PageKey(
                  key: const Key('browser-page-backspace'),
                  label: '지우기',
                  onTap: () => widget.onKey('Backspace'),
                ),
                _PageKey(
                  key: const Key('browser-page-enter'),
                  label: 'Enter',
                  onTap: () => widget.onKey('Enter'),
                ),
                _PageKey(label: 'Tab', onTap: () => widget.onKey('Tab')),
                _PageKey(label: '←', onTap: () => widget.onKey('ArrowLeft')),
                _PageKey(label: '→', onTap: () => widget.onKey('ArrowRight')),
                _PageKey(label: '↑', onTap: () => widget.onKey('ArrowUp')),
                _PageKey(label: '↓', onTap: () => widget.onKey('ArrowDown')),
                _PageKey(label: 'Esc', onTap: () => widget.onKey('Escape')),
                _PageKey(
                  key: const Key('browser-page-paste'),
                  label: '붙여넣기',
                  onTap: widget.onPaste,
                ),
                _PageKey(label: '복사', onTap: widget.onCopy),
                _PageKey(label: '닫기', onTap: widget.onClose),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

class _PageKey extends StatelessWidget {
  const _PageKey({required this.label, required this.onTap, super.key});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(right: 6),
    child: ExcludeFocus(
      child: TextButton(
        onPressed: onTap,
        style: ButtonStyle(
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 12),
          ),
          backgroundColor: WidgetStatePropertyAll(context.iris.level2),
          foregroundColor: WidgetStatePropertyAll(context.iris.foreground),
        ),
        child: Text(label),
      ),
    ),
  );
}

class BrowserElementSheet extends StatefulWidget {
  const BrowserElementSheet({
    required this.element,
    required this.destination,
    required this.onSend,
    this.component,
    this.source,
    super.key,
  });
  final BrowserElement element;
  final String destination;
  final Future<BrowserDraftResult> Function(String text) onSend;
  final String? component;
  final String? source;

  @override
  State<BrowserElementSheet> createState() => _BrowserElementSheetState();
}

class _BrowserElementSheetState extends State<BrowserElementSheet> {
  final _text = TextEditingController();
  String? _result;
  bool _busy = false;
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('browser-element-sheet'),
    height: 148.8,
    child: Column(
      children: [
        const IrisSheetGrabber(),
        const SizedBox(height: 14),
        SizedBox(
          height: 34,
          child: Row(
            children: [
              SizedBox(
                width: 32,
                height: 30,
                child: Center(
                  child: IrisIcon(
                    'cursor-click',
                    size: 20,
                    color: context.iris.foreground2,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '선택한 요소',
                        style: TextStyle(
                          color: context.iris.foreground2,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          height: 17 / 14,
                        ),
                      ),
                      Text(
                        '${widget.element.selector}${widget.source == null ? '' : ' · ${widget.source}'}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13,
                          height: 1.2,
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
        SizedBox(
          height: 48,
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  key: const Key('browser-element-input'),
                  controller: _text,
                  maxLength: 2000,
                  maxLines: 1,
                  style: const TextStyle(
                    fontSize: 17,
                    height: 1.2,
                    letterSpacing: -0.17,
                  ),
                  decoration: InputDecoration(
                    hintText: '이 요소에 요청할 내용',
                    counterText: '',
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14),
                    filled: true,
                    fillColor: context.iris.level1,
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide(color: context.iris.separator),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide(color: context.iris.separator),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IrisRoundButton(
                icon: 'arrow-up',
                size: 48,
                backgroundColor: context.iris.brand,
                foregroundColor: context.iris.onBrand,
                onPressed: _busy ? null : _send,
                tooltip: _busy ? '넣는 중' : '입력칸에 넣기',
              ),
            ],
          ),
        ),
        SizedBox(
          height: 31.8,
          child: Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Align(
              alignment: Alignment.topLeft,
              child: Text.rich(
                TextSpan(
                  text: _result ?? '넣을 곳 · ',
                  children: _result == null
                      ? [
                          WidgetSpan(
                            alignment: PlaceholderAlignment.middle,
                            child: Transform.translate(
                              offset: const Offset(0, -1.4),
                              child: Transform.scale(
                                scaleX: 0.973,
                                scaleY: 0.924,
                                child: Text(
                                  widget.destination,
                                  style: TextStyle(
                                    color: context.iris.foreground,
                                    fontSize: 14.5,
                                    height: 1.5,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ]
                      : const [],
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 14.5,
                  height: 1.5,
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );

  Future<void> _send() async {
    if (_text.text.isEmpty) return;
    setState(() => _busy = true);
    try {
      final response = await widget.onSend(_text.text);
      if (mounted) Navigator.of(context).pop(response);
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : error is ProtocolException
              ? error.message
              : '컴퓨터과 연결이 끊겼습니다.',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

class BrowserMoreSheet extends StatefulWidget {
  const BrowserMoreSheet({
    required this.session,
    required this.tab,
    required this.desktop,
    required this.inputMode,
    required this.onDesktop,
    required this.onDirect,
    required this.onInputMode,
    required this.onReload,
    required this.onForward,
    required this.onNewTab,
    required this.onTranslate,
    required this.onBookmark,
    required this.onCopy,
    this.onContext,
    required this.onProfile,
    this.profileDetails = const {},
    this.showChromeImport = false,
    super.key,
  });
  final ActiveRemoteSession session;
  final BrowserTab tab;
  final bool desktop;
  final BrowserInputMode inputMode;
  final ValueChanged<bool> onDesktop;
  final VoidCallback onDirect;
  final ValueChanged<BrowserInputMode> onInputMode;
  final VoidCallback onReload;
  final VoidCallback onForward;
  final VoidCallback onNewTab;
  final VoidCallback onTranslate;
  final VoidCallback onBookmark;
  final VoidCallback onCopy;
  final VoidCallback? onContext;
  final ValueChanged<String> onProfile;
  final Map<String, String> profileDetails;
  final bool showChromeImport;

  @override
  State<BrowserMoreSheet> createState() => _BrowserMoreSheetState();
}

class BrowserBookmarksSheet extends StatelessWidget {
  const BrowserBookmarksSheet({
    required this.bookmarks,
    required this.canSave,
    required this.onSave,
    required this.onOpen,
    super.key,
  });

  final List<BrowserBookmark> bookmarks;
  final bool canSave;
  final VoidCallback onSave;
  final ValueChanged<BrowserBookmark> onOpen;

  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('browser-bookmarks-sheet'),
    height: 430,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const IrisSheetGrabber(),
        const SizedBox(height: 18),
        Row(
          children: [
            const Expanded(
              child: Text(
                '북마크',
                style: TextStyle(fontSize: 21, fontWeight: FontWeight.w700),
              ),
            ),
            if (canSave)
              TextButton(onPressed: onSave, child: const Text('현재 탭 추가')),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: bookmarks.isEmpty
              ? Center(
                  child: Text(
                    '저장한 북마크가 없습니다.',
                    style: TextStyle(color: context.iris.muted),
                  ),
                )
              : ListView.separated(
                  itemCount: bookmarks.length,
                  separatorBuilder: (_, _) =>
                      Divider(height: 1, color: context.iris.separator),
                  itemBuilder: (context, index) {
                    final bookmark = bookmarks[index];
                    return SizedBox(
                      height: 58,
                      child: TextButton(
                        onPressed: () => onOpen(bookmark),
                        style: const ButtonStyle(
                          padding: WidgetStatePropertyAll(
                            EdgeInsets.symmetric(horizontal: 4),
                          ),
                        ),
                        child: Row(
                          children: [
                            const IrisIcon('bookmark-simple', size: 18),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    bookmark.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: context.iris.foreground,
                                      fontSize: 15.5,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  Text(
                                    bookmark.url,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: context.iris.muted,
                                      fontSize: 12.5,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const IrisIcon('caret-right', size: 14),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
      ],
    ),
  );
}

class _BrowserMoreSheetState extends State<BrowserMoreSheet> {
  List<String> _profiles = const [];
  @override
  void initState() {
    super.initState();
    if (widget.session.supports('browser.profiles')) _loadProfiles();
  }

  Future<void> _loadProfiles() async {
    try {
      final value = await widget.session.browserProfiles();
      if (mounted) setState(() => _profiles = value.profiles);
    } on RemoteFailure {
      // 프로필 요청 실패는 다른 브라우저 도구 사용을 막지 않음
    }
  }

  @override
  Widget build(BuildContext context) {
    final tools = <Widget>[
      if (widget.session.supports('browser.desktop'))
        _MoreTool(
          icon: 'monitor',
          label: '데스크톱 보기',
          selected: widget.desktop || widget.showChromeImport,
          onTap: () => widget.onDesktop(!widget.desktop),
        ),
      if (widget.session.supports('browser.bookmark.set'))
        _MoreTool(
          icon: 'bookmark-simple',
          label: '북마크',
          onTap: widget.onBookmark,
        ),
      if (widget.session.supports('browser.translate'))
        _MoreTool(icon: 'translate', label: '번역', onTap: widget.onTranslate),
      if (widget.session.supports('browser.direct'))
        _MoreTool(icon: 'user', label: '직접 조작', onTap: widget.onDirect),
      if (widget.session.supports('browser.mouse') &&
          widget.session.supports('browser.pointer'))
        _MoreTool(
          icon: widget.inputMode == BrowserInputMode.trackpad
              ? 'cursor-click'
              : 'hand-tap',
          label: widget.inputMode == BrowserInputMode.trackpad
              ? '직접 누르기'
              : '터치패드',
          onTap: () => widget.onInputMode(
            widget.inputMode == BrowserInputMode.trackpad
                ? BrowserInputMode.direct
                : BrowserInputMode.trackpad,
          ),
        ),
      if (widget.session.supports('browser.history'))
        _MoreTool(
          icon: 'arrow-clockwise',
          label: '새로고침',
          onTap: widget.onReload,
        ),
      if (widget.session.supports('browser.tab.new'))
        _MoreTool(icon: 'plus', label: '새 탭', onTap: widget.onNewTab),
      if (widget.session.supports('browser.tabs') && widget.tab.url.isNotEmpty)
        _MoreTool(icon: 'copy', label: '주소 복사', onTap: widget.onCopy),
      if (widget.onContext != null)
        _MoreTool(
          icon: 'cursor-click',
          label: '오른쪽 클릭',
          onTap: widget.onContext!,
        ),
      if (widget.session.supports('browser.history'))
        _MoreTool(
          icon: 'arrow-left',
          label: '앞으로',
          flip: true,
          onTap: widget.onForward,
        ),
    ];
    return SizedBox(
      key: const Key('browser-more-sheet'),
      height: 520,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 14, 4, 10),
            child: Text(
              '도구',
              style: TextStyle(
                color: context.iris.muted,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          GridView.count(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisCount: 4,
            mainAxisSpacing: 8,
            crossAxisSpacing: 8,
            childAspectRatio: 1.05,
            children: tools,
          ),
          if (_profiles.isNotEmpty || widget.showChromeImport)
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 18, 4, 10),
              child: Text(
                '프로필 · 쿠키와 로그인이 따로 저장됩니다',
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          if (_profiles.isNotEmpty || widget.showChromeImport)
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: context.iris.level2,
                  borderRadius: BorderRadius.circular(18),
                ),
                clipBehavior: Clip.antiAlias,
                child: ListView.builder(
                  key: const Key('browser-profile-list'),
                  itemExtent: 58,
                  itemCount:
                      _profiles.length + (widget.showChromeImport ? 1 : 0),
                  itemBuilder: (context, index) {
                    if (index == _profiles.length) {
                      return _ChromeImportRow(
                        showDivider: _profiles.isNotEmpty,
                      );
                    }
                    final profile = _profiles[index];
                    return _ProfileRow(
                      profile: profile,
                      detail: widget.profileDetails[profile],
                      selected: profile == widget.tab.profile,
                      onTap: () => widget.onProfile(profile),
                    );
                  },
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.profile,
    required this.detail,
    required this.selected,
    required this.onTap,
  });

  final String profile;
  final String? detail;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => TextButton(
    onPressed: onTap,
    style: const ButtonStyle(
      shape: WidgetStatePropertyAll(RoundedRectangleBorder()),
      padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 14)),
    ),
    child: Row(
      children: [
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: (profile == '업무' ? context.iris.working : context.iris.brand)
                .withValues(alpha: 0.16),
            shape: BoxShape.circle,
          ),
          child: Text(
            profile.characters.first,
            style: TextStyle(
              color: profile == '업무'
                  ? context.iris.working
                  : context.iris.brand,
              fontSize: 14,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                profile,
                style: TextStyle(
                  color: context.iris.foreground,
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (detail != null)
                Text(
                  detail!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: context.iris.muted,
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                    height: 1.2,
                  ),
                ),
            ],
          ),
        ),
        if (selected) IrisIcon('check', size: 20, color: context.iris.brand),
      ],
    ),
  );
}

class _ChromeImportRow extends StatelessWidget {
  const _ChromeImportRow({required this.showDivider});

  final bool showDivider;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 14),
    decoration: BoxDecoration(
      color: context.iris.level2,
      border: showDivider
          ? Border(top: BorderSide(color: context.iris.separator))
          : null,
    ),
    child: Row(
      children: [
        Container(
          width: 34,
          height: 34,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: context.iris.level3,
            shape: BoxShape.circle,
          ),
          child: IrisIcon('plus', size: 18, color: context.iris.muted),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            'Chrome에서 가져오기',
            style: TextStyle(
              color: context.iris.foreground2,
              fontSize: 16,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ],
    ),
  );
}

class _MoreTool extends StatelessWidget {
  const _MoreTool({
    required this.icon,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.flip = false,
  });
  final String icon;
  final String label;
  final VoidCallback onTap;
  final bool selected;
  final bool flip;
  @override
  Widget build(BuildContext context) => TextButton(
    onPressed: onTap,
    style: ButtonStyle(
      padding: const WidgetStatePropertyAll(EdgeInsets.zero),
      backgroundColor: WidgetStatePropertyAll(
        selected
            ? context.iris.brand.withValues(alpha: 0.12)
            : context.iris.level2,
      ),
      foregroundColor: WidgetStatePropertyAll(
        selected ? context.iris.brand : context.iris.foreground2,
      ),
      shape: WidgetStatePropertyAll(
        RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: selected
              ? BorderSide(color: context.iris.brand, width: 1.5)
              : BorderSide.none,
        ),
      ),
    ),
    child: Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Transform.flip(flipX: flip, child: IrisIcon(icon, size: 22)),
        const SizedBox(height: 7),
        Text(
          label,
          textAlign: TextAlign.center,
          style: TextStyle(
            color: selected ? context.iris.brand : context.iris.foreground2,
            fontSize: 12.5,
            fontWeight: FontWeight.w400,
          ),
        ),
      ],
    ),
  );
}

class _HumanBanner extends StatelessWidget {
  const _HumanBanner({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
    key: const Key('browser-human-banner'),
    height: 38,
    padding: const EdgeInsets.symmetric(horizontal: 12),
    decoration: BoxDecoration(
      color: const Color(0xe00a1620),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: [
        const IrisIcon('user', size: 18, color: Color(0xffeaf3fa)),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(color: Color(0xffeaf3fa), fontSize: 14),
          ),
        ),
      ],
    ),
  );
}

class _DirectControls extends StatelessWidget {
  const _DirectControls({
    required this.controller,
    required this.human,
    required this.canType,
    required this.onType,
    required this.onBack,
    this.onUnable,
    this.onDone,
  });
  final TextEditingController controller;
  final bool human;
  final bool canType;
  final VoidCallback onType;
  final VoidCallback onBack;
  final VoidCallback? onUnable;
  final VoidCallback? onDone;
  @override
  Widget build(BuildContext context) {
    final safeBottom = irisBottomInset(context);
    return Container(
      key: const Key('browser-direct-controls'),
      height: 54 + safeBottom,
      padding: EdgeInsets.fromLTRB(12, 10, 17, safeBottom),
      color: context.iris.background,
      child: Column(
        children: [
          if (!human && canType)
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: controller,
                    decoration: const InputDecoration(
                      hintText: '브라우저에 입력',
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                IrisRoundButton(icon: 'arrow-up', onPressed: onType),
              ],
            )
          else if (!human)
            const Spacer(),
          if (human)
            Row(
              children: [
                IrisRoundButton(
                  icon: 'arrow-left',
                  backgroundColor: Colors.transparent,
                  onPressed: onBack,
                ),
                const Spacer(),
                IrisButton(
                  label: '못 하겠음',
                  height: 36,
                  expand: false,
                  onPressed: onUnable,
                ),
                const SizedBox(width: 8),
                IrisButton(
                  label: '다 했음',
                  icon: 'check',
                  height: 36,
                  tone: IrisButtonTone.primary,
                  expand: false,
                  onPressed: onDone,
                ),
              ],
            ),
        ],
      ),
    );
  }
}

class _RecordBanner extends StatelessWidget {
  const _RecordBanner({
    required this.result,
    required this.paused,
    required this.onPause,
  });
  final BrowserRecordResult result;
  final bool paused;
  final VoidCallback onPause;
  @override
  Widget build(BuildContext context) => Container(
    key: const Key('browser-record-banner'),
    height: 40,
    padding: const EdgeInsets.fromLTRB(14, 0, 8, 0),
    decoration: BoxDecoration(
      color: const Color(0xff2a0e10),
      borderRadius: BorderRadius.circular(20),
    ),
    child: Row(
      children: [
        Container(
          width: 10,
          height: 10,
          decoration: const BoxDecoration(
            color: Color(0xffff7a72),
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            '조작 기록 중 · ${result.steps.length}단계 · ${_elapsed(result.elapsedMs)}',
            style: const TextStyle(
              color: Color(0xffffd9dc),
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        const SizedBox(width: 10),
        TextButton(
          onPressed: onPause,
          style: ButtonStyle(
            backgroundColor: WidgetStatePropertyAll(
              const Color(0xffffd9dc).withValues(alpha: 0.12),
            ),
            minimumSize: const WidgetStatePropertyAll(Size(72.4, 28)),
            padding: const WidgetStatePropertyAll(
              EdgeInsets.symmetric(horizontal: 10),
            ),
            shape: WidgetStatePropertyAll(
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
            ),
          ),
          child: Text(
            paused ? '계속' : '일시 정지',
            style: const TextStyle(
              color: Color(0xffffd9dc),
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    ),
  );
}

String _elapsed(int milliseconds) {
  final seconds = milliseconds ~/ 1000;
  return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
}

class _RecordControls extends StatelessWidget {
  const _RecordControls({
    required this.controller,
    required this.steps,
    required this.location,
    required this.destination,
    required this.canFinish,
    required this.onCancel,
    required this.onFinish,
  });
  final TextEditingController controller;
  final List<String> steps;
  final String location;
  final String destination;
  final bool canFinish;
  final VoidCallback onCancel;
  final VoidCallback onFinish;
  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('browser-record-controls'),
    height: 349,
    child: OverflowBox(
      alignment: Alignment.topCenter,
      minHeight: 352,
      maxHeight: 352,
      child: Column(
        children: [
          const IrisSheetGrabber(),
          const SizedBox(height: 14),
          Padding(
            padding: const EdgeInsets.only(right: 3),
            child: Row(
              children: [
                SizedBox(
                  width: 32,
                  child: Center(
                    child: IrisIcon(
                      'list-numbers',
                      size: 20,
                      color: context.iris.foreground2,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        height: 18,
                        child: Text(
                          '기록한 조작',
                          strutStyle: const StrutStyle(
                            fontSize: 14,
                            height: 18 / 14,
                            forceStrutHeight: true,
                          ),
                          style: TextStyle(
                            color: context.iris.foreground2,
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      Text(
                        location,
                        style: TextStyle(
                          color: context.iris.muted,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Text(
                  '${steps.length}단계',
                  style: TextStyle(color: context.iris.muted, fontSize: 13),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          if (steps.isNotEmpty)
            Container(
              height: 132,
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(16),
              ),
              clipBehavior: Clip.antiAlias,
              child: ListView.builder(
                physics: const NeverScrollableScrollPhysics(),
                itemCount: steps.length,
                itemExtent: 44,
                itemBuilder: (_, index) {
                  final parts = steps[index].split(' · ');
                  return Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    decoration: BoxDecoration(
                      border: Border(
                        bottom: BorderSide(color: context.iris.separator),
                      ),
                    ),
                    child: Row(
                      children: [
                        Container(
                          width: 22,
                          height: 22,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: context.iris.blocked.withValues(alpha: 0.18),
                            shape: BoxShape.circle,
                          ),
                          child: Text(
                            '${index + 1}',
                            style: TextStyle(
                              color: context.iris.blocked,
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            parts.first,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(fontSize: 15),
                          ),
                        ),
                        if (parts.length > 1)
                          Transform.scale(
                            scaleX: 0.945,
                            alignment: Alignment.centerRight,
                            child: Text(
                              parts.last,
                              style: TextStyle(
                                color: context.iris.muted,
                                fontFamily: 'monospace',
                                fontSize: 13,
                              ),
                            ),
                          ),
                      ],
                    ),
                  );
                },
              ),
            ),
          const SizedBox(height: 12),
          SizedBox(
            height: 48,
            child: TextField(
              controller: controller,
              maxLength: 2000,
              decoration: InputDecoration(
                hintText: '기대한 결과와 실제 결과',
                hintStyle: TextStyle(
                  color: context.iris.faint,
                  fontSize: 17,
                  height: 1.2,
                  letterSpacing: -0.17,
                ),
                counterText: '',
                isDense: true,
                fillColor: context.iris.level1,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              SizedBox(
                width: 96,
                child: IrisButton(
                  label: '취소',
                  expand: false,
                  onPressed: onCancel,
                ),
              ),
              const SizedBox(width: 10),
              IrisButton(
                label: '기록 넣기',
                tone: IrisButtonTone.primary,
                onPressed: canFinish ? onFinish : null,
              ),
            ],
          ),
          SizedBox(
            width: double.infinity,
            height: 29.8,
            child: Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text.rich(
                TextSpan(
                  text: '넣을 곳 · ',
                  children: [
                    WidgetSpan(
                      alignment: PlaceholderAlignment.middle,
                      child: Transform.translate(
                        offset: const Offset(-1.4, -1.4),
                        child: Transform.scale(
                          scaleX: 0.973,
                          scaleY: 0.924,
                          child: Text(
                            destination,
                            style: TextStyle(
                              color: context.iris.foreground,
                              fontSize: 14.5,
                              height: 1.5,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                style: TextStyle(
                  color: context.iris.muted,
                  fontSize: 14.5,
                  height: 1.5,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ],
      ),
    ),
  );
}

class _SketchControls extends StatelessWidget {
  const _SketchControls({
    required this.controller,
    required this.color,
    required this.eraser,
    required this.onColor,
    required this.onPen,
    required this.onEraser,
    required this.onUndo,
    required this.onSend,
  });
  final TextEditingController controller;
  final Color color;
  final bool eraser;
  final ValueChanged<Color> onColor;
  final VoidCallback onPen;
  final VoidCallback onEraser;
  final VoidCallback? onUndo;
  final VoidCallback onSend;
  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('browser-sketch-controls'),
    height: 164,
    child: Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Container(
            key: const Key('browser-pens'),
            height: 52,
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
            decoration: BoxDecoration(
              color: Theme.of(context).brightness == Brightness.dark
                  ? const Color(0xff65737b)
                  : const Color(0xffeef3f6),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Row(
              children: [
                for (final value in const [
                  Color(0xffff7a72),
                  Color(0xff5cc8f5),
                  Color(0xfff9f871),
                ])
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: InkWell(
                      onTap: () => onColor(value),
                      borderRadius: BorderRadius.circular(20),
                      child: Container(
                        width: 40,
                        height: 40,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: !eraser && color == value
                              ? Border.all(
                                  color: context.iris.foreground,
                                  width: 2,
                                )
                              : null,
                        ),
                        alignment: Alignment.center,
                        child: Container(
                          width: 20,
                          height: 20,
                          decoration: BoxDecoration(
                            color: value,
                            shape: BoxShape.circle,
                          ),
                        ),
                      ),
                    ),
                  ),
                Container(
                  width: 1,
                  height: 24,
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  color: context.iris.separator,
                ),
                IrisRoundButton(
                  icon: 'pen-nib',
                  backgroundColor: !eraser
                      ? context.iris.level3
                      : Colors.transparent,
                  onPressed: onPen,
                ),
                IrisRoundButton(
                  icon: 'eraser',
                  backgroundColor: eraser
                      ? context.iris.level3
                      : Colors.transparent,
                  onPressed: onEraser,
                ),
                const Spacer(),
                IrisRoundButton(
                  icon: 'arrow-u-up-left',
                  backgroundColor: Colors.transparent,
                  onPressed: onUndo,
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 24),
        Container(
          key: const Key('browser-sketch-composer'),
          height: 58 + irisBottomInset(context),
          padding: EdgeInsets.fromLTRB(12, 10, 12, irisBottomInset(context)),
          color: context.iris.background,
          child: Row(
            children: [
              Expanded(
                child: SizedBox(
                  height: 48,
                  child: TextField(
                    key: const Key('browser-sketch-input'),
                    controller: controller,
                    maxLength: 2000,
                    style: const TextStyle(
                      fontSize: 17,
                      height: 1.2,
                      letterSpacing: -0.17,
                    ),
                    decoration: InputDecoration(
                      hintText: '그림과 함께 보낼 글',
                      counterText: '',
                      isDense: true,
                      filled: true,
                      fillColor: context.iris.level1,
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(24),
                        borderSide: BorderSide(color: context.iris.separator),
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(24),
                        borderSide: BorderSide(color: context.iris.separator),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IrisRoundButton(
                icon: 'arrow-up',
                size: 48,
                backgroundColor: context.iris.brand,
                foregroundColor: context.iris.onBrand,
                onPressed: onSend,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}

class _Stroke {
  _Stroke(this.color, this.points);
  final Color color;
  final List<Offset> points;
}

class _SketchPainter extends CustomPainter {
  const _SketchPainter(this.strokes, this.active);
  final List<_Stroke> strokes;
  final _Stroke? active;
  @override
  void paint(Canvas canvas, Size size) {
    for (final stroke in [...strokes, ?active]) {
      if (stroke.points.isEmpty) continue;
      final paint = Paint()
        ..color = stroke.color
        ..strokeWidth = 4
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;
      final path = Path()
        ..moveTo(stroke.points.first.dx, stroke.points.first.dy);
      for (final point in stroke.points.skip(1)) {
        path.lineTo(point.dx, point.dy);
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _SketchPainter oldDelegate) => true;
}
