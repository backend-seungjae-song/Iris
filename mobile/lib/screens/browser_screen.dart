import 'package:iris_remote/design/browser_groups.dart';
import 'package:iris_remote/diagnostics/app_log.dart';

import 'dart:async';
import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/scheduler.dart';

import 'browser_gestures.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/composer.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/motion.dart';
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
  StreamSubscription<BrowserFrameStatus>? _frameStatuses;
  bool _reloading = false;
  Timer? _frameRecovery;

  BrowserTool _tool = BrowserTool.none;
  BrowserRecordResult? _record;
  bool _recordPaused = false;
  bool _desktop = false;
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
  // 상태 스트림이 준 오류 코드와 그 코드로 만든 문구
  ({String message, String code})? _statusError;
  final FocusNode _addressFocus = FocusNode();
  final TextEditingController _address = TextEditingController();
  final TextEditingController _directInput = TextEditingController();
  final TextEditingController _recordNote = TextEditingController();
  final TextEditingController _sketchText = TextEditingController();
  late final TextEditingController _messageText;
  final GlobalKey _frameKey = GlobalKey();
  Timer? _sketchScrollTimer;
  Timer? _sketchHoldTimer;
  bool _sketchHeld = false;
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
    if (widget.humanRequest != null) _tool = BrowserTool.direct;
    _frames = widget.state.session.browserFrames.listen((frame) {
      if (mounted && frame.tab == _tabRef) {
        _frameRecovery?.cancel();
        setState(() {
          _frame = frame;
          _error = null;
          _reloading = false;
        });
      }
    });
    _frameStatuses = widget.state.session.browserFrameStatuses.listen((status) {
      if (!mounted || status.tab != _tabRef) return;
      setState(() {
        _error = status.error == null
            ? null
            : switch (status.error) {
                'browser-tab-unavailable' => '탭을 깨우지 못했습니다. 다시 연결하고 있습니다.',
                'browser-controller-unavailable' => '컴퓨터의 브라우저 연결을 기다리고 있습니다.',
                _ => '화면을 받지 못했습니다. 자동으로 다시 시도하고 있습니다.',
              };
        _statusError = status.error == null
            ? null
            : (message: _error!, code: status.error!);
        if (status.error != null) _reloading = false;
      });
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
    _frameStatuses?.cancel();
    _frameRecovery?.cancel();
    _connectionStates?.cancel();
    _invalidateElementHighlight();
    _mouseMotionTimer?.cancel();
    _pageTextTimer?.cancel();
    _postClickTimer?.cancel();
    _address.dispose();
    _addressFocus.dispose();
    _directInput.dispose();
    _recordNote.dispose();
    _releaseSketchScroll();
    _sketchText.dispose();
    _messageText
      ..removeListener(_messageTextChanged)
      ..dispose();
    super.dispose();
  }

  BrowserTab? get _tab => widget.state.browserTab(_tabRef);

  String? get _errorCode =>
      _statusError?.message == _error ? _statusError?.code : null;

  void _retryFrame() => unawaited(_watch());

  void _focusAddress() => _addressFocus.requestFocus();

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
        fps: widget.state.supports(browserFastFrameCapability) ? 20 : 2,
      );
      _watchedWidth = width;
      if (_frame == null) {
        _frameRecovery?.cancel();
        _frameRecovery = Timer(const Duration(seconds: 3), () {
          if (!mounted || _frame != null || _reconnecting) return;
          setState(() => _error = '화면을 기다리고 있습니다. 자동으로 다시 시도하고 있습니다.');
          unawaited(_watch());
        });
      }
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
              : '컴퓨터와 연결이 끊겼습니다.',
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
        for (final item in widget.state.browserTabGroups) {
          if (_initializedTabGroups.add(item.ref) && item.collapsed) {
            _collapsedTabGroups.add(item.ref);
          }
        }
        // 스케치 모드에서 뒤로가기는 화면을 나가지 않고 모드만 끔
        return PopScope(
          canPop: _tool != BrowserTool.sketch,
          onPopInvokedWithResult: (didPop, _) {
            if (!didPop) _setTool(BrowserTool.none);
          },
          child: Scaffold(
            // 스케치 중 글 입력으로 키보드가 올라와도 화면이 줄지 않아 그림 위치가 그대로
            resizeToAvoidBottomInset: _tool != BrowserTool.sketch,
            body: SafeArea(
              bottom: false,
              child: Column(
                children: [
                  BrowserTabStrip(
                    groups: browserTabGroups(
                      tab,
                      widget.state.browserTabs,
                      widget.state.browserTabGroups,
                    ),
                    collapsed: _collapsedTabGroups,
                    selectedRef: tab.ref,
                    onSelect: _selectTab,
                    onToggleGroup: (ref) => setState(() {
                      if (!_collapsedTabGroups.add(ref)) {
                        _collapsedTabGroups.remove(ref);
                      }
                    }),
                    onNewTab: widget.state.supports('browser.tab.new')
                        ? () => _newTab(tab.space)
                        : null,
                  ),
                  _AddressBar(
                    controller: _address,
                    focusNode: _addressFocus,
                    profile: tab.profile,
                    desktop: _desktop,
                    failed: _error != null && _frame == null,
                    canNavigate: widget.state.supports('browser.navigate'),
                    onNavigate: _navigate,
                    onBack: () => Navigator.of(context).pop(),
                    onTerminal:
                        widget.onOpenTerminal != null &&
                            widget.state.supports('terminal.watch')
                        ? widget.onOpenTerminal
                        : null,
                    onReload: widget.state.supports('browser.history')
                        ? () => _history('reload')
                        : null,
                    reloading: _reloading,
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        Expanded(
                          child: Stack(
                            fit: StackFit.expand,
                            children: [
                              KeyedSubtree(
                                key: _frameKey,
                                child: _FrameSurface(
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
                                  inputMode: _tool == BrowserTool.pick
                                      ? (widget.state.supports(
                                              'browser.element.hover',
                                            )
                                            ? BrowserInputMode.trackpad
                                            : BrowserInputMode.direct)
                                      : !widget.state.supports('browser.mouse')
                                      ? BrowserInputMode.direct
                                      : BrowserInputMode.trackpad,
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
                                      action == 'click' ||
                                          _tool == BrowserTool.pick
                                      ? _handleFrameTap(point)
                                      : _sendPoint(point, action),
                                  canWheel:
                                      widget.state.supports(
                                        browserWheelCapability,
                                      ) ||
                                      widget.state.supports('browser.mouse'),
                                  onScroll: _sendWheel,
                                  onZoom: (value) =>
                                      setState(() => _frameZoom = value),
                                  onZoomEnd: _refreshZoomedFrame,
                                  sketching: _tool == BrowserTool.sketch,
                                  onStroke: _onStroke,
                                  imageOverlay:
                                      _tool == BrowserTool.sketch &&
                                          !widget.frameIncludesOverlays
                                      ? (rect) => CustomPaint(
                                          painter: _SketchPainter(
                                            _strokes,
                                            _activeStroke,
                                            rect,
                                            _frameZoom,
                                          ),
                                        )
                                      : null,
                                ),
                              ),
                              if (!_desktop && widget.overlayBuilder != null)
                                Positioned.fill(
                                  child: IgnorePointer(
                                    child: widget.overlayBuilder!(
                                      context,
                                      _tool,
                                    ),
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
                              if (_error != null && _frame == null)
                                Positioned.fill(
                                  child: IrisFadeIn(
                                    child: _BrowserErrorView(
                                      message: _error!,
                                      code: _errorCode,
                                      onRetry: _retryFrame,
                                      onEditAddress: _focusAddress,
                                    ),
                                  ),
                                ),
                              if (_tool == BrowserTool.sketch)
                                Positioned(
                                  right: 12,
                                  bottom: 12,
                                  child: _SketchScrollButtons(
                                    onUp: () => _scrollSketch(-1),
                                    onDown: () => _scrollSketch(1),
                                    onPress: _pressSketchScroll,
                                    onRelease: _releaseSketchScroll,
                                  ),
                                ),
                              if (_frameZoom > 1.01)
                                Positioned(
                                  right: _tool == BrowserTool.sketch ? 68 : 12,
                                  bottom: 12,
                                  child: IgnorePointer(
                                    child: _ZoomChip(zoom: _frameZoom),
                                  ),
                                ),
                              if (_reconnecting || _error != null)
                                Positioned(
                                  top: 12,
                                  left: 12,
                                  right: 12,
                                  child: Column(
                                    children: [
                                      if (_reconnecting)
                                        const _ConnectionNotice(),
                                      if (_reconnecting && _error != null)
                                        const SizedBox(height: 8),
                                      if (_error != null)
                                        _BrowserNotice(
                                          title: _frame == null
                                              ? 'Mac 화면을 기다리는 중'
                                              : _error!,
                                          detail: _frame == null
                                              ? (_reconnecting
                                                    ? '컴퓨터와 다시 연결하는 중'
                                                    : '연결은 정상 · 화면만 받지 못했습니다')
                                              : null,
                                          onRefresh: _retryFrame,
                                        ),
                                    ],
                                  ),
                                ),
                              if (_tool == BrowserTool.direct)
                                Positioned(
                                  top: 6,
                                  left: 12,
                                  right: 12,
                                  child: Opacity(
                                    opacity: widget.frameIncludesOverlays
                                        ? 0
                                        : 1,
                                    child: const _HumanBanner(
                                      text: '직접 조작 중 · 에이전트는 기다립니다',
                                    ),
                                  ),
                                ),
                              if (_tool == BrowserTool.record &&
                                  _record != null)
                                Positioned(
                                  top: 6,
                                  left: 12,
                                  right: 12,
                                  child: Opacity(
                                    opacity: widget.frameIncludesOverlays
                                        ? 0
                                        : 1,
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
                                    opacity: widget.frameIncludesOverlays
                                        ? 0
                                        : 1,
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
                              onForward: () => _history('forward'),
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
            : '컴퓨터와 연결이 끊겼습니다.',
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
      AppLog.write('browser', 'mouse $action');
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
            : '컴퓨터와 연결이 끊겼습니다.',
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
            : '컴퓨터와 연결이 끊겼습니다.',
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

  Future<void> _history(String action) async {
    if (_reloading) return;
    if (action == 'reload') {
      setState(() {
        _reloading = true;
        _error = null;
      });
    }
    try {
      await widget.state.session.browserHistory(_tabRef, action);
      if (!mounted) return;
      if (!widget.state.supports(browserFastFrameCapability)) await _watch();
      if (action == 'reload' && _reloading) {
        _frameRecovery?.cancel();
        _frameRecovery = Timer(const Duration(seconds: 3), () {
          if (!mounted || !_reloading) return;
          setState(() {
            _reloading = false;
            _error = '새로고침 화면을 받지 못했습니다. 다시 시도하고 있습니다.';
          });
          unawaited(_watch());
        });
      }
    } on RemoteFailure catch (error) {
      if (mounted) {
        setState(() {
          _reloading = false;
          _error = error.message;
        });
      }
    } on ProtocolException catch (error) {
      if (mounted) {
        setState(() {
          _reloading = false;
          _error = error.message;
        });
      }
    }
  }

  Future<bool> _sendWheel(_FramePoint point, int dx, int dy) async {
    _postClickTimer?.cancel();
    try {
      if (widget.state.supports(browserWheelCapability)) {
        await widget.state.session.browserWheel(
          _tabRef,
          x: point.x,
          y: point.y,
          width: point.width,
          height: point.height,
          dx: dx,
          dy: dy,
        );
      } else if (dy != 0 && widget.state.supports('browser.mouse')) {
        await widget.state.session.browserMouse(
          _tabRef,
          x: point.x,
          y: point.y,
          width: point.width,
          height: point.height,
          action: 'wheel',
          dy: dy,
        );
      } else if (dy != 0 && widget.state.supports('browser.scroll')) {
        await widget.state.session.browserScroll(_tabRef, dy);
      }
      return true;
    } on Object catch (error) {
      if (mounted) {
        setState(
          () => _result = error is RemoteFailure
              ? error.message
              : '스크롤을 전달하지 못했습니다.',
        );
      }
      return false;
    }
  }

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
              : '컴퓨터와 연결이 끊겼습니다.',
        );
      }
    }
  }

  void _eraseAt(Offset point, Size imageSize) => setState(
    () => _strokes.removeWhere(
      (stroke) => stroke.points.any((candidate) {
        final delta = candidate - point;
        return Offset(
              delta.dx * imageSize.width,
              delta.dy * imageSize.height,
            ).distance <
            18;
      }),
    ),
  );

  void _onStroke(_StrokePhase phase, Offset point, Size imageSize) {
    switch (phase) {
      case _StrokePhase.start:
        if (_eraser) {
          _eraseAt(point, imageSize);
        } else {
          setState(() => _activeStroke = _Stroke(_penColor, [point]));
        }
      case _StrokePhase.update:
        if (_eraser) {
          _eraseAt(point, imageSize);
        } else if (_activeStroke != null) {
          setState(() => _activeStroke!.points.add(point));
        }
      case _StrokePhase.end:
        final stroke = _activeStroke;
        if (stroke == null) return;
        setState(() {
          _strokes.add(stroke);
          _activeStroke = null;
        });
      case _StrokePhase.cancel:
        if (_activeStroke != null) setState(() => _activeStroke = null);
    }
  }

  // 스케치 모드의 위·아래 스크롤 버튼. 화면 높이의 5%씩 40ms 간격으로 이어 보내 부드럽게 움직임
  static const _sketchScrollChunk = 0.05;
  static const _sketchScrollTick = Duration(milliseconds: 40);

  void _scrollSketchChunk(int direction) {
    final frame = _frame;
    if (frame == null) return;
    unawaited(
      _sendWheel(
        _FramePoint(
          x: frame.width / 2,
          y: frame.height / 2,
          width: frame.width,
          height: frame.height,
        ),
        0,
        direction * (frame.height * _sketchScrollChunk).round(),
      ),
    );
  }

  // 한 번 누르면 화면 높이의 25%. 길게 눌러 연속으로 움직인 뒤 손을 뗄 때는 다시 움직이지 않음
  void _scrollSketch(int direction) {
    if (_sketchHeld) {
      _sketchHeld = false;
      return;
    }
    _stopSketchScroll();
    var sent = 0;
    _sketchScrollTimer = Timer.periodic(_sketchScrollTick, (timer) {
      _scrollSketchChunk(direction);
      if (++sent >= 5) timer.cancel();
    });
    _scrollSketchChunk(direction);
  }

  // 누르고 400ms가 지나면 떼기 전까지 계속 움직임
  void _pressSketchScroll(int direction) {
    _sketchHeld = false;
    _sketchHoldTimer?.cancel();
    _sketchHoldTimer = Timer(const Duration(milliseconds: 400), () {
      _sketchHeld = true;
      _holdSketchScroll(direction);
    });
  }

  void _releaseSketchScroll() {
    _sketchHoldTimer?.cancel();
    _sketchHoldTimer = null;
    _stopSketchScroll();
  }

  void _holdSketchScroll(int direction) {
    _stopSketchScroll();
    _sketchScrollTimer = Timer.periodic(
      _sketchScrollTick,
      (_) => _scrollSketchChunk(direction),
    );
  }

  void _stopSketchScroll() {
    _sketchScrollTimer?.cancel();
    _sketchScrollTimer = null;
  }

  // 확대·이동과 관계없이 확대 전 화면 기준 좌표로 그려 서버에 보냄
  Future<Uint8List?> _renderSketch() async {
    final frame = _frame;
    final surface = _frameSurfaceSize();
    if (frame == null || surface == null) return null;
    final base = browserFrameBaseRect(
      surface,
      Size(frame.width.toDouble(), frame.height.toDouble()),
    );
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    _SketchPainter(_strokes, null, base, 1).paint(canvas, surface);
    final image = await recorder.endRecording().toImage(
      surface.width.round(),
      surface.height.round(),
    );
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  }

  Size? _frameSurfaceSize() {
    final box = _frameKey.currentContext?.findRenderObject();
    return box is RenderBox && box.hasSize ? box.size : null;
  }

  Future<void> _sendSketch() async {
    if (_sketchText.text.trim().isEmpty || _strokes.isEmpty) return;
    try {
      final bytes = await _renderSketch();
      if (bytes == null) return;
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
      onReload: () {
        Navigator.of(sheetContext).pop();
        _history('reload');
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
    required this.focusNode,
    required this.profile,
    required this.desktop,
    required this.failed,
    required this.canNavigate,
    required this.onNavigate,
    required this.onBack,
    this.onTerminal,
    this.onReload,
    this.reloading = false,
  });
  final TextEditingController controller;
  final FocusNode focusNode;
  final String profile;
  final bool desktop;
  final bool failed;
  final bool canNavigate;
  final VoidCallback onNavigate;
  final VoidCallback onBack;
  final VoidCallback? onTerminal;
  final VoidCallback? onReload;
  final bool reloading;

  @override
  State<_AddressBar> createState() => _AddressBarState();
}

class _AddressBarState extends State<_AddressBar> {
  FocusNode get _focus => widget.focusNode;

  @override
  void initState() {
    super.initState();
    _focus.addListener(_focusChanged);
  }

  @override
  void dispose() {
    _focus.removeListener(_focusChanged);
    super.dispose();
  }

  void _focusChanged() => setState(() {});

  // 주소 줄 .abar. 높이 56, 주소 상자 46 반경 12
  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final label = widget.desktop ? '데스크톱' : widget.profile;
    return SizedBox(
      key: const Key('browser-address-area'),
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6),
        child: Row(
          children: [
            _BarButton(
              key: const Key('browser-back'),
              icon: 'caret-left',
              tooltip: '뒤로',
              onPressed: widget.onBack,
            ),
            const SizedBox(width: 4),
            Expanded(
              child: Container(
                key: const Key('browser-address'),
                height: 46,
                padding: const EdgeInsets.only(left: 12),
                decoration: BoxDecoration(
                  color: colors.level1,
                  borderRadius: BorderRadius.circular(browserControlRadius),
                ),
                foregroundDecoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(browserControlRadius),
                  border: Border.all(
                    color: _focus.hasFocus
                        ? irisSelectionColor(context)
                        : colors.line2,
                    width: _focus.hasFocus ? 1.5 : 1,
                  ),
                ),
                child: Row(
                  children: [
                    IrisIcon(
                      widget.failed
                          ? 'warning-circle'
                          : widget.desktop
                          ? 'monitor'
                          : 'lock-simple',
                      size: 16,
                      color: widget.failed ? colors.dangerText : colors.muted,
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
                            keyboardType: TextInputType.url,
                            textInputAction: TextInputAction.go,
                            onSubmitted: (_) {
                              widget.onNavigate();
                              _focus.unfocus();
                            },
                            onTapOutside: (_) => _focus.unfocus(),
                            style: TextStyle(
                              color: _focus.hasFocus
                                  ? colors.foreground
                                  : Colors.transparent,
                              fontSize: 14,
                            ),
                            cursorColor: colors.foreground,
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
                            IgnorePointer(
                              child: _AddressText(widget.controller.text),
                            ),
                        ],
                      ),
                    ),
                    if (label.isNotEmpty) ...[
                      const SizedBox(width: 6),
                      Container(
                        key: const Key('browser-profile-tag'),
                        padding: const EdgeInsets.symmetric(
                          horizontal: 5,
                          vertical: 1,
                        ),
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(IrisRadius.small),
                          border: Border.all(color: colors.line2),
                        ),
                        child: Text(
                          label,
                          maxLines: 1,
                          style: IrisType.mono.copyWith(
                            fontSize: 11,
                            height: 1.4,
                            fontWeight: FontWeight.w500,
                            color: widget.desktop
                                ? irisSelectionColor(context)
                                : colors.muted,
                          ),
                        ),
                      ),
                    ],
                    if (widget.onReload != null)
                      IconButton(
                        key: const Key('browser-reload'),
                        tooltip: '새로고침',
                        onPressed: widget.reloading ? null : widget.onReload,
                        style: IconButton.styleFrom(
                          fixedSize: const Size(44, 44),
                          foregroundColor: colors.foreground2,
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(
                              browserControlRadius,
                            ),
                          ),
                        ),
                        icon: widget.reloading
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const IrisIcon('arrow-clockwise', size: 20),
                      )
                    else
                      const SizedBox(width: 8),
                  ],
                ),
              ),
            ),
            if (widget.onTerminal != null) ...[
              const SizedBox(width: 4),
              _BarButton(
                key: const Key('browser-terminal'),
                icon: 'terminal-window',
                tooltip: '터미널',
                onPressed: widget.onTerminal!,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

// 아이콘 버튼 .ib. 44×44 반경 12
class _BarButton extends StatelessWidget {
  const _BarButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.selected = false,
    this.flip = false,
    this.width = 44,
    super.key,
  });

  final String icon;
  final bool flip;
  final String tooltip;
  final VoidCallback? onPressed;
  final bool selected;
  final double width;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final selection = irisSelectionColor(context);
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onPressed,
          child: Container(
            width: width,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: selected ? colors.tint2 : Colors.transparent,
              borderRadius: BorderRadius.circular(browserControlRadius),
            ),
            child: Opacity(
              opacity: onPressed == null ? 0.35 : 1,
              child: Transform.flip(
                flipX: flip,
                child: IrisIcon(
                  icon,
                  size: 22,
                  color: selected ? selection : colors.foreground2,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _AddressText extends StatelessWidget {
  const _AddressText(this.value);

  final String value;

  @override
  Widget build(BuildContext context) {
    final uri = Uri.tryParse(value);
    final hasHost = uri?.host.isNotEmpty == true;
    final host = hasHost ? uri!.host : value;
    final path = hasHost
        ? '${uri!.path}${uri.hasQuery ? '?${uri.query}' : ''}'
        : '';
    return Text.rich(
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      TextSpan(
        style: TextStyle(fontSize: 14, color: context.iris.muted),
        children: [
          TextSpan(
            text: host,
            style: TextStyle(
              color: context.iris.foreground,
              fontWeight: FontWeight.w600,
            ),
          ),
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

  Rect get baseRect => browserFrameBaseRect(
    size,
    Size(frameWidth.toDouble(), frameHeight.toDouble()),
  );

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
  double gain = 0.45,
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
  return viewport.clampPan(pan + delta * gain);
}

enum _StrokePhase { start, update, end, cancel }

// 스케치 선 좌표는 화면이 아니라 이미지 기준 0~1 값이라 확대·이동·화면 크기 변화에도 내용 위에 붙어 있음
typedef _StrokeCallback = void Function(
  _StrokePhase phase,
  Offset normalized,
  Size imageSize,
);

class _FrameSurface extends StatefulWidget {
  const _FrameSurface({
    required this.frame,
    required this.referenceImage,
    required this.inputMode,
    required this.cursor,
    required this.zoom,
    required this.highlightedElement,
    required this.canDirectTap,
    required this.canDirectScroll,
    required this.onCursor,
    required this.onMouse,
    required this.onDirectTap,
    required this.onScroll,
    required this.canWheel,
    required this.onZoom,
    required this.onZoomEnd,
    this.sketching = false,
    this.onStroke,
    this.imageOverlay,
    super.key,
  });
  // 스케치 모드: 한 손가락은 선 긋기, 두 손가락은 확대·화면 이동만 하고 페이지 스크롤은 하지 않음
  final bool sketching;
  final _StrokeCallback? onStroke;
  final Widget Function(Rect imageRect)? imageOverlay;
  final BrowserFrame? frame;
  final ui.Image? referenceImage;
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
  final Future<bool> Function(_FramePoint point, int dx, int dy) onScroll;
  final bool canWheel;
  final ValueChanged<double> onZoom;
  final VoidCallback onZoomEnd;

  @override
  State<_FrameSurface> createState() => _FrameSurfaceState();
}

class _FrameSurfaceState extends State<_FrameSurface>
    with SingleTickerProviderStateMixin {
  static const _moveThreshold = 6.0;
  static const _cursorSpeed = 1.35;
  // 두 손가락이 이 시간 안에 움직임 없이 떨어지면 우클릭이다
  static const _twoFingerTapMs = 320;
  final Stopwatch _multiClock = Stopwatch();
  final Map<int, Offset> _pointers = {};
  final Set<int> _multiMovedPointers = {};
  final Map<int, Offset> _multiStartPoints = {};
  late Offset _cursor;
  Offset _pan = Offset.zero;
  Offset _primaryDown = Offset.zero;
  Offset _primaryLast = Offset.zero;
  Offset _multiStartCenter = Offset.zero;
  Offset _multiLastCenter = Offset.zero;
  Offset _multiStartPan = Offset.zero;
  double _multiStartDistance = 1;
  double _multiStartZoom = 1;
  bool _strokeActive = false;
  Offset _pendingWheel = Offset.zero;
  Offset _velocity = Offset.zero;
  Duration? _lastMoveTime;
  double _velocityInterval = .016;
  late final Ticker _inertia;
  Duration _lastTick = Duration.zero;
  Timer? _wheelTimer;
  // 응답을 기다리는 휠 요청 수, 둘까지 겹쳐 보내 왕복 지연이 스크롤을 막지 않게 한다
  int _wheelsInFlight = 0;
  _FramePoint? _wheelPoint;
  Offset? _pressed;
  Timer? _pressedTimer;
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
    _inertia = createTicker(_tickInertia);
  }

  @override
  void didUpdateWidget(covariant _FrameSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.cursor != oldWidget.cursor && widget.cursor != _cursor) {
      _cursor = widget.cursor;
    }
    if (widget.frame != oldWidget.frame) {
      AppLog.write(
        'browser',
        'frame seq=${widget.frame?.seq} kb=${(widget.frame?.jpeg.length ?? 0) ~/ 1000}',
      );
    }
    if (widget.frame?.tab != oldWidget.frame?.tab ||
        widget.inputMode != oldWidget.inputMode) {
      _inertia.stop();
      _wheelTimer?.cancel();
      _pendingWheel = Offset.zero;
    }
    if (widget.zoom <= 1 && oldWidget.zoom > 1) _pan = Offset.zero;
  }

  @override
  void dispose() {
    _inertia.dispose();
    _wheelTimer?.cancel();
    _pressedTimer?.cancel();
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

  void _stroke(_StrokePhase phase, Offset local, _FrameViewport viewport) {
    final rect = viewport.imageRect;
    widget.onStroke?.call(
      phase,
      Offset(
        ((local.dx - rect.left) / rect.width).clamp(0.0, 1.0),
        ((local.dy - rect.top) / rect.height).clamp(0.0, 1.0),
      ),
      rect.size,
    );
  }

  void _beginMulti() {
    final points = _twoPointers;
    if (points.length < 2) return;
    if (_strokeActive) {
      _strokeActive = false;
      widget.onStroke?.call(_StrokePhase.cancel, Offset.zero, Size.zero);
    }
    _longPressTimer?.cancel();
    _singleTapTimer?.cancel();
    _multi = true;
    _multiClock
      ..reset()
      ..start();
    _pinching = false;
    _scrolling = false;
    _multiMovedPointers.clear();
    _multiStartPoints
      ..clear()
      ..addAll({for (final e in _pointers.entries.take(2)) e.key: e.value});
    _primaryMoved = true;
    _multiStartCenter = _center(points);
    _multiLastCenter = _multiStartCenter;
    _multiStartDistance = _distance(points).clamp(1, double.infinity);
    _multiStartZoom = widget.zoom;
    _multiStartPan = _pan;
    _velocity = Offset.zero;
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
    _inertia.stop();
    _pressedTimer?.cancel();
    setState(() => _pressed = event.localPosition);
    _pointers[event.pointer] = event.localPosition;
    if (_pointers.length == 1) {
      _primaryDown = event.localPosition;
      _primaryLast = event.localPosition;
      _primaryMoved = false;
      _velocity = Offset.zero;
      _lastMoveTime = event.timeStamp;
      _suppressUntilAllUp = false;
      if (widget.sketching) {
        final viewport = _viewport(size);
        if (viewport != null) {
          _strokeActive = true;
          _stroke(_StrokePhase.start, event.localPosition, viewport);
        }
      } else {
        _startLongPress(size);
      }
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
        final moves = [
          for (final e in _pointers.entries.take(2))
            if (_multiStartPoints[e.key] != null)
              e.value - _multiStartPoints[e.key]!,
        ];
        switch (classifyBrowserGesture(
          distanceChange: distanceChange,
          centerMove: centerMove,
          travel: moves.length == 2
              ? browserTravelCosine(moves[0], moves[1])
              : null,
        )) {
          case BrowserGesture.pinch:
            _pinching = true;
            AppLog.write('browser', 'gesture pinch');
          case BrowserGesture.scroll:
            _scrolling = true;
            AppLog.write('browser', 'gesture scroll');
          case BrowserGesture.pending:
            return;
        }
      }
      if (_pinching) {
        final zoom = (_multiStartZoom * ratio).clamp(1.0, 4.0);
        final base = viewport.baseRect;
        if (widget.sketching) {
          // 스케치는 커서가 없어 두 손가락 가운데를 기준으로 확대하고 이동도 손가락을 따름
          final source =
              (_multiStartCenter - base.center - _multiStartPan) /
              _multiStartZoom;
          setState(
            () => _pan = viewport.clampPan(
              center - base.center - source * zoom,
              zoom,
            ),
          );
        } else {
          // 확대 기준은 손가락 중심이 아니라 커서. 커서가 있던 화면 위치에 그대로 두고 화면 이동은 커서 따라가기로만 함
          final offset = Offset(
            (_cursor.dx - .5) * base.width,
            (_cursor.dy - .5) * base.height,
          );
          final anchor =
              base.center + _multiStartPan + offset * _multiStartZoom;
          final nextPan = viewport.clampPan(
            anchor - base.center - offset * zoom,
            zoom,
          );
          setState(
            () => _pan = browserCursorFollowPan(
              size: size,
              frameSize: Size(
                widget.frame!.width.toDouble(),
                widget.frame!.height.toDouble(),
              ),
              zoom: zoom,
              pan: nextPan,
              cursor: _cursor,
              gain: 1,
            ),
          );
        }
        widget.onZoom(zoom);
      } else if (_scrolling) {
        if (widget.sketching) {
          setState(
            () => _pan = viewport.clampPan(_pan + center - _multiLastCenter),
          );
        } else {
          _scrollBy(center - _multiLastCenter, viewport, event.timeStamp);
        }
      }
      _multiLastCenter = center;
      return;
    }
    if (_suppressUntilAllUp) return;
    if (widget.sketching) {
      _primaryLast = event.localPosition;
      if (_strokeActive) {
        _stroke(_StrokePhase.update, event.localPosition, viewport);
      }
      return;
    }
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
      var rest = delta;
      if (widget.zoom > 1) {
        final next = viewport.clampPan(_pan + delta);
        rest = delta - (next - _pan);
        setState(() => _pan = next);
      }
      _scrollBy(rest, viewport, event.timeStamp);
    }
  }

  void _pointerUp(PointerEvent event, Size size) {
    _pressedTimer?.cancel();
    _pressedTimer = Timer(const Duration(milliseconds: 150), () {
      if (mounted) setState(() => _pressed = null);
    });
    final wasMulti = _multi;
    _pointers.remove(event.pointer);
    _longPressTimer?.cancel();
    final viewport = _viewport(size);
    if (widget.sketching && !wasMulti) {
      if (_strokeActive && viewport != null) {
        _strokeActive = false;
        _stroke(
          event is PointerCancelEvent ? _StrokePhase.cancel : _StrokePhase.end,
          event.localPosition,
          viewport,
        );
      }
      if (_pointers.isEmpty) _suppressUntilAllUp = false;
      return;
    }
    if (wasMulti) {
      if (_pointers.length < 2) {
        final twoFingerTap =
            !_pinching &&
            !_scrolling &&
            !widget.sketching &&
            event is! PointerCancelEvent &&
            widget.inputMode == BrowserInputMode.trackpad &&
            _multiClock.elapsedMilliseconds < _twoFingerTapMs;
        _multi = false;
        _suppressUntilAllUp = true;
        if (twoFingerTap && viewport != null) {
          unawaited(
            widget.onMouse(viewport.normalizedPoint(_cursor), 'context'),
          );
        }
        if (_pinching) {
          widget.onZoomEnd();
        } else if (_scrolling && event is! PointerCancelEvent) {
          _startInertia();
        }
        _pinching = false;
        _scrolling = false;
        _multiMovedPointers.clear();
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
          event is! PointerCancelEvent) {
        _startInertia();
      }
      return;
    }
    if (event is PointerCancelEvent) {
      _inertia.stop();
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

  void _scrollBy(
    Offset delta,
    _FrameViewport viewport,
    Duration time, {
    bool inertial = false,
  }) {
    if (!widget.canWheel && !widget.canDirectScroll) return;
    final seconds = _lastMoveTime == null
        ? 0.016
        : (time - _lastMoveTime!).inMicroseconds / 1000000;
    if (!inertial && seconds > 0 && seconds < 0.2) {
      _velocityInterval = seconds;
      _velocity = delta / seconds;
    } else if (!inertial && seconds == 0) {
      _velocity += delta / _velocityInterval;
    }
    if (_velocity.distance > 3000)
      _velocity = _velocity / _velocity.distance * 3000;
    _lastMoveTime = time;
    _pendingWheel += Offset(
      -delta.dx * viewport.frameWidth / viewport.imageRect.width,
      -delta.dy * viewport.frameHeight / viewport.imageRect.height,
    );
    if (!widget.canWheel) _pendingWheel = Offset(0, _pendingWheel.dy);
    _wheelPoint = widget.inputMode == BrowserInputMode.trackpad
        ? viewport.normalizedPoint(_cursor)
        : viewport.localToFrame(_primaryLast) ??
              viewport.normalizedPoint(_cursor);
    _scheduleWheel();
  }

  void _scheduleWheel() {
    if (_wheelTimer != null ||
        _wheelsInFlight >= 2 ||
        _pendingWheel.distance < 1) {
      return;
    }
    _wheelTimer = Timer(const Duration(milliseconds: 16), () {
      _wheelTimer = null;
      unawaited(_flushWheel());
    });
  }

  Future<void> _flushWheel() async {
    if (!mounted || _wheelPoint == null || _wheelsInFlight >= 2) return;
    final dx = _pendingWheel.dx.round().clamp(-20000, 20000);
    final dy = _pendingWheel.dy.round().clamp(-20000, 20000);
    if (dx == 0 && dy == 0) return;
    _pendingWheel -= Offset(dx.toDouble(), dy.toDouble());
    _wheelsInFlight++;
    final ok = await widget.onScroll(_wheelPoint!, dx, dy);
    _wheelsInFlight--;
    AppLog.write('browser', 'wheel dx=$dx dy=$dy ok=$ok');
    if (!mounted) return;
    if (!ok) {
      _inertia.stop();
      _pendingWheel = Offset.zero;
    }
    _scheduleWheel();
  }

  void _startInertia() {
    if (_velocity.distance < 80) return;
    _lastTick = Duration.zero;
    _inertia.start();
  }

  void _tickInertia(Duration elapsed) {
    final seconds = (elapsed - _lastTick).inMicroseconds / 1000000;
    _lastTick = elapsed;
    if (seconds <= 0) return;
    _velocity = browserInertiaVelocity(_velocity, seconds);
    final size = context.size;
    final viewport = size == null ? null : _viewport(size);
    if (viewport == null ||
        _velocity.distance < 20 ||
        elapsed.inMilliseconds > 1200) {
      _inertia.stop();
      return;
    }
    _scrollBy(_velocity * seconds, viewport, elapsed, inertial: true);
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
            child: widget.frame == null
                ? const Center(child: CircularProgressIndicator())
                : Stack(
                    clipBehavior: Clip.hardEdge,
                    children: [
                      if (imageRect != null)
                        Positioned.fromRect(
                          key: const Key('browser-frame-image'),
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
                      if (widget.imageOverlay != null && imageRect != null)
                        Positioned.fill(
                          child: IgnorePointer(
                            child: widget.imageOverlay!(imageRect),
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
                      if (_pressed != null)
                        Positioned(
                          left: _pressed!.dx - 12,
                          top: _pressed!.dy - 12,
                          child: IgnorePointer(
                            child: Container(
                              key: const Key('browser-touch-feedback'),
                              width: 24,
                              height: 24,
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                color: const Color(0x1f00AFF0),
                                border: Border.all(
                                  color: const Color(0x9900AFF0),
                                  width: 2,
                                ),
                              ),
                            ),
                          ),
                        ),
                      if (widget.inputMode == BrowserInputMode.trackpad &&
                          cursor != null)
                        Positioned(
                          key: const Key('browser-cursor'),
                          left: cursor.dx - _CursorPainter.tip.dx,
                          top: cursor.dy - _CursorPainter.tip.dy,
                          width: 22,
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

// 커서 모양, 시안 cursor 아이콘(24 격자). 짙은 몸통에 흰 테두리
class _CursorPainter extends CustomPainter {
  const _CursorPainter();

  // 22 크기에서 화살 끝 위치
  static const tip = Offset(5 * 22 / 24, 3.5 * 22 / 24);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(size.width / 24, size.height / 24);
    final path = Path()
      ..moveTo(5, 3.5)
      ..lineTo(18.5, 10.3)
      ..lineTo(12.6, 12.2)
      ..lineTo(10.7, 18.1)
      ..close();
    canvas.drawPath(
      path,
      Paint()
        ..color = const Color(0xff0A1F2C)
        ..style = PaintingStyle.fill,
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.6
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

// 화면 위에 뜨는 알림 카드 .wait. 바탕 level1, 테두리 line2, 반경 14
class _NoticeCard extends StatelessWidget {
  const _NoticeCard({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(14),
        boxShadow: [
          BoxShadow(
            color: colors.shadow,
            blurRadius: 30,
            offset: const Offset(0, 10),
          ),
        ],
      ),
      foregroundDecoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colors.line2),
      ),
      child: child,
    );
  }
}

class _NoticeSpinner extends StatelessWidget {
  const _NoticeSpinner();

  @override
  Widget build(BuildContext context) => SizedBox(
    width: 18,
    height: 18,
    child: CircularProgressIndicator(
      strokeWidth: 2.2,
      color: context.iris.working,
    ),
  );
}

class _ConnectionNotice extends StatelessWidget {
  const _ConnectionNotice();

  @override
  Widget build(BuildContext context) => _NoticeCard(
    key: const Key('browser-reconnecting'),
    child: Row(
      children: [
        const _NoticeSpinner(),
        const SizedBox(width: 10),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              '컴퓨터와 다시 연결하는 중',
              style: TextStyle(
                color: context.iris.foreground,
                fontSize: 13,
                height: 1.4,
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

// 화면 수신 오류 띠. 제목, 보조 줄, 새로 받기
class _BrowserNotice extends StatelessWidget {
  const _BrowserNotice({
    required this.title,
    required this.onRefresh,
    this.detail,
  });

  final String title;
  final String? detail;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return _NoticeCard(
      key: const Key('browser-frame-notice'),
      child: Row(
        children: [
          const _NoticeSpinner(),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    color: colors.foreground,
                    fontSize: 13,
                    height: 1.4,
                  ),
                ),
                if (detail != null)
                  Text(
                    detail!,
                    style: TextStyle(
                      color: colors.muted,
                      fontSize: 12,
                      height: 1.4,
                    ),
                  ),
              ],
            ),
          ),
          IrisButton(
            key: const Key('browser-frame-refresh'),
            label: '새로 받기',
            height: 36,
            expand: false,
            tone: IrisButtonTone.ghost,
            onPressed: onRefresh,
          ),
        ],
      ),
    );
  }
}

// 화면을 못 받았을 때 프레임 자리를 채우는 오류 화면, 시안 .err
class _BrowserErrorView extends StatelessWidget {
  const _BrowserErrorView({
    required this.message,
    required this.onRetry,
    required this.onEditAddress,
    this.code,
  });

  final String message;
  final String? code;
  final VoidCallback onRetry;
  final VoidCallback onEditAddress;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return ColoredBox(
      key: const Key('browser-error-view'),
      color: colors.level1,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 28),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 56,
                height: 56,
                margin: const EdgeInsets.only(bottom: 14),
                decoration: BoxDecoration(
                  color: colors.dangerTint,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Center(
                  child: IrisIcon('globe', size: 28, color: colors.dangerText),
                ),
              ),
              Text(
                '화면을 불러오지 못했습니다',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: colors.foreground,
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 6),
              Text(
                message,
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: colors.foreground2,
                  fontSize: 14,
                  height: 1.6,
                ),
              ),
              if (code != null) ...[
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: colors.terminal,
                    borderRadius: BorderRadius.circular(IrisRadius.small),
                    border: Border.all(color: colors.separator),
                  ),
                  child: Text(
                    code!,
                    style: IrisType.mono.copyWith(
                      fontSize: 12.5,
                      color: colors.muted,
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  IrisButton(
                    key: const Key('browser-error-address'),
                    label: '주소 수정',
                    icon: 'pencil-simple',
                    onPressed: onEditAddress,
                  ),
                  const SizedBox(width: 8),
                  IrisButton(
                    key: const Key('browser-error-retry'),
                    label: '다시 시도',
                    icon: 'arrow-clockwise',
                    tone: IrisButtonTone.primary,
                    onPressed: onRetry,
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

// 확대 배율 칩 .chipf.z
class _ZoomChip extends StatelessWidget {
  const _ZoomChip({required this.zoom});

  final double zoom;

  @override
  Widget build(BuildContext context) => Container(
    key: const Key('browser-zoom-chip'),
    height: 32,
    padding: const EdgeInsets.symmetric(horizontal: 12),
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: const Color(0xd1081018),
      borderRadius: BorderRadius.circular(16),
    ),
    child: Text(
      '${(zoom * 100).round()}%',
      style: IrisType.mono.copyWith(
        color: const Color(0xffEAF4FA),
        fontSize: 12.5,
        fontWeight: FontWeight.w500,
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

// 하단 도구 .tbar. 높이 56, 아이콘 버튼 52×44, 균등 간격
class _BrowserToolbar extends StatelessWidget {
  const _BrowserToolbar({
    required this.selected,
    required this.moreSelected,
    required this.canBack,
    required this.canPick,
    required this.canRecord,
    required this.canSketch,
    required this.onBack,
    required this.onForward,
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
  final VoidCallback onForward;
  final VoidCallback onPick;
  final VoidCallback onRecord;
  final VoidCallback onSketch;
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    final actions = <Widget>[
      if (canBack) ...[
        _BarButton(
          key: const Key('browser-tool-back'),
          icon: 'arrow-left',
          tooltip: '뒤로',
          width: 52,
          onPressed: onBack,
        ),
        _BarButton(
          key: const Key('browser-tool-forward'),
          icon: 'arrow-left',
          flip: true,
          tooltip: '앞으로',
          width: 52,
          onPressed: onForward,
        ),
      ],
      if (canPick)
        _BarButton(
          key: const Key('browser-tool-pick'),
          icon: 'cursor-click',
          tooltip: '요소 선택',
          width: 52,
          selected: selected == BrowserTool.pick,
          onPressed: onPick,
        ),
      if (canRecord)
        _BarButton(
          key: const Key('browser-tool-record'),
          icon: 'record',
          tooltip: '조작 기록',
          width: 52,
          onPressed: onRecord,
        ),
      if (canSketch)
        _BarButton(
          key: const Key('browser-tool-sketch'),
          icon: 'scribble-loop',
          tooltip: '스케치',
          width: 52,
          onPressed: onSketch,
        ),
      _BarButton(
        key: const Key('browser-tool-more'),
        icon: 'dots-three',
        tooltip: '더보기',
        width: 52,
        selected: moreSelected,
        onPressed: onMore,
      ),
    ];
    return Container(
      key: const Key('browser-toolbar'),
      height: 56 + irisBottomInset(context),
      padding: EdgeInsets.only(bottom: irisBottomInset(context)),
      decoration: BoxDecoration(
        color: context.iris.level1,
        border: Border(top: BorderSide(color: context.iris.separator)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: actions,
      ),
    );
  }
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
      padding: EdgeInsets.fromLTRB(12, 8, 12, irisSheetBottom(context) + 8),
      decoration: BoxDecoration(
        color: context.iris.background,
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
            height: 36,
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

// 입력 키 칩, 시안 .chip. 높이 36 알약
class _PageKey extends StatelessWidget {
  const _PageKey({required this.label, required this.onTap, super.key});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(right: 6),
    child: ExcludeFocus(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: context.iris.level2,
            borderRadius: BorderRadius.circular(IrisRadius.pill),
          ),
          foregroundDecoration: BoxDecoration(
            borderRadius: BorderRadius.circular(IrisRadius.pill),
            border: Border.all(color: context.iris.separator),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: context.iris.foreground2,
              fontSize: 13,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
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
              : '컴퓨터와 연결이 끊겼습니다.',
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
    required this.onDesktop,
    required this.onDirect,
    required this.onReload,
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
  final ValueChanged<bool> onDesktop;
  final VoidCallback onDirect;
  final VoidCallback onReload;
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
    ];
    return SizedBox(
      key: const Key('browser-more-sheet'),
      height: 520,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(),
          const IrisSheetTitle(
            '도구',
            padding: EdgeInsets.fromLTRB(4, 14, 4, 10),
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
                '프로필 · 쿠키와 로그인을 따로 저장',
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

// 더보기 도구 칸. 선택되면 선택색 테두리 1.5
class _MoreTool extends StatelessWidget {
  const _MoreTool({
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
  Widget build(BuildContext context) {
    final colors = context.iris;
    final selection = irisSelectionColor(context);
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Container(
        decoration: BoxDecoration(
          color: selected ? colors.tint2 : colors.level2,
          borderRadius: BorderRadius.circular(browserCardRadius),
        ),
        foregroundDecoration: BoxDecoration(
          borderRadius: BorderRadius.circular(browserCardRadius),
          border: Border.all(
            color: selected ? selection : colors.separator,
            width: selected ? 1.5 : 1,
          ),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            IrisIcon(
              icon,
              size: 22,
              color: selected ? selection : colors.foreground2,
            ),
            const SizedBox(height: 7),
            Text(
              label,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: selected ? colors.foreground : colors.foreground2,
                fontSize: 13,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
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
  Widget build(BuildContext context) => Transform.translate(
    // 키보드가 올라오면 화면 크기는 그대로 두고 이 영역만 키보드 위로 올림
    offset: Offset(
      0,
      -(MediaQuery.viewInsetsOf(context).bottom - irisBottomInset(context))
          .clamp(0.0, double.infinity),
    ),
    child: SizedBox(
      key: const Key('browser-sketch-controls'),
      // 펜 막대 52 + 간격 24 + 입력줄 58, 아래 여백은 기기 제스처 막대만큼 더함
      height: 134 + irisBottomInset(context),
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
    ),
  );
}

// 스케치 모드에서 페이지를 스크롤하는 버튼. 손가락 스크롤은 막고 이 버튼만 씀
class _SketchScrollButtons extends StatelessWidget {
  const _SketchScrollButtons({
    required this.onUp,
    required this.onDown,
    required this.onPress,
    required this.onRelease,
  });
  final VoidCallback onUp;
  final VoidCallback onDown;
  final ValueChanged<int> onPress;
  final VoidCallback onRelease;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    Widget button(
      Key key,
      String icon,
      String label,
      int direction,
      VoidCallback onTap,
    ) => Listener(
      onPointerDown: (_) => onPress(direction),
      onPointerUp: (_) => onRelease(),
      onPointerCancel: (_) => onRelease(),
      child: DecoratedBox(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: colors.shadowRing),
          boxShadow: [
            BoxShadow(
              color: colors.shadow,
              blurRadius: 20,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: IrisRoundButton(
          key: key,
          icon: icon,
          size: 44,
          tooltip: label,
          backgroundColor: colors.level1.withValues(alpha: .94),
          onPressed: onTap,
        ),
      ),
    );
    return Column(
      key: const Key('browser-sketch-scroll'),
      mainAxisSize: MainAxisSize.min,
      children: [
        button(
          const Key('browser-sketch-scroll-up'),
          'arrow-up',
          '위로 스크롤',
          -1,
          onUp,
        ),
        const SizedBox(height: 8),
        button(
          const Key('browser-sketch-scroll-down'),
          'arrow-down',
          '아래로 스크롤',
          1,
          onDown,
        ),
      ],
    );
  }
}

class _Stroke {
  _Stroke(this.color, this.points);
  final Color color;
  final List<Offset> points;
}

class _SketchPainter extends CustomPainter {
  const _SketchPainter(this.strokes, this.active, this.imageRect, this.zoom);
  final List<_Stroke> strokes;
  final _Stroke? active;
  // 선 좌표 0~1을 이 사각형 안으로 옮겨 그림. 확대 중에는 선 굵기도 같은 비율
  final Rect imageRect;
  final double zoom;

  Offset _local(Offset point) => Offset(
    imageRect.left + point.dx * imageRect.width,
    imageRect.top + point.dy * imageRect.height,
  );

  @override
  void paint(Canvas canvas, Size size) {
    for (final stroke in [...strokes, ?active]) {
      if (stroke.points.isEmpty) continue;
      final paint = Paint()
        ..color = stroke.color
        ..strokeWidth = 4 * zoom
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;
      final first = _local(stroke.points.first);
      final path = Path()..moveTo(first.dx, first.dy);
      for (final point in stroke.points.skip(1)) {
        final local = _local(point);
        path.lineTo(local.dx, local.dy);
      }
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _SketchPainter oldDelegate) => true;
}
