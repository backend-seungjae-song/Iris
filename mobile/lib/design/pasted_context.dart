import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/sheet.dart';
import 'package:iris_remote/design/tokens.dart';

enum PastedContextKind { element, record, sketch }

extension PastedContextKindUi on PastedContextKind {
  String get label => switch (this) {
    PastedContextKind.element => '브라우저 요소',
    PastedContextKind.record => '조작 기록',
    PastedContextKind.sketch => '화면 스케치',
  };

  String get icon => switch (this) {
    PastedContextKind.element => 'cursor-click',
    PastedContextKind.record => 'list-numbers',
    PastedContextKind.sketch => 'scribble-loop',
  };
}

PastedContextKind pastedContextKind(String value) => switch (value) {
  'element' => PastedContextKind.element,
  'record' => PastedContextKind.record,
  'sketch' => PastedContextKind.sketch,
  _ => throw ArgumentError.value(value, 'value'),
};

class PastedContextBlock {
  const PastedContextBlock({
    required this.kind,
    required this.summary,
    required this.content,
  });

  final PastedContextKind kind;
  final String summary;
  final String content;
}

class PastedMessage {
  const PastedMessage({required this.text, required this.blocks});

  final String text;
  final List<PastedContextBlock> blocks;
}

PastedMessage? parsePastedMessage(String value) {
  final marker = RegExp(
    r'^\[(브라우저 요소|폰 브라우저 조작 기록|폰 화면 스케치)\]\s*$',
    multiLine: true,
  );
  final matches = marker.allMatches(value).toList();
  if (matches.isEmpty) return null;
  final blocks = <PastedContextBlock>[];
  for (var index = 0; index < matches.length; index++) {
    final match = matches[index];
    final end = index + 1 < matches.length
        ? matches[index + 1].start
        : value.length;
    final content = value.substring(match.start, end).trim();
    final title = match.group(1)!;
    final kind = switch (title) {
      '브라우저 요소' => PastedContextKind.element,
      '폰 브라우저 조작 기록' => PastedContextKind.record,
      _ => PastedContextKind.sketch,
    };
    blocks.add(
      PastedContextBlock(
        kind: kind,
        summary: _blockSummary(kind, content),
        content: content,
      ),
    );
  }
  return PastedMessage(
    text: value.substring(0, matches.first.start).trim(),
    blocks: List.unmodifiable(blocks),
  );
}

String _blockSummary(PastedContextKind kind, String content) {
  switch (kind) {
    case PastedContextKind.element:
      final text = _field(content, '글자:');
      return _shortSummary(
        text.isNotEmpty && text != '(없음)' ? text : _field(content, '선택자:'),
      );
    case PastedContextKind.record:
      final steps = RegExp(
        r'^\d+\.\s',
        multiLine: true,
      ).allMatches(content).length;
      return '$steps단계';
    case PastedContextKind.sketch:
      return _shortSummary(_field(content, '대상:'));
  }
}

String _field(String content, String prefix) {
  for (final line in content.split('\n')) {
    if (line.startsWith(prefix)) return line.substring(prefix.length).trim();
  }
  return '';
}

String _shortSummary(String value) {
  final fallback = value.isEmpty ? '내용' : value;
  return fallback.length <= 32 ? fallback : '${fallback.substring(0, 31)}…';
}

class PastedContextChip extends StatelessWidget {
  const PastedContextChip({
    required this.kind,
    required this.summary,
    required this.onPressed,
    this.onRemove,
    super.key,
  });

  final PastedContextKind kind;
  final String summary;
  final VoidCallback onPressed;
  final VoidCallback? onRemove;

  @override
  Widget build(BuildContext context) => Material(
    color: context.iris.level2,
    borderRadius: BorderRadius.circular(18),
    child: InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(18),
      child: Container(
        constraints: const BoxConstraints(minHeight: 36, maxWidth: 280),
        padding: EdgeInsets.fromLTRB(11, 0, onRemove == null ? 13 : 4, 0),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IrisIcon(kind.icon, size: 16, color: context.iris.foreground2),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                '${kind.label} · $summary',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: context.iris.foreground2,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
            if (onRemove != null) ...[
              const SizedBox(width: 3),
              Semantics(
                button: true,
                label: '${kind.label} 삭제',
                child: IconButton(
                  key: const Key('pasted-context-remove'),
                  onPressed: onRemove,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints.tightFor(
                    width: 32,
                    height: 36,
                  ),
                  icon: IrisIcon('x', size: 15, color: context.iris.muted),
                ),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

Future<void> showPastedContext({
  required BuildContext context,
  required PastedContextKind kind,
  required String summary,
  required String content,
}) => showIrisSheet<void>(
  context: context,
  builder: (_) =>
      _PastedContextSheet(kind: kind, summary: summary, content: content),
);

class _PastedContextSheet extends StatefulWidget {
  const _PastedContextSheet({
    required this.kind,
    required this.summary,
    required this.content,
  });

  final PastedContextKind kind;
  final String summary;
  final String content;

  @override
  State<_PastedContextSheet> createState() => _PastedContextSheetState();
}

class _PastedContextSheetState extends State<_PastedContextSheet> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    final available = MediaQuery.sizeOf(context).height * 0.62;
    final height = available < 520 ? available : 520.0;
    return SizedBox(
      key: const Key('pasted-context-sheet'),
      height: height,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const IrisSheetGrabber(),
          const SizedBox(height: 18),
          Row(
            children: [
              IrisIcon(
                widget.kind.icon,
                size: 20,
                color: context.iris.foreground2,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.kind.label,
                      style: const TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      widget.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: context.iris.muted, fontSize: 13),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Expanded(
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: context.iris.level2,
                borderRadius: BorderRadius.circular(16),
              ),
              child: SingleChildScrollView(
                child: SelectableText(
                  widget.content,
                  key: const Key('pasted-context-content'),
                  style: IrisType.mono.copyWith(
                    color: context.iris.foreground2,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 14),
          IrisButton(
            key: const Key('pasted-context-copy'),
            label: _copied ? '복사됨' : '복사',
            icon: 'copy',
            expand: false,
            width: double.infinity,
            onPressed: () async {
              await Clipboard.setData(ClipboardData(text: widget.content));
              if (mounted) setState(() => _copied = true);
            },
          ),
        ],
      ),
    );
  }
}
