import 'package:flutter/material.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';
import 'package:iris_remote/remote/session.dart';

Future<void> showSourceControlSheet({
  required BuildContext context,
  required ActiveRemoteSession session,
  required RemoteAgent agent,
  GitHubPrResult? initialPr,
}) => showIrisSheet<void>(
  context: context,
  builder: (sheetContext) => SourceControlSheet(
    session: session,
    agent: agent,
    initialPr: initialPr,
    onOpenDiff: (file) {
      Navigator.of(sheetContext).pop();
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) =>
              GitDiffScreen(session: session, agent: agent, file: file),
        ),
      );
    },
  ),
);

class SourceControlSheet extends StatefulWidget {
  const SourceControlSheet({
    required this.session,
    required this.agent,
    required this.onOpenDiff,
    this.initialChanges,
    this.initialPr,
    super.key,
  });

  final ActiveRemoteSession session;
  final RemoteAgent agent;
  final ValueChanged<GitFileChange> onOpenDiff;
  final GitChangesResult? initialChanges;
  final GitHubPrResult? initialPr;

  @override
  State<SourceControlSheet> createState() => _SourceControlSheetState();
}

class _SourceControlSheetState extends State<SourceControlSheet> {
  GitChangesResult? _changes;
  GitHubPrResult? _pr;
  String _pane = 'changes';
  String? _error;
  bool _loading = true;

  bool get _canChanges => widget.session.supports('git.changes');
  bool get _canPr => widget.session.supports('github.pr');

  @override
  void initState() {
    super.initState();
    _changes = widget.initialChanges;
    _pr = widget.initialPr;
    if (!_canChanges && _canPr) _pane = 'pr';
    _load();
  }

