import 'dart:async';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/composer.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/pasted_context.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/format/result_text.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';
import 'package:iris_remote/screens/browser_screen.dart';
import 'package:iris_remote/screens/source_control_screen.dart';
import 'package:iris_remote/screens/terminal_screen.dart';
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
    if (widget.state.browserTabs.isEmpty) {
      await widget.state.refreshBrowserTabs();
    }
    if (!mounted) return;
    final agent = widget.state.agent(_agentRef);
    if (agent == null) return;
    BrowserTab? tab;
    for (final candidate in widget.state.browserTabs) {
      final space = widget.state.browserSpace(candidate.space);
      if ((candidate.space == agent.spaceRef || space?.name == agent.space) &&
          (tab == null || candidate.active)) {
        tab = candidate;
      }
    }
    final sessionTabs = widget.state.browserTabs.where(
      (item) =>
          item.space == agent.spaceRef && item.sessions.contains(agent.ref),
    );
    if (sessionTabs.isNotEmpty) {
      tab =
          sessionTabs.where((item) => item.active).firstOrNull ??
          sessionTabs.first;
    }
    if (tab == null) {
      setState(() => _result = widget.state.browserError ?? '브라우저 탭이 없습니다.');
      return;
    }
    await Navigator.of(context).push<bool>(
      MaterialPageRoute<bool>(builder: (_) => _browserRoute(tab!.ref)),
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
    onOpenBrowser: () {
      final tab = widget.state.browserTabs.firstOrNull;
      if (tab != null) {
        Navigator.of(context).pushReplacement<bool, void>(
          MaterialPageRoute<bool>(builder: (_) => _browserRoute(tab.ref)),
        );
      }
    },
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
    this.showDeliveryStatus = true,
    super.key,
  });

  final RemoteAgent agent;
  final List<RemoteAgent> spaceAgents;
  final List<TranscriptItem> transcript;
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
  final bool showDeliveryStatus;

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
    }
    if (_messageController.text != widget.composerText) {
      _messageController.value = TextEditingValue(
        text: widget.composerText,
        selection: TextSelection.collapsed(offset: widget.composerText.length),
      );
    }
    final count = widget.transcript.length;
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

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      _scheduleScrollVisibilityUpdate();
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
      if (show != _showScrollToBottom) {
        setState(() => _showScrollToBottom = show);
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            _SessionHeader(
              agent: widget.agent,
              agents: widget.spaceAgents,
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
                        padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
                        children: [
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
                                  if (widget.error != null &&
                                      widget.onRetry != null) ...[
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
                            for (final item in widget.transcript)
                              _TranscriptItemView(
                                item: item,
                                showDeliveryStatus: widget.showDeliveryStatus,
                              ),
                        ],
                      ),
                    ),
                  ),
                  if (_showScrollToBottom)
                    Positioned(
                      top: 12,
                      right: 16,
                      child: IrisRoundButton(
                        key: const Key('session-scroll-bottom'),
                        icon: 'caret-down',
                        tooltip: '맨 아래로',
                        backgroundColor: context.iris.level2,
                        foregroundColor: context.iris.foreground,
                        onPressed: () => unawaited(_animateToBottom()),
                      ),
                    ),
                ],
              ),
            ),
            if (widget.actionResult != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
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
              working: widget.onStop != null,
              workingLabel: widget.workingLabel,
              modelLabel: widget.modelLabel,
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

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.agent,
    required this.agents,
    required this.onBack,
    required this.onSelectAgent,
    this.onTerminal,
    this.onBrowser,
    this.onGitHub,
    this.githubFailed = false,
  });

  final RemoteAgent agent;
  final List<RemoteAgent> agents;
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

class _TranscriptItemView extends StatelessWidget {
  const _TranscriptItemView({
    required this.item,
    required this.showDeliveryStatus,
  });

  final TranscriptItem item;
  final bool showDeliveryStatus;

