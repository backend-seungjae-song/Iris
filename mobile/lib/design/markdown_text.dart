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

// 변경 줄 색. 1차 시안(dir-3)의 진한 글자 + 줄 배경
class IrisDiffColors {
  const IrisDiffColors({
    required this.add,
    required this.addBg,
    required this.del,
    required this.delBg,
  });

  final Color add;
  final Color addBg;
  final Color del;
  final Color delBg;

  static const dark = IrisDiffColors(
    add: Color(0xff86D7A2),
    addBg: Color.fromRGBO(84, 190, 120, .14),
    del: Color(0xffF3A3A3),
    delBg: Color.fromRGBO(230, 100, 100, .14),
  );
  static const light = IrisDiffColors(
    add: Color(0xff156B37),
    addBg: Color.fromRGBO(30, 140, 70, .11),
    del: Color(0xffAE2020),
    delBg: Color.fromRGBO(200, 40, 40, .09),
  );

  static IrisDiffColors forBrightness(Brightness brightness) =>
      brightness == Brightness.dark ? dark : light;

  static IrisDiffColors of(BuildContext context) =>
      forBrightness(Theme.of(context).brightness);
}

// 표 칸 안의 +N / −N 표시용 임시 문자. 표 줄에만 붙인다
const _diffMark = '';

String _markDiffCounts(String data) {
  if (!data.contains('|')) return data;
  final token = RegExp(r'(?<=^|[\s|])([+−-])(\d+)(?=$|[\s|])');
  return data
      .split('\n')
      .map(
        (line) => line.trimLeft().startsWith('|')
            ? line.replaceAllMapped(
                token,
                (m) => '$_diffMark${m.group(1)}${m.group(2)}',
              )
            : line,
      )
      .join('\n');
}

class _DiffCountSyntax extends md.InlineSyntax {
  _DiffCountSyntax() : super('$_diffMark([+−-])(\\d+)');

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    final tag = match.group(1) == '+' ? 'diffadd' : 'diffdel';
    parser.addNode(md.Element.text(tag, '${match.group(1)}${match.group(2)}'));
    return true;
  }
}

class _DiffCountBuilder extends MarkdownElementBuilder {
  _DiffCountBuilder(this.added);

  final bool added;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final colors = context.iris;
    return Text(
      element.textContent.replaceFirst('-', '−'),
      style: (parentStyle ?? preferredStyle)?.copyWith(
        color: added ? colors.okText : colors.dangerText,
        fontWeight: FontWeight.w600,
      ),
    );
  }
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
    final size = body.fontSize ?? 17;
    final blockSpacing = compact ? 5.0 : 8.0;
    final line = BorderSide(color: colors.separator);
    return MarkdownBody(
      data: _markDiffCounts(data),
      selectable: selectable,
      fitContent: false,
      softLineBreak: true,
      inlineSyntaxes: [_DiffCountSyntax()],
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
          fontSize: compact ? 20 : size + 5,
          height: 1.25,
          fontWeight: FontWeight.w700,
        ),
        h2: body.copyWith(
          fontSize: compact ? 18 : size + 3,
          height: 1.3,
          fontWeight: FontWeight.w700,
        ),
        h3: body.copyWith(
          fontSize: compact ? 17 : size + 1,
          height: 1.35,
          fontWeight: compact ? FontWeight.w700 : FontWeight.w600,
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
        listIndent: 20,
        listBullet: body.copyWith(color: colors.muted),
        listBulletPadding: const EdgeInsets.only(right: 6),
        blockquote: body.copyWith(color: colors.foreground2),
        blockquotePadding: const EdgeInsets.fromLTRB(12, 7, 10, 7),
        blockquoteDecoration: BoxDecoration(
          color: colors.level1,
          border: Border(left: BorderSide(color: colors.brand, width: 3)),
          borderRadius: BorderRadius.circular(8),
        ),
        code: body.copyWith(
          color: colors.foreground,
          backgroundColor: colors.level2,
          fontFamily: 'monospace',
          fontSize: size * 0.88,
          height: 1.4,
        ),
        tableHead: body.copyWith(
          color: colors.muted,
          fontSize: size * 0.8,
          fontWeight: FontWeight.w600,
        ),
        tableBody: body.copyWith(fontSize: size * 0.87),
        tableHeadAlign: TextAlign.left,
        tablePadding: EdgeInsets.only(bottom: blockSpacing),
        tableBorder: TableBorder(
          top: line,
          bottom: line,
          left: line,
          right: line,
          horizontalInside: line,
          borderRadius: BorderRadius.circular(IrisRadius.field),
        ),
        tableColumnWidth: const IntrinsicColumnWidth(),
        tableScrollbarThumbVisibility: true,
        tableCellsPadding: const EdgeInsets.symmetric(
          horizontal: 10,
          vertical: 8,
        ),
        tableHeadCellsDecoration: BoxDecoration(color: colors.level2),
        horizontalRuleDecoration: BoxDecoration(border: Border(top: line)),
      ),
      builders: {
        'pre': _CodeBlockBuilder(),
        'diffadd': _DiffCountBuilder(true),
        'diffdel': _DiffCountBuilder(false),
      },
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

