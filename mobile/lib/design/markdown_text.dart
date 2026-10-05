import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:markdown/markdown.dart' as md;

class IrisLinkScope extends InheritedWidget {
  const IrisLinkScope({required this.open, required super.child, super.key});
  final Future<String> Function(String href)? open;
  static IrisLinkScope? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<IrisLinkScope>();
  @override
  bool updateShouldNotify(IrisLinkScope oldWidget) => open != oldWidget.open;
}

class IrisMarkdown extends StatelessWidget {
  const IrisMarkdown(
    this.data, {
    this.baseStyle,
    this.compact = false,
    this.selectable = true,
    this.textColor,
    super.key,
  });

  final String data;
  final TextStyle? baseStyle;
  final bool compact;
  final bool selectable;
  final Color? textColor;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final body = (baseStyle ?? IrisType.body).copyWith(
      color: textColor ?? colors.foreground,
    );
    final blockSpacing = compact ? 5.0 : 10.0;
    return MarkdownBody(
      data: data,
      selectable: selectable,
      fitContent: false,
      softLineBreak: true,
      styleSheet: MarkdownStyleSheet(
        p: body,
        pPadding: EdgeInsets.zero,
        a: body.copyWith(
          color: colors.link,
          decoration: TextDecoration.underline,
          decorationColor: colors.link,
        ),
        em: body.copyWith(fontStyle: FontStyle.italic),
        strong: body.copyWith(fontWeight: FontWeight.w700),
        del: body.copyWith(decoration: TextDecoration.lineThrough),
        h1: body.copyWith(
          fontSize: compact ? 20 : 25,
          height: 1.25,
          fontWeight: FontWeight.w700,
        ),
        h2: body.copyWith(
          fontSize: compact ? 18 : 22,
          height: 1.3,
          fontWeight: FontWeight.w700,
        ),
        h3: body.copyWith(
          fontSize: compact ? 17 : 19,
          height: 1.35,
          fontWeight: FontWeight.w700,
        ),
        h4: body.copyWith(fontWeight: FontWeight.w700),
        h5: body.copyWith(fontWeight: FontWeight.w600),
        h6: body.copyWith(
          color: colors.foreground2,
          fontWeight: FontWeight.w600,
        ),
        h1Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        h2Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        h3Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        h4Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        h5Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        h6Padding: EdgeInsets.only(bottom: blockSpacing / 2),
        blockSpacing: blockSpacing,
        listIndent: compact ? 20 : 24,
        listBullet: body.copyWith(color: colors.foreground2),
        listBulletPadding: const EdgeInsets.only(right: 6),
        blockquote: body.copyWith(color: colors.foreground2),
        blockquotePadding: const EdgeInsets.fromLTRB(12, 7, 10, 7),
        blockquoteDecoration: BoxDecoration(
          color: colors.level1,
          border: Border(left: BorderSide(color: colors.brand, width: 3)),
          borderRadius: BorderRadius.circular(8),
        ),
        code: body.copyWith(
          color: colors.foreground2,
          backgroundColor: colors.level3,
          fontFamily: 'monospace',
          fontSize: body.fontSize == null ? 14 : body.fontSize! * 0.88,
          height: 1.4,
        ),
        tableHead: body.copyWith(fontWeight: FontWeight.w700),
        tableBody: body.copyWith(
          fontSize: body.fontSize == null ? 14 : body.fontSize! * 0.9,
        ),
        tableHeadAlign: TextAlign.left,
        tablePadding: EdgeInsets.only(bottom: blockSpacing),
        tableBorder: TableBorder.all(color: colors.separator, width: 1),
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableScrollbarThumbVisibility: true,
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 10,
          vertical: 7,
        ),
        tableHeadCellsDecoration: BoxDecoration(color: colors.level2),
        tableCellsDecoration: BoxDecoration(color: colors.level1),
        horizontalRuleDecoration: BoxDecoration(
          border: Border(top: BorderSide(color: colors.separator)),
        ),
      ),
      builders: {'pre': _CodeBlockBuilder()},
      imageBuilder: (uri, title, alt) => _BlockedImage(alt: alt, uri: uri),
      onTapLink: (text, href, title) {
        if (href != null) _showLink(context, href);
      },
    );
  }
}

Future<void> _showLink(BuildContext context, String href) async {
  final open = IrisLinkScope.of(context)?.open;
  await showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('링크 주소'),
      content: SelectableText(href, key: const Key('markdown-link-address')),
      actions: [
        if (open != null)
          TextButton(
            key: const Key('markdown-link-mac'),
            onPressed: () async {
              Navigator.of(dialogContext).pop();
              final message = await open(href);
              if (context.mounted) {
                ScaffoldMessenger.of(context)
                    .showSnackBar(SnackBar(content: Text(message)));
              }
            },
            child: const Text('컴퓨터 브라우저에서 열기'),
          ),
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(),
          child: const Text('닫기'),
        ),
        TextButton(
          key: const Key('markdown-link-copy'),
          onPressed: () {
            Clipboard.setData(ClipboardData(text: href));
            Navigator.of(dialogContext).pop();
          },
          child: const Text('주소 복사'),
        ),
      ],
    ),
  );
}