  @override
  Widget build(BuildContext context) {
    if (item.role == 'user') {
      final style = IrisType.body.copyWith(height: 1.45);
      final pasted = parsePastedMessage(item.text);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Container(
            key: const Key('session-user-message'),
            constraints: const BoxConstraints(maxWidth: 297.4),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            decoration: BoxDecoration(
              color: context.iris.level2,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(22),
                topRight: Radius.circular(22),
                bottomLeft: Radius.circular(22),
                bottomRight: Radius.circular(6),
              ),
            ),
            child: pasted == null
                ? IrisMarkdown(
                    item.text,
                    key: const Key('session-user-markdown'),
                    baseStyle: style,
                    compact: true,
                  )
                : Column(
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
          ),
          if (showDeliveryStatus) ...[
            const SizedBox(height: 6),
            SizedBox(
              height: 16,
              child: Align(
                alignment: Alignment.centerRight,
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IrisIcon('check', size: 13, color: context.iris.faint),
                    const SizedBox(width: 4),
                    Text(
                      '전달됨',
                      style: TextStyle(
                        color: context.iris.faint,
                        fontSize: 12.5,
                        height: 16 / 12.5,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
          const SizedBox(height: 16),
        ],
      );
    }
    if (item.role == 'tool') {
      return _ToolTranscriptCard(item: item);
    }
    return Padding(
      padding: const EdgeInsets.only(right: 16, bottom: 16.7),
      child: IrisMarkdown(
        item.text,
        key: const Key('session-assistant-message'),
        baseStyle: IrisType.body,
      ),
    );
  }
}

class _ToolTranscriptCard extends StatefulWidget {
  const _ToolTranscriptCard({required this.item});

  final TranscriptItem item;

  @override
  State<_ToolTranscriptCard> createState() => _ToolTranscriptCardState();
}

class _ToolTranscriptCardState extends State<_ToolTranscriptCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final lines = widget.item.text.split('\n');
    final output = _expanded ? widget.item.text : lines.take(3).join('\n');
    final body = Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Align(
        alignment: Alignment.topLeft,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text.rich(
                _toolOutputText(output),
                style: const TextStyle(
                  color: Color(0xffc9dcea),
                  fontFamily: 'monospace',
                  fontSize: 12.5,
                  height: 1.6,
                ),
              ),
              for (final match in RegExp(
                r'\[([^\]]+)\]\((iris-media:[0-9a-f]{32}|https?://[^\s)]+)\)',
              ).allMatches(widget.item.text))
                IrisMarkdown(match.group(0)!, selectable: false, compact: true),
            ],
          ),
        ),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Container(
        key: const Key('session-tool-card'),
        height: _expanded ? null : 145,
        decoration: BoxDecoration(
          color: context.iris.terminal,
          borderRadius: BorderRadius.circular(14),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              height: 36,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Row(
                  children: [
                    const IrisIcon(
                      'terminal-window',
                      size: 14,
                      color: Color(0xff8199aa),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        widget.item.tool ?? '도구',
                        style: const TextStyle(
                          color: Color(0xffc9dcea),
                          fontFamily: 'monospace',
                          fontSize: 12.5,
                          fontWeight: FontWeight.w500,
                          height: 16 / 12.5,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      '완료',
                      style: TextStyle(
                        color: context.iris.working,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
            ),
            if (_expanded) body else Expanded(child: body),
            SizedBox(
              height: 36,
              width: double.infinity,
              child: TextButton(
                onPressed: () => setState(() => _expanded = !_expanded),
                style: const ButtonStyle(
                  padding: WidgetStatePropertyAll(EdgeInsets.zero),
                  foregroundColor: WidgetStatePropertyAll(Color(0xff8fd0f2)),
                  overlayColor: WidgetStatePropertyAll(Colors.transparent),
                  side: WidgetStatePropertyAll(
                    BorderSide(color: Color(0x14a6daf4)),
                  ),
                  shape: WidgetStatePropertyAll(RoundedRectangleBorder()),
                ),
                child: Text(
                  _expanded ? '출력 접기' : '출력 전체 ${lines.length}줄',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

TextSpan _toolOutputText(String output) {
  final children = <TextSpan>[];
  for (final entry in output.split('\n').indexed) {
    if (entry.$1 > 0) children.add(const TextSpan(text: '\n'));
    final line = entry.$2;
    if (line == '…') {
      children.add(
        const TextSpan(
          text: '…',
          style: TextStyle(color: Color(0xff5e7b8e)),
        ),
      );
    } else if (line.startsWith('✓')) {
      children.add(
        const TextSpan(
          text: '✓',
          style: TextStyle(color: Color(0xff8bfbc2)),
        ),
      );
      children.add(TextSpan(text: line.substring(1)));
    } else {
      children.add(TextSpan(text: line));
    }
  }
  return TextSpan(children: children);
}