  Future<void> _load() async {
    try {
      final values = await Future.wait<ServerMessage>([
        if (_canChanges && _changes == null)
          widget.session.gitChanges(widget.agent.ref),
        if (_canPr && _pr == null) widget.session.githubPr(widget.agent.ref),
      ]);
      if (!mounted) return;
      setState(() {
        for (final value in values) {
          if (value is GitChangesResult) _changes = value;
          if (value is GitHubPrResult) _pr = value;
        }
      });
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: const Key('source-control-sheet'),
      height: 431,
      child: Column(
        children: [
          const IrisSheetGrabber(barKey: Key('source-control-grabber')),
          const SizedBox(height: 14),
          SizedBox(
            key: const Key('source-control-header'),
            height: 35,
            child: Row(
              children: [
                SizedBox(
                  width: 30,
                  height: 30,
                  child: Center(
                    child: IrisIcon(
                      'github-logo',
                      size: 20,
                      color: context.iris.foreground2,
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '${widget.agent.space} · ${_changes?.branch ?? '저장소'}',
                        style: TextStyle(
                          color: context.iris.foreground2,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          height: 17 / 14,
                        ),
                      ),
                      Text(
                        '${_changes?.base.isNotEmpty == true ? _changes!.base : '기준 브랜치'} 대비 · 방금 확인',
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
          if (_canChanges && _canPr) ...[
            const SizedBox(height: 14),
            Container(
              key: const Key('source-control-segment'),
              height: 40,
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Row(
                children: [
                  _Segment(
                    label: '변경 ${_changes?.files.length ?? ''}',
                    selected: _pane == 'changes',
                    onTap: () => setState(() => _pane = 'changes'),
                  ),
                  _Segment(
                    label: _pr == null ? 'PR' : 'PR #${_pr!.pr.number}',
                    selected: _pane == 'pr',
                    onTap: () => setState(() => _pane = 'pr'),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 8),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _error != null
                ? Center(
                    child: Text(
                      _error!,
                      style: TextStyle(color: context.iris.muted),
                    ),
                  )
                : _pane == 'changes'
                ? _ChangesPane(changes: _changes, onOpen: widget.onOpenDiff)
                : _PullRequestPane(
                    session: widget.session,
                    agent: widget.agent,
                    result: _pr,
                    changes: _changes,
                  ),
          ),
        ],
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  const _Segment({
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
        padding: const WidgetStatePropertyAll(EdgeInsets.zero),
        backgroundColor: WidgetStatePropertyAll(
          selected ? context.iris.level3 : Colors.transparent,
        ),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(9)),
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: selected ? context.iris.foreground : context.iris.muted,
          fontSize: 14.5,
          fontWeight: FontWeight.w600,
        ),
      ),
    ),
  );
}

class _ChangesPane extends StatelessWidget {
  const _ChangesPane({required this.changes, required this.onOpen});
  final GitChangesResult? changes;
  final ValueChanged<GitFileChange> onOpen;

  @override
  Widget build(BuildContext context) {
    final value = changes;
    if (value == null) {
      return Center(
        child: Text(
          '변경 목록을 사용할 수 없습니다.',
          style: TextStyle(color: context.iris.muted),
        ),
      );
    }
    return ListView(
      key: const Key('source-change-list'),
      padding: const EdgeInsets.only(top: 4),
      children: [
        SizedBox(
          height: 33,
          child: Row(
            children: [
              const SizedBox(width: 4),
              IrisIcon('git-branch', size: 14, color: context.iris.muted),
              const SizedBox(width: 8),
              Text(
                '${value.commitCount == null ? '' : '커밋 ${value.commitCount} · '}파일 ${value.files.length}',
                style: TextStyle(color: context.iris.muted, fontSize: 13.5),
              ),
              const Spacer(),
              if (value.additions != null || value.deletions != null)
                Text.rich(
                  TextSpan(
                    children: [
                      if (value.additions != null)
                        TextSpan(
                          text: '+${value.additions}',
                          style: TextStyle(color: context.iris.working),
                        ),
                      if (value.additions != null && value.deletions != null)
                        const TextSpan(text: '  '),
                      if (value.deletions != null)
                        TextSpan(
                          text: '−${value.deletions}',
                          style: TextStyle(color: context.iris.blocked),
                        ),
                    ],
                  ),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w400,
                  ),
                ),
              const SizedBox(width: 4),
            ],
          ),
        ),
        for (final file in value.files.take(5))
          Container(
            height: 44,
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: context.iris.separator)),
            ),
            child: TextButton(
              onPressed: () => onOpen(file),
              style: ButtonStyle(
                padding: const WidgetStatePropertyAll(
                  EdgeInsets.symmetric(horizontal: 4),
                ),
                shape: const WidgetStatePropertyAll(RoundedRectangleBorder()),
                side: const WidgetStatePropertyAll(BorderSide.none),
              ),
              child: Row(
                children: [
                  Container(
                    width: 22,
                    height: 22,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: context.iris.level2,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      file.code,
                      style: TextStyle(
                        color: _fileColor(context, file.code),
                        fontFamily: 'monospace',
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text.rich(
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      TextSpan(
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w400,
                        ),
                        children: [
                          TextSpan(
                            text: file.path.contains('/')
                                ? file.path.substring(
                                    0,
                                    file.path.lastIndexOf('/') + 1,
                                  )
                                : '',
                            style: TextStyle(color: context.iris.muted),
                          ),
                          TextSpan(
                            text: file.path.split('/').last,
                            style: TextStyle(color: context.iris.foreground),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (file.additions != null && file.additions! > 0)
                    Text(
                      '+${file.additions}',
                      style: TextStyle(
                        color: context.iris.working,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  if (file.deletions != null && file.deletions! > 0) ...[
                    const SizedBox(width: 8),
                    Text(
                      '−${file.deletions}',
                      style: TextStyle(
                        color: context.iris.blocked,
                        fontSize: 12.5,
                        fontWeight: FontWeight.w400,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
        if (value.files.length > 5)
          SizedBox(
            height: 27,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(4, 10, 4, 0),
              child: Align(
                alignment: Alignment.topLeft,
                child: TextButton(
                  onPressed: null,
                  style: const ButtonStyle(
                    minimumSize: WidgetStatePropertyAll(Size.zero),
                    padding: WidgetStatePropertyAll(EdgeInsets.zero),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: Text(
                    '${value.files.length - 5}개 더 보기',
                    style: TextStyle(
                      color: context.iris.link,
                      fontSize: 14,
                      fontWeight: FontWeight.w400,
                      height: 16.8 / 14,
                    ),
                  ),
                ),
              ),
            ),
          ),
        SizedBox(
          height: 29,
          child: Row(
            children: [
              const SizedBox(width: 4),
              IrisIcon('lock-simple', size: 13, color: context.iris.muted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '커밋·push·브랜치 전환은 컴퓨터에서 합니다',
                  style: TextStyle(color: context.iris.muted, fontSize: 13),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

Color _fileColor(BuildContext context, String code) => switch (code) {
  'A' => context.iris.working,
  'D' => context.iris.blocked,
  _ => context.iris.foreground2,
};

class _PullRequestPane extends StatelessWidget {
  const _PullRequestPane({
    required this.session,
    required this.agent,
    required this.result,
    required this.changes,
  });
  final ActiveRemoteSession session;
  final RemoteAgent agent;
  final GitHubPrResult? result;
  final GitChangesResult? changes;

  @override
  Widget build(BuildContext context) {
    final pr = result?.pr;
    if (pr == null) {
      return Center(
        child: Text(
          '열린 PR이 없습니다.',
          style: TextStyle(color: context.iris.muted),
        ),
      );
    }
    return ListView(
      key: const Key('source-pr-pane'),
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
          child: Text(
            '#${pr.number} ${pr.title}',
            style: TextStyle(
              color: context.iris.foreground,
              fontSize: 17,
              fontWeight: FontWeight.w600,
              height: 1.4,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
          child: Text(
            '${pr.head} → ${pr.base}',
            style: TextStyle(color: context.iris.muted, fontSize: 13.5),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 16, 4, 6),
          child: Text(
            '검사 ${pr.checks.length}',
            style: TextStyle(
              color: context.iris.muted,
              fontSize: 13,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        for (final check in pr.checks)
          SizedBox(
            height: 42,
            child: TextButton(
              onPressed:
                  check.failed &&
                      check.runId != null &&
                      session.supports('github.check.log')
                  ? () => _openCheck(context, check)
                  : null,
              style: const ButtonStyle(
                padding: WidgetStatePropertyAll(
                  EdgeInsets.symmetric(horizontal: 4),
                ),
              ),
              child: Row(
                children: [
                  IrisIcon(
                    check.failed ? 'x-circle' : 'check-circle',
                    size: 18,
                    color: check.failed
                        ? context.iris.blocked
                        : context.iris.working,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      check.name,
                      style: TextStyle(
                        color: context.iris.foreground2,
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  if (check.failed && check.runId != null)
                    Text(
                      '실패 로그',
                      style: TextStyle(
                        color: context.iris.link,
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                ],
              ),
            ),
          ),
        if (pr.reviewComments.isNotEmpty) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 16, 4, 6),
            child: Text(
              '리뷰 의견 ${pr.reviewComments.length}',
              style: TextStyle(
                color: context.iris.muted,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          for (final comment in pr.reviewComments)
            _ReviewComment(
              session: session,
              agent: agent,
              comment: comment,
              changes: changes,
            ),
        ],
      ],
    );
  }

  Future<void> _openCheck(BuildContext context, GitHubCheck check) async {
    try {
      final log = await session.githubCheckLog(agent.ref, check.runId!);
      if (!context.mounted) return;
      await showIrisSheet<void>(
        context: context,
        builder: (_) => CheckFailureSheet(
          session: session,
          agent: agent,
          check: check,
          log: log,
          branch: changes?.branch,
          base: changes?.base,
        ),
      );
    } on RemoteFailure catch (error) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.message)));
      }
    }
  }
}

class _ReviewComment extends StatefulWidget {
  const _ReviewComment({
    required this.session,
    required this.agent,
    required this.comment,
    required this.changes,
  });
  final ActiveRemoteSession session;
  final RemoteAgent agent;
  final GitHubReviewComment comment;
  final GitChangesResult? changes;

  @override
  State<_ReviewComment> createState() => _ReviewCommentState();
}

class _ReviewCommentState extends State<_ReviewComment> {
  String? _result;

  @override
  Widget build(BuildContext context) {
    GitFileChange? file;
    for (final candidate in widget.changes?.files ?? const <GitFileChange>[]) {
      if (candidate.path == widget.comment.path) file = candidate;
    }
    final canDraft =
        file != null &&
        widget.comment.line != null &&
        widget.session.supports('git.diff.draft');
    return Container(
      margin: const EdgeInsets.only(top: 4),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: context.iris.level2,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${widget.comment.author} · ${widget.comment.path}:${widget.comment.line ?? '-'}',
            style: TextStyle(color: context.iris.muted, fontSize: 13),
          ),
          const SizedBox(height: 6),
          Text(
            widget.comment.body,
            style: TextStyle(
              color: context.iris.foreground,
              fontSize: 15,
              height: 1.5,
            ),
          ),
          if (canDraft) ...[
            const SizedBox(height: 10),
            IrisButton(
              label: '입력창에 넣기',
              icon: 'paper-plane-tilt',
              height: 36,
              expand: false,
              onPressed: () async {
                try {
                  final response = await widget.session.draftGitDiff(
                    widget.agent.ref,
                    file!.ref,
                    'new',
                    widget.comment.line!,
                    widget.comment.body,
                  );
                  if (mounted) setState(() => _result = response.result);
                } on RemoteFailure catch (error) {
                  if (mounted) setState(() => _result = error.message);
                }
              },
            ),
          ],
          if (_result != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _result!,
                style: TextStyle(color: context.iris.muted, fontSize: 13),
              ),
            ),
        ],
      ),
    );
  }
}

class CheckFailureSheet extends StatefulWidget {
  const CheckFailureSheet({
    required this.session,
    required this.agent,
    required this.check,
    required this.log,
    this.branch,
    this.base,
    super.key,
  });
  final ActiveRemoteSession session;
  final RemoteAgent agent;
  final GitHubCheck check;
  final GitHubCheckLogResult log;
  final String? branch;
  final String? base;

  @override
  State<CheckFailureSheet> createState() => _CheckFailureSheetState();
}

class _CheckFailureSheetState extends State<CheckFailureSheet> {
  String? _result;
  bool _busy = false;

  @override
  Widget build(BuildContext context) => SizedBox(
    key: const Key('check-failure-sheet'),
    height: 417,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const IrisSheetGrabber(),
        const SizedBox(height: 14),
        Row(
          children: [
            const SizedBox(
              width: 30,
              child: Center(child: IrisIcon('github-logo', size: 20)),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${widget.agent.space} · ${widget.branch ?? '저장소'}',
                    style: TextStyle(
                      color: context.iris.foreground2,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    '${widget.base ?? '기준 브랜치'} 대비 · 방금 확인',
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
        const SizedBox(height: 10),
        Row(
          children: [
            IrisIcon('x-circle', size: 22, color: context.iris.blocked),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                '${widget.check.name} 실패',
                style: TextStyle(
                  color: context.iris.foreground,
                  fontSize: 21,
                  fontWeight: FontWeight.w700,
                  height: 1.35,
                  letterSpacing: -0.42,
                ),
              ),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(top: 14.2),
          child: Container(
            key: const Key('check-log'),
            width: double.infinity,
            height: 154,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: context.iris.terminal,
              borderRadius: BorderRadius.circular(14),
            ),
            child: SingleChildScrollView(
              child: LayoutBuilder(
                builder: (context, constraints) => UnconstrainedBox(
                  alignment: Alignment.topLeft,
                  constrainedAxis: Axis.vertical,
                  clipBehavior: Clip.hardEdge,
                  child: SizedBox(
                    width: constraints.maxWidth / 0.94,
                    child: Transform.scale(
                      scaleX: 0.94,
                      alignment: Alignment.topLeft,
                      child: SelectableText.rich(
                        _checkLogText(widget.log.log),
                        style: const TextStyle(
                          color: Color(0xffc9dcea),
                          fontFamily: 'monospace',
                          fontSize: 12,
                          height: 1.6,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
          child: Text(
            '에이전트가 작업 중이면 넣을 수 없습니다. 넣은 뒤 대화 화면에서 고쳐서 보냅니다.',
            style: TextStyle(
              color: context.iris.muted,
              fontSize: 14.5,
              height: 1.5,
            ),
          ),
        ),
        const Spacer(),
        SizedBox(
          height: 32,
          child: Row(
            children: [
              Text('보낼 곳', style: TextStyle(color: context.iris.muted)),
              const Spacer(),
              Container(
                width: 142,
                height: 32,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: context.iris.level2,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Row(
                  children: [
                    IrisAgentTile(
                      kind: widget.agent.kind,
                      status: 'done',
                      small: true,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      widget.agent.name,
                      style: TextStyle(
                        color: context.iris.foreground,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                    const SizedBox(width: 6),
                    const IrisIcon('caret-down', size: 13),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        if (_result != null) Offstage(child: Text(_result!)),
        Row(
          children: [
            IrisButton(
              label: _busy ? '넣는 중…' : '로그를 입력창에 넣기',
              icon: 'paper-plane-tilt',
              tone: IrisButtonTone.primary,
              onPressed: _busy || !widget.session.supports('github.check.draft')
                  ? null
                  : _draft,
            ),
          ],
        ),
      ],
    ),
  );

  Future<void> _draft() async {
    setState(() => _busy = true);
    try {
      final response = await widget.session.draftGithubCheck(
        widget.agent.ref,
        widget.check.runId!,
      );
      if (mounted) setState(() => _result = response.result);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _result = error.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

TextSpan _checkLogText(String log) {
  const foreground = Color(0xffc9dcea);
  const dim = Color(0xff5e7b8e);
  const failed = Color(0xffff7a72);
  final children = <TextSpan>[];
  for (final entry in log.split('\n').indexed) {
    if (entry.$1 > 0) children.add(const TextSpan(text: '\n'));
    final line = entry.$2;
    if (line.startsWith('✗')) {
      children.add(
        const TextSpan(
          text: '✗',
          style: TextStyle(color: failed),
        ),
      );
      children.add(TextSpan(text: line.substring(1)));
    } else if (line.startsWith('1 failed')) {
      children.add(
        const TextSpan(
          text: '1 failed',
          style: TextStyle(color: failed),
        ),
      );
      children.add(TextSpan(text: line.substring('1 failed'.length)));
    } else {
      children.add(
        TextSpan(
          text: line,
          style: TextStyle(
            color: entry.$1 == 0 || line.trimLeft().startsWith('at ')
                ? dim
                : foreground,
          ),
        ),
      );
    }
  }
  return TextSpan(children: children);
}

class GitDiffScreen extends StatefulWidget {
  const GitDiffScreen({
    required this.session,
    required this.agent,
    required this.file,
    this.initialDiff,
    super.key,
  });
  final ActiveRemoteSession session;
  final RemoteAgent agent;
  final GitFileChange file;
  final GitDiffResult? initialDiff;

  @override
  State<GitDiffScreen> createState() => _GitDiffScreenState();
}

class _GitDiffScreenState extends State<GitDiffScreen> {
  GitDiffResult? _diff;
  String? _error;
  int? _selectedLine;

  @override
  void initState() {
    super.initState();
    _diff = widget.initialDiff;
    if (_diff == null) _load();
  }

  Future<void> _load() async {
    try {
      final value = await widget.session.gitDiff(
        widget.agent.ref,
        widget.file.ref,
      );
      if (mounted) setState(() => _diff = value);
    } on RemoteFailure catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final lines = _diff == null
        ? const <_DiffLine>[]
        : _parseDiff(_diff!.patch);
    return Scaffold(
      backgroundColor: context.iris.terminal,
      body: SafeArea(
        child: Column(
          children: [
            Container(
              key: const Key('diff-header'),
              height: 58,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              color: context.iris.background,
              child: Row(
                children: [
                  IrisRoundButton(
                    icon: 'caret-left',
                    tooltip: '뒤로',
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Transform.translate(
                      offset: const Offset(0, -2),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          SizedBox(
                            height: 18,
                            child: Text(
                              widget.file.path.split('/').last,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                                height: 1.2,
                              ),
                            ),
                          ),
                          Text(
                            '${widget.file.additions == null ? '' : '+${widget.file.additions}'}${widget.file.additions != null && widget.file.deletions != null ? ' ' : ''}${widget.file.deletions == null ? '' : '−${widget.file.deletions}'}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: context.iris.muted,
                              fontSize: 13,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 48),
                ],
              ),
            ),
            Expanded(
              child: _error != null
                  ? Center(
                      child: Text(
                        _error!,
                        style: TextStyle(color: context.iris.muted),
                      ),
                    )
                  : _diff == null
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.builder(
                      key: const Key('diff-lines'),
                      itemCount: lines.length,
                      itemBuilder: (context, index) {
                        final line = lines[index];
                        if (line.number == null) {
                          return SizedBox(
                            height: 31,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                              ),
                              child: Align(
                                alignment: Alignment.centerLeft,
                                child: Text(
                                  line.text,
                                  maxLines: 1,
                                  overflow: TextOverflow.clip,
                                  softWrap: false,
                                  style: const TextStyle(
                                    color: Color(0xff5e7b8e),
                                    fontFamily: 'monospace',
                                    fontSize: 12,
                                    height: 1.75,
                                  ),
                                ),
                              ),
                            ),
                          );
                        }
                        return InkWell(
                          onTap:
                              line.number == null ||
                                  !widget.session.supports('git.diff.draft')
                              ? null
                              : () => _comment(line),
                          child: Container(
                            color: _selectedLine == line.number
                                ? context.iris.brand.withValues(alpha: 0.12)
                                : line.kind == '+'
                                ? const Color(0x148bfbc2)
                                : line.kind == '-'
                                ? const Color(0x14ff7a72)
                                : null,
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                SizedBox(
                                  width: 34,
                                  child: Text(
                                    line.number?.toString() ?? '',
                                    textAlign: TextAlign.right,
                                    style: TextStyle(
                                      color: line.kind == '-'
                                          ? const Color(0xffb5625c)
                                          : line.kind == '+'
                                          ? const Color(0xff5fb98e)
                                          : const Color(0xff4a6576),
                                      fontFamily: 'monospace',
                                      fontSize: 12.5,
                                      height: 1.75,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Expanded(
                                  child: Text(
                                    line.text,
                                    style: TextStyle(
                                      color: line.kind == '-'
                                          ? const Color(0xffe3a7a2)
                                          : const Color(0xffc9dcea),
                                      fontFamily: 'monospace',
                                      fontSize: 12.5,
                                      height: 1.75,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _comment(_DiffLine line) async {
    setState(() => _selectedLine = line.number);
    final controller = TextEditingController();
    await showIrisSheet<void>(
      context: context,
      barrierColor: Colors.transparent,
      builder: (sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(),
          const SizedBox(height: 14),
          SizedBox(
            height: 34,
            child: Row(
              children: [
                const SizedBox(
                  width: 32,
                  child: Center(child: IrisIcon('chat-circle-dots', size: 18)),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        SizedBox(
                          height: 18,
                          child: Text(
                            '${line.number}번 줄에 의견',
                            style: TextStyle(
                              color: context.iris.foreground2,
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              height: 1.2,
                            ),
                          ),
                        ),
                        SizedBox(
                          height: 16,
                          child: Text(
                            widget.file.path,
                            style: TextStyle(
                              color: context.iris.muted,
                              fontSize: 13,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Container(
            height: 74,
            decoration: BoxDecoration(
              color: context.iris.level2,
              borderRadius: BorderRadius.circular(14),
            ),
            child: TextField(
              key: const Key('diff-comment-input'),
              controller: controller,
              autofocus: false,
              minLines: 3,
              maxLines: 3,
              maxLength: 4000,
              style: const TextStyle(fontSize: 15.5, height: 1.45),
              decoration: const InputDecoration(
                hintText: '의견',
                counterText: '',
                isDense: true,
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 12,
                ),
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
              ),
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 32,
            child: Row(
              children: [
                Text('보낼 곳', style: TextStyle(color: context.iris.muted)),
                const Spacer(),
                Transform.translate(
                  offset: const Offset(-4, 0),
                  child: Container(
                    width: 138,
                    height: 32,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(
                      color: context.iris.level2,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      children: [
                        IrisAgentTile(
                          kind: widget.agent.kind,
                          status: 'done',
                          small: true,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          widget.agent.name,
                          style: TextStyle(
                            color: context.iris.foreground,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const SizedBox(width: 6),
                        const IrisIcon('caret-down', size: 13),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          SizedBox(
            height: 64,
            child: Align(
              alignment: Alignment.bottomCenter,
              child: Row(
                children: [
                  SizedBox(
                    width: 96,
                    child: IrisButton(
                      label: '저장',
                      expand: false,
                      onPressed: () {},
                    ),
                  ),
                  const SizedBox(width: 10),
                  IrisButton(
                    label: '입력창에 넣기',
                    icon: 'paper-plane-tilt',
                    tone: IrisButtonTone.primary,
                    onPressed: () async {
                      if (controller.text.isEmpty) return;
                      try {
                        await widget.session.draftGitDiff(
                          widget.agent.ref,
                          widget.file.ref,
                          line.kind == '-' ? 'old' : 'new',
                          line.number!,
                          controller.text,
                        );
                        if (sheetContext.mounted) {
                          Navigator.of(sheetContext).pop();
                        }
                      } on RemoteFailure catch (error) {
                        if (sheetContext.mounted) {
                          ScaffoldMessenger.of(sheetContext).showSnackBar(
                            SnackBar(content: Text(error.message)),
                          );
                        }
                      }
                    },
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
    controller.dispose();
    if (mounted) setState(() => _selectedLine = null);
  }
}

class _DiffLine {
  const _DiffLine(this.kind, this.number, this.text);
  final String kind;
  final int? number;
  final String text;
}

List<_DiffLine> _parseDiff(String patch) {
  var oldLine = 0;
  var newLine = 0;
  final result = <_DiffLine>[];
  final hunk = RegExp(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@');
  for (final text in patch.split('\n')) {
    final match = hunk.firstMatch(text);
    if (match != null) {
      oldLine = int.parse(match.group(1)!);
      newLine = int.parse(match.group(2)!);
      result.add(_DiffLine('@', null, text));
    } else if (text.startsWith('+') && !text.startsWith('+++')) {
      result.add(_DiffLine('+', newLine++, text));
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      result.add(_DiffLine('-', oldLine++, text));
    } else {
      result.add(_DiffLine(' ', newLine == 0 ? null : newLine++, text));
      if (oldLine > 0) oldLine++;
    }
  }
  return result;
}