class _BlockedImage extends StatelessWidget {
  const _BlockedImage({required this.alt, required this.uri});

  final String? alt;
  final Uri uri;

  @override
  Widget build(BuildContext context) => Semantics(
    label: uri.host.isEmpty ? '외부 이미지' : '외부 이미지 ${uri.host}',
    child: InkWell(
      onTap: () => _showLink(context, uri.toString()),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(
          color: context.iris.level1,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IrisIcon('file-text', size: 15, color: context.iris.muted),
            const SizedBox(width: 7),
            Flexible(
              child: Text(
                alt?.isNotEmpty == true ? '이미지: $alt' : '외부 이미지',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: context.iris.muted, fontSize: 13),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

class _CodeBlockBuilder extends MarkdownElementBuilder {
  @override
  bool isBlockElement() => true;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final codeElement = element.children?.whereType<md.Element>().firstOrNull;
    final className = codeElement?.attributes['class'] ?? '';
    final language = className.startsWith('language-')
        ? className.substring('language-'.length).trim().toLowerCase()
        : '';
    final code = codeElement?.textContent ?? element.textContent;
    return _CodeBlock(code: code, language: language);
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.code, required this.language});

  final String code;
  final String language;

  @override
  Widget build(BuildContext context) {
    final shownLanguage = language.isEmpty ? 'code' : language;
    return Container(
      key: Key('markdown-code-$shownLanguage'),
      width: double.infinity,
      decoration: BoxDecoration(
        color: context.iris.terminal,
        borderRadius: BorderRadius.circular(14),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            height: 38,
            child: Padding(
              padding: const EdgeInsets.only(left: 12, right: 4),
              child: Row(
                children: [
                  Text(
                    shownLanguage,
                    style: const TextStyle(
                      color: Color(0xff8199aa),
                      fontFamily: 'monospace',
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const Spacer(),
                  IconButton(
                    key: const Key('markdown-code-copy'),
                    tooltip: '코드 복사',
                    onPressed: () =>
                        Clipboard.setData(ClipboardData(text: code)),
                    icon: const IrisIcon(
                      'copy',
                      size: 16,
                      color: Color(0xff8fd0f2),
                    ),
                  ),
                ],
              ),
            ),
          ),
          SingleChildScrollView(
            key: const Key('markdown-code-scroll'),
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.fromLTRB(12, 2, 12, 12),
            child: SelectableText.rich(
              highlightCode(code, language),
              key: const Key('markdown-code-text'),
              textScaler: MediaQuery.textScalerOf(context),
              style: const TextStyle(
                color: Color(0xffc9dcea),
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.55,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

@visibleForTesting
TextSpan highlightCode(String source, String language) {
  final normalized = _languageAlias(language);
  if (normalized == 'diff') return _highlightDiff(source);
  final keywords = _keywords[normalized] ?? _commonKeywords;
  final lineComment = switch (normalized) {
    'python' || 'ruby' || 'shell' || 'yaml' => '#',
    'sql' => '--',
    _ => '//',
  };
  final spans = <TextSpan>[];
  var index = 0;
  var blockComment = false;
  while (index < source.length) {
    if (blockComment) {
      final end = source.indexOf('*/', index);
      final stop = end < 0 ? source.length : end + 2;
      spans.add(
        TextSpan(text: source.substring(index, stop), style: _codeComment),
      );
      index = stop;
      blockComment = end < 0;
      continue;
    }
    if (source.startsWith('/*', index)) {
      blockComment = true;
      continue;
    }
    if (source.startsWith(lineComment, index)) {
      final end = source.indexOf('\n', index);
      final stop = end < 0 ? source.length : end;
      spans.add(
        TextSpan(text: source.substring(index, stop), style: _codeComment),
      );
      index = stop;
      continue;
    }
    final char = source[index];
    if (char == '"' || char == "'" || char == '`') {
      final stop = _stringEnd(source, index, char);
      spans.add(
        TextSpan(text: source.substring(index, stop), style: _codeString),
      );
      index = stop;
      continue;
    }
    final number = RegExp(r'^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)')
        .firstMatch(source.substring(index));
    if (number != null) {
      final value = number.group(0)!;
      spans.add(TextSpan(text: value, style: _codeNumber));
      index += value.length;
      continue;
    }
    final word = RegExp(r'^[A-Za-z_][A-Za-z0-9_]*')
        .firstMatch(source.substring(index));
    if (word != null) {
      final value = word.group(0)!;
      spans.add(
        TextSpan(
          text: value,
          style: keywords.contains(value) ? _codeKeyword : null,
        ),
      );
      index += value.length;
      continue;
    }
    spans.add(TextSpan(text: char));
    index++;
  }
  return TextSpan(children: spans);
}

TextSpan _highlightDiff(String source) {
  final spans = <TextSpan>[];
  final lines = source.split('\n');
  for (var index = 0; index < lines.length; index++) {
    final line = lines[index];
    final style = line.startsWith('+') && !line.startsWith('+++')
        ? _diffAdd
        : line.startsWith('-') && !line.startsWith('---')
        ? _diffDelete
        : line.startsWith('@@')
        ? _diffHeader
        : null;
    spans.add(TextSpan(text: line, style: style));
    if (index != lines.length - 1) spans.add(const TextSpan(text: '\n'));
  }
  return TextSpan(children: spans);
}

int _stringEnd(String source, int start, String quote) {
  var escaped = false;
  for (var index = start + 1; index < source.length; index++) {
    final char = source[index];
    if (!escaped && char == quote) return index + 1;
    if (!escaped && char == '\\') {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return source.length;
}

String _languageAlias(String language) => switch (language.toLowerCase()) {
  'js' || 'jsx' => 'javascript',
  'ts' || 'tsx' => 'typescript',
  'py' => 'python',
  'rb' => 'ruby',
  'sh' || 'bash' || 'zsh' => 'shell',
  'yml' => 'yaml',
  'patch' => 'diff',
  final value => value,
};

const _codeKeyword = TextStyle(
  color: Color(0xff8fd0f2),
  fontWeight: FontWeight.w600,
);
const _codeString = TextStyle(color: Color(0xff8bfbc2));
const _codeComment = TextStyle(
  color: Color(0xff8199aa),
  fontStyle: FontStyle.italic,
);
const _codeNumber = TextStyle(color: Color(0xfff9f871));
const _diffAdd = TextStyle(
  color: Color(0xff8bfbc2),
  backgroundColor: Color(0x1f8bfbc2),
);
const _diffDelete = TextStyle(
  color: Color(0xffff7a72),
  backgroundColor: Color(0x1fff7a72),
);
const _diffHeader = TextStyle(color: Color(0xff8fd0f2));

const _commonKeywords = <String>{
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'final',
  'for',
  'function',
  'if',
  'import',
  'in',
  'interface',
  'let',
  'new',
  'null',
  'return',
  'static',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'var',
  'void',
  'while',
  'yield',
};

const _keywords = <String, Set<String>>{
  'dart': _commonKeywords,
  'javascript': _commonKeywords,
  'typescript': {
    ..._commonKeywords,
    'implements',
    'namespace',
    'type',
    'unknown',
  },
  'java': {
    ..._commonKeywords,
    'package',
    'private',
    'protected',
    'public',
    'synchronized',
  },
  'kotlin': {..._commonKeywords, 'data', 'fun', 'object', 'override', 'val'},
  'swift': {..._commonKeywords, 'func', 'guard', 'protocol', 'struct'},
  'python': {
    'and',
    'as',
    'assert',
    'async',
    'await',
    'break',
    'class',
    'continue',
    'def',
    'del',
    'elif',
    'else',
    'except',
    'False',
    'finally',
    'for',
    'from',
    'global',
    'if',
    'import',
    'in',
    'is',
    'lambda',
    'None',
    'not',
    'or',
    'pass',
    'raise',
    'return',
    'True',
    'try',
    'while',
    'with',
    'yield',
  },
  'ruby': {
    'begin',
    'break',
    'case',
    'class',
    'def',
    'do',
    'else',
    'elsif',
    'end',
    'false',
    'if',
    'module',
    'nil',
    'redo',
    'rescue',
    'retry',
    'return',
    'self',
    'super',
    'then',
    'true',
    'unless',
    'until',
    'when',
    'while',
    'yield',
  },
  'shell': {
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'function',
    'if',
    'in',
    'then',
    'until',
    'while',
  },
  'sql': {
    'ALTER',
    'AND',
    'AS',
    'BY',
    'CREATE',
    'DELETE',
    'DROP',
    'FROM',
    'GROUP',
    'HAVING',
    'INSERT',
    'INTO',
    'JOIN',
    'LIMIT',
    'NOT',
    'NULL',
    'ON',
    'OR',
    'ORDER',
    'SELECT',
    'SET',
    'TABLE',
    'UPDATE',
    'VALUES',
    'WHERE',
  },
};
