import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/chat_tools.dart';
import 'package:iris_remote/design/composer.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/pasted_context.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/design/status_chip.dart';
import 'package:iris_remote/design/status_glyph.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/conversation_request_card.dart';
import 'package:iris_remote/screens/response_host.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/screens/terminal_question_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
import 'package:iris_remote/screens/terminal_question_card.dart';
import 'package:iris_remote/state/remote_state.dart';

class AgentScreen extends StatefulWidget {
  const AgentScreen({
    required this.state,
    required this.agentRef,
    this.focusComposer = false,
    super.key,
  });

  final RemoteState state;
  final String agentRef;
  final bool focusComposer;

  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends State<AgentScreen> {
  late String _agentRef;
  String? _result;
  GitHubPrResult? _pr;

  @override
  void initState() {
    super.initState();
    _agentRef = widget.agentRef;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(widget.state.selectAgent(_agentRef));
    });
    _loadPr();
  }

  Future<void> _selectAgent(String ref) async {
    if (ref == _agentRef) return;
    setState(() {
      _agentRef = ref;
      _result = null;
    });
    await widget.state.selectAgent(ref);
    await _loadPr();
  }

  Future<void> _loadPr() async {
    if (!widget.state.supports('github.pr')) return;
    try {
      final value = await widget.state.session.githubPr(_agentRef);
      if (mounted) setState(() => _pr = value);
    } on RemoteFailure {
      if (mounted) setState(() => _pr = null);
    }
  }

  Future<void> _openBrowser() async {
    final tab = await _browserTabForAgent();
    if (!mounted) return;
    if (tab == null) {
      setState(() => _result = '이 스페이스에 브라우저 탭이 없습니다');
      return;
    }
    await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(builder: (_) => _browserRoute(tab.ref)),
    );
  }

  Future<BrowserTab?> _browserTabForAgent() async {
    final tab = await widget.state.browserTabForAgent(_agentRef);
    return mounted ? tab : null;
  }

  Future<void> _openBrowserFromTerminal() async {
    final tab = await _browserTabForAgent();
    if (!mounted) return;
    if (tab == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('이 스페이스에 브라우저 탭이 없습니다')));
      return;
    }
    await Navigator.of(context).pushReplacement<bool, void>(
      MaterialPageRoute<bool>(builder: (_) => _browserRoute(tab.ref)),
    );
  }

  Widget _browserRoute(String tabRef) => BrowserScreen(
    state: widget.state,
    agentRef: _agentRef,
    tabRef: tabRef,
    onOpenTerminal: () => Navigator.of(context).pushReplacement<void, bool>(
      MaterialPageRoute(builder: (_) => _terminalRoute()),
    ),
  );

  Widget _terminalRoute() => TerminalScreen(
    state: widget.state,
    agentRef: _agentRef,
    onOpenBrowser: () => unawaited(_openBrowserFromTerminal()),
    onOpenChat: () => Navigator.of(context).pop(),
  );

  Future<bool> _send(String text) async {
    try {
      final response = await widget.state.sendComposerMessage(_agentRef, text);
      final sent = const {'sent', 'delivered'}.contains(response.result);
      if (mounted) {
        setState(() => _result = agentMessageResultText(response.result));
      }
      return sent;
    } on ProtocolException catch (error) {
      if (mounted) setState(() => _result = error.message);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
    return false;
  }

  // 이 대화의 대기 요청을 전체 응답 화면으로 열기. 다른 에이전트의 요청에서 거절했으면 그 대화로 이동
  Future<void> _openRequest(RemoteAgent agent, RemoteRequest request) async {
    final denied = await showResponseHost(
      context: context,
      state: widget.state,
      request: request,
      agentName: agent.name,
      agentKind: agent.kind,
      space: agent.space,
    );
    if (denied != null && denied != agent.ref && mounted) {
      await Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => AgentScreen(
            state: widget.state,
            agentRef: denied,
            focusComposer: true,
          ),
        ),
      );
    }
  }

  Future<void> _stop() async {
    try {
      final response = await widget.state.stopAgent(_agentRef);
      if (mounted) {
        setState(() => _result = agentStopResultText(response.result));
      }
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final agent = widget.state.agent(_agentRef);
        if (agent == null) {
          return Scaffold(
            body: SafeArea(
              child: Center(
                child: Text(
                  '에이전트를 찾을 수 없습니다.',
                  style: TextStyle(color: context.iris.muted),
                ),
              ),
            ),
          );
        }
        return IrisLinkScope(
          open: widget.state.supports('browser.tab.new')
              ? (href) async {
                  final media = href.startsWith('iris-media:')
                      ? href.substring(11)
                      : null;
                  final uri = Uri.tryParse(href);
                  if (media == null &&
                      (uri == null ||
                          !{'http', 'https'}.contains(uri.scheme))) {
                    return '이 주소는 컴퓨터 브라우저에서 열 수 없습니다.';
                  }
                  try {
                    final result = await widget.state.session.browserNewTab(
                      agent.spaceRef,
                      agent: agent.ref,
                      url: media == null ? href : null,
                      media: media,
                    );
                    await widget.state.refreshBrowserTabs();
                    final tabRef = result.tab;
                    if (tabRef != null && context.mounted) {
                      if (widget.state.browserTab(tabRef) == null) {
                        return '컴퓨터에서 탭을 열었지만 목록을 확인하지 못했습니다. 목록을 새로 고치세요.';
                      }
                      unawaited(
                        Navigator.of(context).push<void>(
                          MaterialPageRoute(
                            builder: (_) => BrowserScreen(
                              state: widget.state,
                              agentRef: agent.ref,
                              tabRef: tabRef,
                            ),
                          ),
                        ),
                      );
                    }
                    return '컴퓨터 브라우저에서 열었습니다';
                  } on RemoteFailure catch (error) {
                    return media == null
                        ? error.message
                        : '파일이 없거나 허용된 컴퓨터 폴더 밖에 있습니다.';
                  } on ProtocolException catch (error) {
                    return error.message;
                  } catch (_) {
                    return '컴퓨터에서 탭을 열지 못했습니다. 다시 시도하세요.';
                  }
                }
              : null,
          child: AgentSessionView(
            agent: agent,
            spaceAgents: widget.state.agents
                .where((other) => other.space == agent.space)
                .toList(growable: false),
            transcript: widget.state.transcript,
            terminalFallback:
                agent.status == 'blocked' &&
                !agent.question &&
                !widget.state.requests.any((r) => r.agent == agent.ref),
            promptSession: widget.state.supports('terminal.select')
                ? widget.state.session
                : null,
            terminalQuestions:
                widget.state.supports('terminal.watch') &&
                    widget.state.supports('terminal.key')
                ? widget.state.terminalQuestions
                      .where((q) => q.agent == agent.ref)
                      .toList()
                : const [],
            requests: [
              for (final request in widget.state.requests)
                if (request.agent == agent.ref) request,
            ],
            onOpenRequest: (request) => _openRequest(agent, request),
            onAnswerTerminalQuestion: widget.state.supports('terminal.watch')
                ? (_) => showTerminalQuestion(
                    context: context,
                    state: widget.state,
                    agent: agent,
                    onTerminal: () => Navigator.of(context).push<void>(
                      MaterialPageRoute(builder: (_) => _terminalRoute()),
                    ),
                  )
                : null,
            loading: widget.state.loadingTranscript,
            loadingEarlier: widget.state.loadingEarlier,
            hasEarlier: widget.state.hasEarlier,
            error: widget.state.transcriptError,
            actionResult: _result,
            composerText: widget.state.composerTextFor(_agentRef),
            drafts: widget.state.composerDraftsFor(_agentRef),
            onBack: () => Navigator.of(context).pop(),
            onSelectAgent: (other) {
              if (other.kind == 'terminal' &&
                  widget.state.supports('terminal.watch')) {
                Navigator.of(context).pushReplacement<void, void>(
                  MaterialPageRoute(
                    builder: (_) => TerminalScreen(
                      state: widget.state,
                      agentRef: other.ref,
                    ),
                  ),
                );
              } else {
                unawaited(_selectAgent(other.ref));
              }
            },
            onLoadEarlier: widget.state.loadEarlier,
            onRetry: () => unawaited(widget.state.selectAgent(_agentRef)),
            onSend: _send,
            onComposerTextChanged: (text) =>
                widget.state.setComposerText(_agentRef, text),
            onRemoveDraft: (ref) =>
                widget.state.removeComposerDraft(_agentRef, ref),
            onStop: agent.can.stop && agent.status == 'working' ? _stop : null,
            canMessage: agent.can.message,
            autofocusComposer: widget.focusComposer,
            onTerminal: widget.state.supports('terminal.watch')
                ? () => Navigator.of(context).push<void>(
                    MaterialPageRoute(builder: (_) => _terminalRoute()),
                  )
                : null,
            onBrowser: widget.state.supports('browser.tabs')
                ? _openBrowser
                : null,
            onGitHub:
                widget.state.supports('git.changes') ||
                    widget.state.supports('github.pr')
                ? () => showSourceControlSheet(
                    context: context,
                    session: widget.state.session,
                    agent: agent,
                    initialPr: _pr,
                  )
                : null,
            githubFailed: _pr?.pr.checks.any((check) => check.failed) ?? false,
          ),
        );
      },
    );
  }
}