// 코드 칸 바탕. 다크는 터미널 바탕색, 라이트는 앱 바탕색
Color _codeSurface(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark
    ? context.iris.terminal
    : context.iris.background;

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.code, required this.language});

  final String code;
  final String language;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final shownLanguage = language.isEmpty ? 'code' : language;
    return Container(
      key: Key('markdown-code-$shownLanguage'),
      width: double.infinity,
      decoration: BoxDecoration(
        color: _codeSurface(context),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.line2),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            height: 36,
            padding: const EdgeInsets.only(left: 12, right: 4),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: colors.separator)),
            ),
            child: Row(
              children: [
                Text(
                  shownLanguage,
                  style: TextStyle(
                    color: colors.muted,
                    fontFamily: 'monospace',
                    fontSize: 12,
                  ),
                ),
                const Spacer(),
                IconButton(
                  key: const Key('markdown-code-copy'),
                  tooltip: '코드 복사',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints.tightFor(
                    width: 36,
                    height: 36,
                  ),
                  onPressed: () => Clipboard.setData(ClipboardData(text: code)),
                  icon: IrisIcon('copy', size: 16, color: colors.muted),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            key: const Key('markdown-code-scroll'),
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: SelectableText.rich(
              highlightCode(
                code,
                language,
                brightness: Theme.of(context).brightness,
              ),
              key: const Key('markdown-code-text'),
              textScaler: MediaQuery.textScalerOf(context),
              style: TextStyle(
                color: colors.foreground2,
                fontFamily: 'monospace',
                fontSize: 12.5,
                height: 1.6,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _CodeStyles {
  _CodeStyles(Brightness brightness)
    : colors = brightness == Brightness.dark
          ? IrisColors.dark
          : IrisColors.light,
      diff = IrisDiffColors.forBrightness(brightness);

  final IrisColors colors;
  final IrisDiffColors diff;

  TextStyle get keyword =>
      TextStyle(color: colors.termBlue, fontWeight: FontWeight.w600);
  TextStyle get string => TextStyle(color: colors.termGreen);
  TextStyle get comment =>
      TextStyle(color: colors.muted, fontStyle: FontStyle.italic);
  TextStyle get number => TextStyle(color: colors.termYellow);
  TextStyle get diffAdd =>
      TextStyle(color: diff.add, backgroundColor: diff.addBg);
  TextStyle get diffDelete =>
      TextStyle(color: diff.del, backgroundColor: diff.delBg);
  TextStyle get diffHeader => TextStyle(color: colors.termBlue);
}

@visibleForTesting
TextSpan highlightCode(
  String source,
  String language, {
  Brightness brightness = Brightness.dark,
}) {
  final styles = _CodeStyles(brightness);
  final normalized = _languageAlias(language);
  if (normalized == 'diff') return _highlightDiff(source, styles);
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
        TextSpan(text: source.substring(index, stop), style: styles.comment),
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
        TextSpan(text: source.substring(index, stop), style: styles.comment),
      );
      index = stop;
      continue;
    }
    final char = source[index];
    if (char == '"' || char == "'" || char == '`') {
      final stop = _stringEnd(source, index, char);
      spans.add(
        TextSpan(text: source.substring(index, stop), style: styles.string),
      );
      index = stop;
      continue;
    }
    final number = RegExp(r'^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)')
        .firstMatch(source.substring(index));
    if (number != null) {
      final value = number.group(0)!;
      spans.add(TextSpan(text: value, style: styles.number));
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
          style: keywords.contains(value) ? styles.keyword : null,
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

TextSpan _highlightDiff(String source, _CodeStyles styles) {
  final spans = <TextSpan>[];
  final lines = source.split('\n');
  for (var index = 0; index < lines.length; index++) {
    final line = lines[index];
    final style = line.startsWith('+') && !line.startsWith('+++')
        ? styles.diffAdd
        : line.startsWith('-') && !line.startsWith('---')
        ? styles.diffDelete
        : line.startsWith('@@')
        ? styles.diffHeader
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
