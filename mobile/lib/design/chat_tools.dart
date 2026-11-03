import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/markdown_text.dart';
import 'package:iris_remote/design/status_glyph.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';

// 도구 호출 한 줄. 서버는 호출(입력)과 결과(출력)를 따로 보낸다
class IrisToolRow {
  const IrisToolRow({
    required this.tool,
    required this.verb,
    required this.icon,
    required this.target,
    this.output,
    this.diff,
    this.added = 0,
    this.removed = 0,
  });

  final String tool;
  final String verb;
  final String icon;
  final String target;
  // 결과 글. null 이면 아직 결과가 오지 않음
  final String? output;
  // 수정 도구의 old/new 문자열 전체를 읽었을 때만 채움
  final List<IrisDiffLine>? diff;
  final int added;
  final int removed;

  bool get pending => output == null;
  bool get expandable => diff != null || (output?.isNotEmpty ?? false);

  IrisToolRow withOutput(String value) => IrisToolRow(
    tool: tool,
    verb: verb,
    icon: icon,
    target: target,
    output: value,
    diff: diff,
    added: added,
    removed: removed,
  );

  // 진행 중 줄 안내 글. 예: 명령 실행 중
  String get pendingLabel => switch (verb) {
    '읽기' => '읽는 중',
    '수정' => '수정하는 중',
    '실행' => '명령 실행 중',
    '검색' => '검색 중',
    _ => '$tool 실행 중',
  };
}

class IrisDiffLine {
  const IrisDiffLine(this.added, this.text);
  final bool added;
  final String text;
}

// 연속한 role=tool 항목을 호출·결과 짝으로 묶어 줄 목록으로 만든다
// 서버는 호출 ID 를 주지 않아 도구 이름과 순서만 단서
// 확신할 수 없으면 짝짓기를 포기하고 원문 전체를 가진 단독 줄로 둔다
List<IrisToolRow> buildToolRows(List<TranscriptItem> items) {
  final rows = <IrisToolRow>[];
  final waiting = <int>[];
  int waitingOf(String tool) =>
      waiting.where((i) => rows[i].tool == tool).length;
  for (final item in items) {
    final tool = item.tool ?? '도구';
    final text = item.text;
    final json = text.trimLeft().startsWith('{');
    final pending = waitingOf(tool);
    // JSON 글은 호출 입력일 수도 JSON 결과일 수도 있음: 같은 도구가 대기 중이면 입력 모양으로 가름
    if (json && (pending == 0 || _looksLikeCall(text))) {
      waiting.add(rows.length);
      rows.add(_callRow(tool, text));
      continue;
    }
    // 같은 도구 대기가 하나일 때만 결과로 짝짓기: 병렬 호출은 결과 순서를 모름
    if (pending == 1) {
      final at = waiting.firstWhere((i) => rows[i].tool == tool);
      waiting.remove(at);
      rows[at] = rows[at].withOutput(text);
      continue;
    }
    final style = _verbOf(tool);
    rows.add(
      IrisToolRow(
        tool: tool,
        verb: style.$1,
        icon: style.$2,
        target: _firstLine(text),
        output: text,
      ),
    );
  }
  return rows;
}

// 호출 입력 모양: 200자에서 잘렸거나, 대상·수정 키를 가진 객체
bool _looksLikeCall(String text) {
  try {
    final value = jsonDecode(text);
    if (value is! Map<String, dynamic>) return false;
    return _targetKeys.any(value.containsKey) ||
        value.containsKey('new_string') ||
        value.containsKey('edits');
  } catch (_) {
    return true;
  }
}

(String, String) _verbOf(String tool) => switch (tool.toLowerCase()) {
  'read' || 'view' || 'cat' => ('읽기', 'file-text'),
  'edit' ||
  'multiedit' ||
  'write' ||
  'notebookedit' ||
  'apply_patch' ||
  'applypatch' ||
  'str_replace_editor' => ('수정', 'pencil-simple'),
  'bash' ||
  'shell' ||
  'exec_command' ||
  'local_shell' ||
  'powershell' => ('실행', 'terminal-window'),
  'grep' || 'glob' || 'ls' || 'search' => ('검색', 'magnifying-glass'),
  'webfetch' || 'websearch' => ('웹', 'globe'),
  _ => ('도구', 'list-bullets'),
};

const _targetKeys = [
  'file_path',
  'path',
  'notebook_path',
  'filePath',
  'command',
  'cmd',
  'pattern',
  'url',
  'query',
  'description',
];