class AgentSessionView extends StatefulWidget {
  const AgentSessionView({
    required this.agent,
    required this.spaceAgents,
    required this.transcript,
    required this.onBack,
    required this.onSelectAgent,
    required this.onSend,
    required this.canMessage,
    this.terminalQuestions = const [],
    this.requests = const [],
    this.onOpenRequest,
    this.onAnswerTerminalQuestion,
    this.promptSession,
    this.terminalFallback = false,
    this.onLoadEarlier,
    this.onRetry,
    this.onStop,
    this.onTerminal,
    this.onBrowser,
    this.onGitHub,
    this.loading = false,
    this.loadingEarlier = false,
    this.hasEarlier = false,
    this.error,
    this.actionResult,
    this.composerText = '',
    this.onComposerTextChanged,
    this.drafts = const [],
    this.onRemoveDraft,
    this.modelLabel,
    this.workingLabel = '작업 중',
    this.autofocusComposer = false,
    this.githubFailed = false,
    super.key,
  });

  final RemoteAgent agent;
  final List<RemoteAgent> spaceAgents;
  final List<TranscriptItem> transcript;
  final ActiveRemoteSession? promptSession;
  final bool terminalFallback;
  final List<RemoteRequest> terminalQuestions;
  // 이 에이전트의 대기 중 일반 승인·질문·사람 차례 요청
  final List<RemoteRequest> requests;
  final ValueChanged<RemoteRequest>? onOpenRequest;
  final ValueChanged<RemoteRequest>? onAnswerTerminalQuestion;
  final VoidCallback onBack;
  final ValueChanged<RemoteAgent> onSelectAgent;
  final Future<bool> Function(String text) onSend;
  final Future<void> Function()? onLoadEarlier;
  final VoidCallback? onRetry;
  final Future<void> Function()? onStop;
  final VoidCallback? onTerminal;
  final VoidCallback? onBrowser;
  final VoidCallback? onGitHub;
  final bool canMessage;
  final bool loading;
  final bool loadingEarlier;
  final bool hasEarlier;
  final String? error;
  final String? actionResult;
  final String composerText;
  final ValueChanged<String>? onComposerTextChanged;
  final List<ComposerDraft> drafts;
  final ValueChanged<String>? onRemoveDraft;
  final String? modelLabel;
  final String workingLabel;
  final bool autofocusComposer;
  final bool githubFailed;