IrisToolRow _callRow(String tool, String text) {
  final style = _verbOf(tool);
  Map<String, dynamic>? input;
  try {
    final value = jsonDecode(text);
    if (value is Map<String, dynamic>) input = value;
  } catch (_) {}
  var target = '';
  if (input != null) {
    for (final key in _targetKeys) {
      final value = input[key];
      if (value is String && value.isNotEmpty) {
        target = value;
        break;
      }
      if (value is List && value.isNotEmpty) {
        target = value.join(' ');
        break;
      }
    }
  } else {
    // 200자에서 잘린 입력은 앞쪽 키만 읽는다
    for (final key in _targetKeys) {
      final match = RegExp('"$key"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)')
          .firstMatch(text);
      if (match != null) {
        target = _unescape(match.group(1)!);
        break;
      }
    }
  }
  List<IrisDiffLine>? diff;
  if (style.$1 == '수정' && input != null) {
    diff = _diffOf(input);
  }
  return IrisToolRow(
    tool: tool,
    verb: style.$1,
    icon: style.$2,
    target: style.$1 == '수정' || style.$1 == '읽기'
        ? _shortPath(_firstLine(target))
        : _firstLine(target),
    diff: diff,
    added: diff?.where((l) => l.added).length ?? 0,
    removed: diff?.where((l) => !l.added).length ?? 0,
  );
}

String _unescape(String raw) {
  try {
    return jsonDecode('"$raw"') as String;
  } catch (_) {
    return raw;
  }
}

List<IrisDiffLine>? _diffOf(Map<String, dynamic> input) {
  final lines = <IrisDiffLine>[];
  void edit(Object? before, Object? after) {
    if (before is String && before.isNotEmpty) {
      lines.addAll(before.split('\n').map((l) => IrisDiffLine(false, l)));
    }
    if (after is String && after.isNotEmpty) {
      lines.addAll(after.split('\n').map((l) => IrisDiffLine(true, l)));
    }
  }

  final edits = input['edits'];
  if (edits is List) {
    for (final item in edits.whereType<Map<String, dynamic>>()) {
      edit(item['old_string'], item['new_string']);
    }
  } else if (input.containsKey('new_string')) {
    edit(input['old_string'], input['new_string']);
  } else if (input['content'] is String) {
    edit(null, input['content']);
  }
  return lines.isEmpty ? null : lines;
}

String _firstLine(String value) {
  final line = value.trim().split('\n').first.trim();
  return line;
}

// 긴 경로는 뒤 세 마디만 남긴다
String _shortPath(String path) {
  if (path.length <= 34 || !path.contains('/')) return path;
  final parts = path.split('/').where((p) => p.isNotEmpty).toList();
  return parts.length <= 3
      ? path
      : '…/${parts.sublist(parts.length - 3).join('/')}';
}

// 도구 표 .tools. 줄마다 눌러 출력이나 변경 내용을 펼친다
class IrisToolTable extends StatefulWidget {
  const IrisToolTable({required this.rows, required this.live, super.key});

  final List<IrisToolRow> rows;
  // 맨 끝 표이고 에이전트가 작업 중이면 결과 없는 줄에 회전 표시
  final bool live;

  @override
  State<IrisToolTable> createState() => _IrisToolTableState();
}

class _IrisToolTableState extends State<IrisToolTable> {
  final Set<int> _open = {};

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      key: const Key('session-tool-card'),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(IrisRadius.card),
        border: Border.all(color: colors.separator),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          for (final entry in widget.rows.indexed) ...[
            if (entry.$1 > 0)
              Divider(height: 1, thickness: 1, color: colors.separator),
            _ToolLine(
              lineKey: Key('session-tool-row-${entry.$1}'),
              row: entry.$2,
              live: widget.live,
              open: _open.contains(entry.$1),
              onToggle: entry.$2.expandable
                  ? () => setState(
                      () => _open.contains(entry.$1)
                          ? _open.remove(entry.$1)
                          : _open.add(entry.$1),
                    )
                  : null,
            ),
          ],
        ],
      ),
    );
  }
}

class _ToolLine extends StatelessWidget {
  const _ToolLine({
    required this.row,
    required this.live,
    required this.open,
    required this.onToggle,
    required this.lineKey,
  });