  @override
  State<AgentSessionView> createState() => _AgentSessionViewState();
}

class _AgentSessionViewState extends State<AgentSessionView> {
  final ScrollController _scrollController = ScrollController();
  late final TextEditingController _messageController;
  bool _sending = false;
  bool _stopping = false;
  bool _initialScrollDone = false;
  bool _showScrollToBottom = false;
  bool _scrollUpdateScheduled = false;
  int _lastTranscriptCount = 0;
  // 위로 올라가 있는 동안 새로 들어온 항목 수
  int _unseen = 0;

  int get _itemCount =>
      widget.transcript.length +
      widget.terminalQuestions.length +
      widget.requests.length;

  @override
  void initState() {
    super.initState();
    _messageController = TextEditingController(text: widget.composerText)
      ..addListener(_messageChanged);
    _scrollController.addListener(_onScroll);
    if (!widget.loading) {
      _initialScrollDone = true;
      _scrollToBottom();
    }
  }

  @override
  void didUpdateWidget(covariant AgentSessionView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.agent.ref != widget.agent.ref) {
      _initialScrollDone = false;
      _lastTranscriptCount = 0;
      _showScrollToBottom = false;
      _unseen = 0;
    }
    if (_messageController.text != widget.composerText) {
      _messageController.value = TextEditingValue(
        text: widget.composerText,
        selection: TextSelection.collapsed(offset: widget.composerText.length),
      );
    }
    final count = _itemCount;
    final nearBottom =
        !_scrollController.hasClients ||
        _scrollController.position.maxScrollExtent - _scrollController.offset <
            80;
    if (!_initialScrollDone && !widget.loading) {
      _initialScrollDone = true;
      _scrollToBottom();
    } else if (count > _lastTranscriptCount && nearBottom) {
      _scrollToBottom();
    } else {
      if (count > _lastTranscriptCount && _lastTranscriptCount > 0) {
        _unseen += count - _lastTranscriptCount;
      }
      _scheduleScrollVisibilityUpdate();
    }
    _lastTranscriptCount = count;
  }

  @override
  void dispose() {
    _scrollController.dispose();
    _messageController
      ..removeListener(_messageChanged)
      ..dispose();
    super.dispose();
  }

  void _messageChanged() =>
      widget.onComposerTextChanged?.call(_messageController.text);

  // 줄 높이가 제각각이면 한 번에 끝까지 못 가므로 맨 아래에 닿을 때까지 몇 프레임 반복
  void _scrollToBottom([int pass = 0]) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      _scheduleScrollVisibilityUpdate();
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scrollController.hasClients) return;
        final position = _scrollController.position;
        if (pass < 5 && position.maxScrollExtent - position.pixels > 1) {
          _scrollToBottom(pass + 1);
        }
      });
    });
  }

  Future<void> _animateToBottom() async {
    if (!_scrollController.hasClients) return;
    await _scrollController.animateTo(
      _scrollController.position.maxScrollExtent,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
    if (!mounted || !_scrollController.hasClients) return;
    _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
    _scheduleScrollVisibilityUpdate();
  }

  void _scheduleScrollVisibilityUpdate() {
    if (_scrollUpdateScheduled) return;
    _scrollUpdateScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollUpdateScheduled = false;
      if (!mounted || !_scrollController.hasClients) return;
      final show = _scrollController.position.extentAfter > 24;
      if (show != _showScrollToBottom || (!show && _unseen != 0)) {
        setState(() {
          _showScrollToBottom = show;
          if (!show) _unseen = 0;
        });
      }
    });
  }

  void _onScroll() {
    _scheduleScrollVisibilityUpdate();
    if (_scrollController.offset > 48 ||
        !widget.hasEarlier ||
        widget.loadingEarlier ||
        widget.onLoadEarlier == null) {
      return;
    }
    final oldExtent = _scrollController.position.maxScrollExtent;
    final oldOffset = _scrollController.offset;
    widget.onLoadEarlier!().then((_) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scrollController.hasClients) return;
        final added = _scrollController.position.maxScrollExtent - oldExtent;
        _scrollController.jumpTo(oldOffset + added);
      });
    });
  }

  Future<void> _send() async {
    final text = _messageController.text;
    if ((text.isEmpty && widget.drafts.isEmpty) || _sending) return;
    setState(() => _sending = true);
    final sent = await widget.onSend(text);
    if (mounted && sent) {
      _messageController.clear();
    }
    if (mounted) setState(() => _sending = false);
  }

  Future<void> _stop() async {
    if (widget.onStop == null || _stopping) return;
    setState(() => _stopping = true);
    await widget.onStop!();
    if (mounted) setState(() => _stopping = false);
  }

  String? get _kindLabel => switch (widget.agent.kind) {
    'claude' => 'Claude',
    'codex' => 'Codex',
    'terminal' => '터미널',
    _ => null,
  };

  // 본문 목록. 항목 사이 간격 14
  List<Widget> _items(BuildContext context) {
    final out = <Widget>[];
    void add(Widget child) {
      if (out.isNotEmpty) out.add(const SizedBox(height: 14));
      out.add(child);
    }

    final working = widget.agent.status == 'working';
    final items = widget.transcript;
    DateTime? lastDay;
    var index = 0;
    while (index < items.length) {
      final item = items[index];
      final time = _itemTime(item);
      if (time != null &&
          (lastDay == null ||
              lastDay.year != time.year ||
              lastDay.month != time.month ||
              lastDay.day != time.day)) {
        lastDay = time;
        add(_DayLabel(time));
      }
      if (item.role == 'tool') {
        var end = index;
        while (end < items.length && items[end].role == 'tool') {
          end++;
        }
        final group = items.sublist(index, end);
        final rows = buildToolRows(group);
        final last = end == items.length;
        add(
          IrisToolTable(
            key: ValueKey(Object.hash(group.first.at, group.first.text)),
            rows: rows,
            live: working && last,
          ),
        );
        if (working && last && rows.isNotEmpty && rows.last.pending) {
          add(_WorkingLine(label: rows.last.pendingLabel));
        }
        index = end;
        continue;
      }
      if (item.role == 'user') {
        add(_UserBubble(item: item, time: time));
      } else {
        final first = index == 0 || items[index - 1].role != 'assistant';
        add(
          _AssistantBlock(
            item: item,
            who: first ? (_kindLabel ?? widget.agent.name) : null,
          ),
        );
      }
      index++;
    }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final working = widget.onStop != null;
    final waiting =
        !working && (widget.agent.question || widget.agent.status == 'blocked');
    final cards = <Widget>[
      if (widget.onOpenRequest != null)
        for (final request in widget.requests)
          ConversationRequestCard(
            request: request,
            onOpen: () => widget.onOpenRequest!(request),
          ),
      if (widget.onTerminal != null)
        for (final question in widget.terminalQuestions)
          TerminalQuestionCard(
            request: question,
            session: widget.promptSession,
            agentName: widget.agent.name,
            onOpen: widget.onTerminal!,
            onAnswer: widget.onAnswerTerminalQuestion == null
                ? null
                : () => widget.onAnswerTerminalQuestion!(question),
          ),
      if (widget.terminalFallback &&
          widget.terminalQuestions.isEmpty &&
          widget.onTerminal != null)
        _QuestionFallbackCard(onTerminal: widget.onTerminal!),
    ];
    final body = <Widget>[
      if (widget.loadingEarlier)
        const Padding(
          padding: EdgeInsets.all(12),
          child: Center(child: CircularProgressIndicator()),
        ),
      if (widget.loading)
        const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        )
      else if (widget.transcript.isEmpty)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 48),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.error ?? '대화 기록이 없습니다.',
                textAlign: TextAlign.center,
                style: TextStyle(color: context.iris.muted),
              ),
              if (widget.error != null && widget.onRetry != null) ...[
                const SizedBox(height: 16),
                IrisButton(
                  key: const Key('transcript-retry'),
                  label: '다시 시도',
                  onPressed: widget.onRetry,
                  height: 36,
                  width: 112,
                  expand: false,
                ),
              ],
            ],
          ),
        )
      else
        ..._items(context),
      for (final card in cards) ...[const SizedBox(height: 14), card],
    ];
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            _SessionHeader(
              agent: widget.agent,
              agents: widget.spaceAgents,
              kindLabel: _kindLabel,
              onBack: widget.onBack,
              onSelectAgent: widget.onSelectAgent,
              onTerminal: widget.onTerminal,
              onBrowser: widget.onBrowser,
              onGitHub: widget.onGitHub,
              githubFailed: widget.githubFailed,
            ),
            Expanded(
              child: Stack(
                children: [
                  Positioned.fill(
                    child: NotificationListener<ScrollMetricsNotification>(
                      onNotification: (_) {
                        _scheduleScrollVisibilityUpdate();
                        return false;
                      },
                      child: ListView(
                        key: const Key('session-chat'),
                        controller: _scrollController,
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                        children: body,
                      ),
                    ),
                  ),
                  if (_showScrollToBottom)
                    Positioned(
                      right: 16,
                      bottom: 12,
                      child: _ScrollBottomButton(
                        count: _unseen,
                        onPressed: () => unawaited(_animateToBottom()),
                      ),
                    ),
                ],
              ),
            ),
            if (widget.actionResult != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    widget.actionResult!,
                    style: TextStyle(color: context.iris.muted, fontSize: 13),
                  ),
                ),
              ),
            IrisComposer(
              controller: _messageController,
              drafts: widget.drafts,
              sending: _sending,
              stopping: _stopping,
              working: working,
              workingLabel: widget.workingLabel,
              modelLabel: widget.modelLabel,
              blockedLabel: waiting ? '질문 대기 중 · 답하면 이어서 진행' : null,
              hintText: waiting ? '답 대신 메시지 보내기' : '메시지 보내기',
              onSend: _send,
              onRemoveDraft: widget.onRemoveDraft,
              onStop: widget.onStop == null ? null : _stop,
              autofocus: widget.autofocusComposer,
            ),
          ],
        ),
      ),
    );
  }
}

// at 은 밀리초 기준. 초 단위 값도 받는다
DateTime? _itemTime(TranscriptItem item) {
  final at = item.at;
  if (at == null) return null;
  return DateTime.fromMillisecondsSinceEpoch(
    at < 100000000000 ? at * 1000 : at,
  );
}

String _clock(DateTime time) =>
    '${time.hour}:${time.minute.toString().padLeft(2, '0')}';

class _DayLabel extends StatelessWidget {
  const _DayLabel(this.time);

  final DateTime time;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(time.year, time.month, time.day);
    final label = switch (today.difference(day).inDays) {
      0 => '오늘',
      1 => '어제',
      _ => '${time.month}월 ${time.day}일',
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Text(
          '$label ${_clock(time)}',
          key: const Key('session-day'),
          style: TextStyle(color: context.iris.muted, fontSize: 12),
        ),
      ),
    );
  }
}

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.agent,
    required this.agents,
    required this.kindLabel,
    required this.onBack,
    required this.onSelectAgent,
    this.onTerminal,
    this.onBrowser,
    this.onGitHub,
    this.githubFailed = false,
  });

  final RemoteAgent agent;
  final List<RemoteAgent> agents;
  final String? kindLabel;
  final VoidCallback onBack;
  final ValueChanged<RemoteAgent> onSelectAgent;
  final VoidCallback? onTerminal;
  final VoidCallback? onBrowser;
  final VoidCallback? onGitHub;
  final bool githubFailed;

  @override
  Widget build(BuildContext context) {
    return IrisSessionHeader(
      title: agent.name,
      subtitle: agent.space,
      agentKind: agent.kind,
      mode: SessionMode.chat,
      status: agent.question ? 'question' : agent.status,
      kindLabel: kindLabel,
      tabs: [
        for (final other in agents)
          IrisAgentTab(
            agent: other,
            selected: other.ref == agent.ref,
            onPressed: () => onSelectAgent(other),
          ),
      ],
      onBack: onBack,
      canTerminal: onTerminal != null,
      canBrowser: onBrowser != null,
      onChat: () {},
      onTerminal: onTerminal,
      onBrowser: onBrowser,
      onGitHub: onGitHub,
      githubFailed: githubFailed,
    );
  }
}