  // 펼침 영역을 뺀 머리 줄에만 붙이는 키
  final Key lineKey;
  final IrisToolRow row;
  final bool live;
  final bool open;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final counts = row.added > 0 || row.removed > 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          key: lineKey,
          onTap: onToggle,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 46),
            child: Padding(
              padding: const EdgeInsets.only(left: 12, right: 6),
              child: Row(
                children: [
                  IrisIcon(row.icon, size: 16, color: colors.muted),
                  const SizedBox(width: 10),
                  SizedBox(
                    width: 30,
                    child: Text(
                      row.verb,
                      maxLines: 1,
                      style: TextStyle(
                        color: colors.foreground2,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        height: 1.2,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      row.target.isEmpty ? row.tool : row.target,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: row.verb == '실행' && row.pending && live
                            ? colors.strong
                            : colors.foreground,
                        fontFamily: 'monospace',
                        fontSize: 13,
                        height: 1.2,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  if (counts)
                    Text.rich(
                      TextSpan(
                        children: [
                          if (row.added > 0)
                            TextSpan(
                              text: '+${row.added}',
                              style: TextStyle(color: colors.okText),
                            ),
                          if (row.added > 0 && row.removed > 0)
                            const TextSpan(text: ' '),
                          if (row.removed > 0)
                            TextSpan(
                              text: '−${row.removed}',
                              style: TextStyle(color: colors.dangerText),
                            ),
                        ],
                      ),
                      style: const TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w600,
                      ),
                    )
                  else if (row.pending && live)
                    const IrisStatusGlyph(status: 'working', size: 18)
                  else if (!row.pending)
                    IrisIcon('check', size: 15, color: colors.okText),
                  SizedBox(
                    width: 36,
                    height: 36,
                    child: onToggle == null
                        ? null
                        : Center(
                            child: AnimatedRotation(
                              turns: open ? .5 : 0,
                              duration: const Duration(milliseconds: 180),
                              curve: irisEase,
                              child: IrisIcon(
                                'caret-down',
                                size: 18,
                                color: colors.muted,
                              ),
                            ),
                          ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (open) _ToolDetail(row: row),
      ],
    );
  }
}

class _ToolDetail extends StatelessWidget {
  const _ToolDetail({required this.row});

  final IrisToolRow row;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final light = Theme.of(context).brightness == Brightness.light;
    final output = row.output ?? '';
    final media = RegExp(
      r'\[([^\]]+)\]\((iris-media:[0-9a-f]{32}|https?://[^\s)]+)\)',
    ).allMatches(output);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            key: const Key('session-tool-detail'),
            constraints: const BoxConstraints(maxHeight: 320),
            decoration: BoxDecoration(
              color: light ? colors.level2 : colors.background2,
              borderRadius: BorderRadius.circular(IrisRadius.field),
            ),
            clipBehavior: Clip.antiAlias,
            child: SingleChildScrollView(
              child: row.diff != null
                  ? _DiffLines(lines: row.diff!)
                  : Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 8,
                      ),
                      child: SelectableText.rich(
                        _outputText(output, colors),
                        style: TextStyle(
                          color: colors.foreground2,
                          fontFamily: 'monospace',
                          fontSize: 12,
                          height: 1.6,
                        ),
                      ),
                    ),
            ),
          ),
          for (final match in media)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: IrisMarkdown(
                match.group(0)!,
                selectable: false,
                compact: true,
              ),
            ),
        ],
      ),
    );
  }
}

// 변경 줄. 줄 전체 배경색 + 부호 열
class _DiffLines extends StatelessWidget {
  const _DiffLines({required this.lines});

  final List<IrisDiffLine> lines;

  @override
  Widget build(BuildContext context) {
    final diff = IrisDiffColors.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final line in lines)
            Container(
              color: line.added ? diff.addBg : diff.delBg,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 14,
                    child: Text(
                      line.added ? '+' : '−',
                      style: TextStyle(
                        color: line.added ? diff.add : diff.del,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        height: 1.6,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      line.text.isEmpty ? ' ' : line.text,
                      style: TextStyle(
                        color: line.added ? diff.add : diff.del,
                        fontFamily: 'monospace',
                        fontSize: 12,
                        height: 1.6,
                      ),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

TextSpan _outputText(String output, IrisColors colors) {
  final children = <TextSpan>[];
  for (final entry in output.split('\n').indexed) {
    if (entry.$1 > 0) children.add(const TextSpan(text: '\n'));
    final line = entry.$2;
    if (line == '…') {
      children.add(
        TextSpan(
          text: '…',
          style: TextStyle(color: colors.faint),
        ),
      );
    } else if (line.startsWith('✓')) {
      children.add(
        TextSpan(
          text: '✓',
          style: TextStyle(color: colors.okText),
        ),
      );
      children.add(TextSpan(text: line.substring(1)));
    } else {
      children.add(TextSpan(text: line));
    }
  }
  return TextSpan(children: children);
}