class _ScrollBottomButton extends StatelessWidget {
  const _ScrollBottomButton({required this.count, required this.onPressed});

  final int count;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Material(
      key: const Key('session-scroll-bottom'),
      color: colors.level3,
      elevation: 6,
      shadowColor: colors.shadow,
      borderRadius: BorderRadius.circular(22),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(22),
        child: Container(
          height: 44,
          padding: const EdgeInsets.fromLTRB(10, 0, 14, 0),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IrisIcon('caret-down', size: 18, color: colors.foreground),
              const SizedBox(width: 6),
              Text(
                '맨 아래로',
                style: TextStyle(
                  color: colors.foreground,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
              if (count > 0) ...[
                const SizedBox(width: 6),
                Container(
                  constraints: const BoxConstraints(minWidth: 20),
                  height: 20,
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  decoration: BoxDecoration(
                    color: colors.brand,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  alignment: Alignment.center,
                  child: Text(
                    '$count',
                    style: TextStyle(
                      color: colors.onBrand,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                      height: 1,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

// 질문 대기 중인데 응답 요청이 없을 때 터미널로 보내는 카드
class _QuestionFallbackCard extends StatelessWidget {
  const _QuestionFallbackCard({required this.onTerminal});

  final VoidCallback onTerminal;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      key: const Key('session-question-fallback'),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: colors.pink, width: 1.5),
      ),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const IrisStatusChip(IrisStatus.block, label: '질문'),
              const SizedBox(width: 8),
              Text(
                '터미널에서 답해야 합니다',
                style: TextStyle(
                  color: colors.foreground2,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [IrisButton(label: '터미널에서 답하기', onPressed: onTerminal)],
          ),
        ],
      ),
    );
  }
}

class _WorkingLine extends StatelessWidget {
  const _WorkingLine({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) => Row(
    key: const Key('session-working-line'),
    children: [
      const IrisStatusGlyph(status: 'working'),
      const SizedBox(width: 8),
      Text(
        label,
        style: TextStyle(color: context.iris.foreground2, fontSize: 13.5),
      ),
    ],
  );
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.item, required this.time});

  final TranscriptItem item;
  final DateTime? time;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final style = IrisType.body.copyWith(
      fontSize: 15,
      height: 1.55,
      letterSpacing: 0,
    );
    final pasted = parsePastedMessage(item.text);
    return Align(
      alignment: Alignment.centerRight,
      child: LayoutBuilder(
        builder: (context, box) => Container(
          key: const Key('session-user-message'),
          constraints: BoxConstraints(maxWidth: box.maxWidth * .82),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: colors.level2,
            border: Border.all(color: colors.separator),
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(18),
              topRight: Radius.circular(18),
              bottomLeft: Radius.circular(18),
              bottomRight: Radius.circular(6),
            ),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              if (pasted == null)
                IrisMarkdown(
                  item.text,
                  key: const Key('session-user-markdown'),
                  baseStyle: style,
                  compact: true,
                )
              else
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (pasted.text.isNotEmpty) ...[
                      IrisMarkdown(
                        pasted.text,
                        key: const Key('session-user-markdown'),
                        baseStyle: style,
                        compact: true,
                      ),
                      const SizedBox(height: 9),
                    ],
                    for (final block in pasted.blocks) ...[
                      PastedContextChip(
                        key: const Key('transcript-pasted-context'),
                        kind: block.kind,
                        summary: block.summary,
                        onPressed: () => showPastedContext(
                          context: context,
                          kind: block.kind,
                          summary: block.summary,
                          content: block.content,
                        ),
                      ),
                      if (block != pasted.blocks.last)
                        const SizedBox(height: 7),
                    ],
                  ],
                ),
              if (time != null)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    _clock(time!),
                    style: TextStyle(color: colors.muted, fontSize: 11.5),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _AssistantBlock extends StatelessWidget {
  const _AssistantBlock({required this.item, required this.who});

  final TranscriptItem item;
  // 이름이 있으면 위에 작성자 줄을 붙인다
  final String? who;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (who != null) ...[
          Row(
            children: [
              Container(
                width: 22,
                height: 22,
                decoration: BoxDecoration(
                  color: colors.level3,
                  borderRadius: BorderRadius.circular(7),
                ),
                alignment: Alignment.center,
                child: Text(
                  who!.characters.first.toUpperCase(),
                  style: TextStyle(
                    color: colors.foreground2,
                    fontFamily: 'monospace',
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    height: 1,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(who!, style: TextStyle(color: colors.muted, fontSize: 12.5)),
            ],
          ),
          const SizedBox(height: 8),
        ],
        IrisMarkdown(
          item.text,
          key: const Key('session-assistant-message'),
          baseStyle: IrisType.body.copyWith(
            fontSize: 15,
            height: 1.65,
            letterSpacing: 0,
          ),
        ),
      ],
    );
  }
}
