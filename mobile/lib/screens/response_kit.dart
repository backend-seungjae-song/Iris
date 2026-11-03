import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/action_bar.dart';
import 'package:iris_remote/design/agent_tile.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/motion.dart';
import 'package:iris_remote/design/select_mark.dart';
import 'package:iris_remote/design/toast.dart';
import 'package:iris_remote/design/tokens.dart';

// 응답 화면 공용 부품. 승인·질문·사람 차례 화면이 같이 씀

String responseAgo(int timestamp) {
  final minutes = ((DateTime.now().millisecondsSinceEpoch - timestamp) / 60000)
      .round();
  if (minutes <= 0) return '방금';
  if (minutes < 60) return '$minutes분 전';
  if (minutes < 1440) return '${minutes ~/ 60}시간 전';
  return '${minutes ~/ 1440}일 전';
}

String responseKindName(String kind) => switch (kind) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'terminal' => '터미널',
  _ => kind.isEmpty ? '' : kind[0].toUpperCase() + kind.substring(1),
};

Future<void> responseCopy(BuildContext context, String text) async {
  await Clipboard.setData(ClipboardData(text: text));
  if (context.mounted) showIrisToast(context, '복사했습니다');
}

// 여러 요청 사이 이동. index 는 0부터
class ResponseNav {
  const ResponseNav({
    required this.index,
    required this.count,
    this.onPrev,
    this.onNext,
  });

  final int index;
  final int count;
  final VoidCallback? onPrev;
  final VoidCallback? onNext;
}

// 질문 단계 이동. 콜백이 null 이면 그 방향은 비활성
class ResponseStepNav {
  const ResponseStepNav({this.onPrev, this.onNext});

  final VoidCallback? onPrev;
  final VoidCallback? onNext;
}

// titledUpDown: 세션 제목 + 위아래 이동(명령), plainUpDown: "질문 1 / 3" + 위아래(파일 수정),
// titledNext: 세션 제목 + 다음 화살표(그 밖)
enum ResponseHeader { titledUpDown, plainUpDown, titledNext }

class ResponseFrame extends StatelessWidget {
  const ResponseFrame({
    required this.header,
    required this.title,
    required this.space,
    required this.agentKind,
    required this.children,
    required this.bar,
    this.nav,
    this.stepNav,
    this.onClose,
    this.stepLabel,
    this.bodyPadding = const EdgeInsets.fromLTRB(16, 4, 16, 28),
    super.key,
  });

  final ResponseHeader header;
  final String title;
  final String space;
  final String agentKind;
  final List<Widget> children;
  final Widget bar;
  final ResponseNav? nav;
  // 질문 이전·다음 이동. 단계 표시 오른쪽에 화살표 둘
  final ResponseStepNav? stepNav;
  final VoidCallback? onClose;
  // 질문 단계 표시("질문 2 / 3"). 있으면 요청 이동 카운터 대신 쓴다
  final String? stepLabel;
  final EdgeInsets bodyPadding;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final nav = this.nav;
    final counter =
        stepLabel ??
        (nav == null
            ? null
            : '${nav.index + 1}${header == ResponseHeader.titledNext ? '/' : ' / '}${nav.count}');
    return Scaffold(
      key: const Key('response-screen'),
      backgroundColor: colors.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            SizedBox(
              key: const Key('response-top'),
              height: 56,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6),
                child: Row(
                  children: [
                    _IconBtn(
                      key: const Key('response-close'),
                      icon: 'x',
                      size: 22,
                      label: '닫기',
                      onTap: onClose ?? () => Navigator.of(context).maybePop(),
                    ),
                    const SizedBox(width: 4),
                    if (header == ResponseHeader.plainUpDown) ...[
                      const SizedBox(width: 2),
                      Text(
                        '질문',
                        style: TextStyle(
                          color: colors.foreground2,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(width: 8),
                      if (counter != null)
                        Text(
                          counter,
                          key: const Key('response-pager'),
                          style: TextStyle(
                            color: colors.muted,
                            fontSize: 14,
                            fontWeight: FontWeight.w500,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      const Spacer(),
                    ] else
                      Expanded(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: colors.foreground,
                                  fontSize: 17,
                                  fontWeight: FontWeight.w600,
                                  height: 1.25,
                                  letterSpacing: -0.17,
                                ),
                              ),
                              _subtitle(context),
                            ],
                          ),
                        ),
                      ),
                    if (header != ResponseHeader.plainUpDown && counter != null)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 2),
                        child: Text(
                          counter,
                          key: const Key('response-pager'),
                          style: TextStyle(
                            color: colors.muted,
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                        ),
                      ),
                    if (stepNav != null) ...[
                      _IconBtn(
                        key: const Key('response-step-prev'),
                        icon: 'caret-left',
                        label: '이전 질문',
                        onTap: stepNav!.onPrev,
                      ),
                      _IconBtn(
                        key: const Key('response-step-next'),
                        icon: 'caret-right',
                        label: '다음 질문',
                        onTap: stepNav!.onNext,
                      ),
                    ],
                    if (nav != null && header != ResponseHeader.titledNext) ...[
                      _IconBtn(
                        key: const Key('response-prev'),
                        icon: 'caret-down',
                        flip: true,
                        label: '이전 요청',
                        onTap: nav.onPrev,
                      ),
                      _IconBtn(
                        key: const Key('response-next'),
                        icon: 'caret-down',
                        label: '다음 요청',
                        onTap: nav.onNext,
                      ),
                    ] else if (nav != null)
                      _IconBtn(
                        key: const Key('response-next'),
                        icon: 'caret-right',
                        label: '다음 요청',
                        onTap: nav.onNext,
                      ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: ListView(
                key: const Key('response-body'),
                physics: const ClampingScrollPhysics(),
                padding: bodyPadding,
                children: children,
              ),
            ),
            bar,
          ],
        ),
      ),
    );
  }

  Widget _subtitle(BuildContext context) {
    final colors = context.iris;
    final style = TextStyle(
      color: colors.muted,
      fontSize: header == ResponseHeader.titledUpDown ? 12.5 : 12,
      height: 1.3,
    );
    final kind = responseKindName(agentKind);
    if (header == ResponseHeader.titledUpDown) {
      return Row(
        children: [
          const IrisStatusDot(status: 'blocked', size: 8),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              '멈춤 · 답 필요 · $kind',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: style,
            ),
          ),
        ],
      );
    }
    return Row(
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: colors.sky,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            '$space · $kind',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
        ),
      ],
    );
  }
}

class _IconBtn extends StatelessWidget {
  const _IconBtn({
    required this.icon,
    required this.label,
    required this.onTap,
    this.size = 20,
    this.flip = false,
    super.key,
  });

  final String icon;
  final String label;
  final VoidCallback? onTap;
  final double size;
  final bool flip;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    Widget glyph = IrisIcon(
      icon,
      size: size,
      color: onTap == null
          ? colors.faint.withValues(alpha: 0.5)
          : colors.foreground2,
    );
    if (flip) glyph = Transform.rotate(angle: math.pi, child: glyph);
    return Semantics(
      button: true,
      enabled: onTap != null,
      label: label,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: SizedBox(width: 44, height: 44, child: Center(child: glyph)),
      ),
    );
  }
}

enum ResponseTone { approval, question, human }

// 종류 줄. 색 타일(30) + 이름 + 오른쪽 시간
class ResponseKindRow extends StatelessWidget {
  const ResponseKindRow({
    required this.label,
    required this.tone,
    required this.time,
    this.icon,
    this.glyph,
    super.key,
  });

  final String label;
  final ResponseTone tone;
  final String time;
  final String? icon;
  final String? glyph;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          _tile(colors, 30, 9),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: colors.foreground2,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Text(
            time,
            style: TextStyle(
              color: colors.muted,
              fontSize: 13,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _tile(IrisColors colors, double size, double radius) {
    final background = switch (tone) {
      ResponseTone.approval => colors.pink,
      ResponseTone.question => colors.yellow,
      ResponseTone.human => colors.lime,
    };
    return Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(radius),
      ),
      child: glyph != null
          ? Text(
              glyph!,
              style: TextStyle(
                color: colors.ink,
                fontSize: size * 0.56,
                fontWeight: FontWeight.w800,
                height: 1,
              ),
            )
          : IrisIcon(icon ?? 'check-circle', size: 17, color: colors.ink),
    );
  }
}

// 승인 화면의 누구·무엇 줄. 타일(36) + 이름 + 세션 정보 한 줄
class ResponseWhoRow extends StatelessWidget {
  const ResponseWhoRow({
    required this.name,
    required this.meta,
    required this.icon,
    super.key,
  });

  final String name;
  final String meta;
  final String icon;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Padding(
      padding: const EdgeInsets.fromLTRB(0, 6, 0, 14),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: colors.pink,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Center(child: IrisIcon(icon, size: 17, color: colors.ink)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.foreground,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    height: 1.3,
                  ),
                ),
                Text(
                  meta,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: colors.muted,
                    fontSize: 12.5,
                    height: 1.3,
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

class ResponseTitle extends StatelessWidget {
  const ResponseTitle(
    this.text, {
    this.approval = false,
    this.child,
    super.key,
  });

  final String text;
  // 승인 화면(명령·파일 수정) 간격과 자간
  final bool approval;
  // 글자 대신 쓸 위젯(마크다운 제목)
  final Widget Function(TextStyle style)? child;

  @override
  Widget build(BuildContext context) {
    final style = TextStyle(
      color: context.iris.foreground,
      fontSize: 22,
      fontWeight: FontWeight.w700,
      height: approval ? 1.35 : 1.38,
      letterSpacing: approval ? -0.44 : -0.33,
    );
    return Padding(
      padding: approval
          ? const EdgeInsets.only(top: 2, bottom: 4)
          : const EdgeInsets.only(top: 14, bottom: 8),
      child: child != null ? child!(style) : Text(text, style: style),
    );
  }
}

TextStyle responseLeadStyle(BuildContext context) =>
    TextStyle(color: context.iris.muted, fontSize: 14, height: 1.55);

class ResponseSectionLabel extends StatelessWidget {
  const ResponseSectionLabel(
    this.label, {
    this.trailing,
    this.inline = false,
    this.approval = false,
    super.key,
  });

  final String label;
  final Widget? trailing;
  // true 면 trailing 을 라벨 바로 옆에 둠
  final bool inline;
  final bool approval;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: approval
          ? const EdgeInsets.fromLTRB(0, 18, 0, 8)
          : const EdgeInsets.fromLTRB(0, 22, 0, 10),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              color: context.iris.muted,
              fontSize: approval ? 13 : 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (trailing != null) ...[
            if (inline) const SizedBox(width: 16) else const Spacer(),
            trailing!,
          ],
        ],
      ),
    );
  }
}

// 결정 목록 카드. approval 은 승인 화면 치수(반경 14, 최소 60, 표시 22)
class ResponseOption extends StatelessWidget {
  const ResponseOption({
    required this.title,
    required this.selected,
    required this.onTap,
    this.description = '',
    this.multi = false,
    this.negative = false,
    this.approval = false,
    this.recommended = false,
    this.previous = false,
    this.loading = false,
    this.extra,
    super.key,
  });

  final String title;
  // 추천 배지, 이전 선택 배지
  final bool recommended;
  final bool previous;
  final String description;
  final bool selected;
  final VoidCallback? onTap;
  final bool multi;
  final bool negative;
  final bool approval;
  // 체크 표시를 전송 중 표시로 바꿈
  final bool loading;
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final radius = BorderRadius.circular(approval ? 14 : 12);
    final accent = negative ? colors.dangerText : colors.link;
    final background = selected
        ? (negative ? colors.dangerTint : colors.tint2)
        : colors.level1;
    return Semantics(
      inMutuallyExclusiveGroup: !multi,
      checked: selected,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: irisEase,
          constraints: BoxConstraints(minHeight: approval ? 60 : 52),
          padding: EdgeInsets.symmetric(
            horizontal: 14,
            vertical: approval ? 12 : 13,
          ),
          decoration: BoxDecoration(color: background, borderRadius: radius),
          foregroundDecoration: BoxDecoration(
            borderRadius: radius,
            border: Border.all(
              color: selected ? accent : colors.line2,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: IrisSelectMark(
                  selected: selected,
                  square: multi,
                  size: approval ? 22 : 20,
                  color: negative ? colors.dangerText : null,
                  loading: loading,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text.rich(
                      TextSpan(
                        children: [
                          TextSpan(text: title),
                          if (recommended) ...[
                            const TextSpan(text: '  '),
                            WidgetSpan(
                              alignment: PlaceholderAlignment.middle,
                              child: ResponseBadge(
                                '추천',
                                key: const Key('option-badge-recommended'),
                              ),
                            ),
                          ],
                          if (previous) ...[
                            const TextSpan(text: '  '),
                            WidgetSpan(
                              alignment: PlaceholderAlignment.middle,
                              child: ResponseBadge(
                                '이전 선택',
                                muted: true,
                                key: const Key('option-badge-previous'),
                              ),
                            ),
                          ],
                        ],
                      ),
                      style: TextStyle(
                        color: negative ? colors.dangerText : colors.foreground,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        height: 1.35,
                      ),
                    ),
                    if (description.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          description,
                          style: TextStyle(
                            color: colors.muted,
                            fontSize: 13,
                            height: 1.45,
                          ),
                        ),
                      ),
                    if (extra != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 10),
                        child: extra,
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
}

// 선택지 옆 작은 배지. muted 는 이전 선택, 아니면 추천
class ResponseBadge extends StatelessWidget {
  const ResponseBadge(this.text, {this.muted = false, super.key});

  final String text;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final color = muted ? colors.muted : colors.link;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
      decoration: BoxDecoration(
        color: muted ? Colors.transparent : colors.tint2,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: muted ? colors.line2 : color, width: 1),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          height: 1.3,
        ),
      ),
    );
  }
}

// 명령·입력 값 상자. 오른쪽 위 복사 버튼
class ResponseCodeBox extends StatelessWidget {
  const ResponseCodeBox({
    required this.text,
    this.prompt = r'$',
    this.fontSize = 15,
    super.key,
  });

  final String text;
  final String? prompt;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final style = IrisType.mono.copyWith(
      color: colors.foreground,
      fontSize: fontSize,
      fontWeight: FontWeight.w500,
      height: 1.5,
    );
    return Container(
      margin: const EdgeInsets.only(top: 10, bottom: 6),
      decoration: BoxDecoration(
        color: colors.level2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.separator),
      ),
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 14, 52, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (prompt != null) ...[
                  Text(prompt!, style: style.copyWith(color: colors.faint)),
                  const SizedBox(width: 8),
                ],
                // 승인 전에 끝까지 확인하도록 줄 수를 제한하지 않음
                Expanded(child: Text(text, style: style)),
              ],
            ),
          ),
          Positioned(
            right: 2,
            top: 2,
            child: _IconBtn(
              key: const Key('response-copy'),
              icon: 'copy',
              size: 16,
              label: '복사',
              onTap: () => responseCopy(context, text),
            ),
          ),
        ],
      ),
    );
  }
}

// 설명·작업 폴더 같은 맥락 줄
class ResponseContextRow extends StatelessWidget {
  const ResponseContextRow({
    required this.icon,
    required this.label,
    required this.value,
    this.first = false,
    this.mono = false,
    super.key,
  });

  final String icon;
  final String label;
  final String value;
  final bool first;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: first ? null : Border(top: BorderSide(color: colors.separator)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 1),
            child: IrisIcon(icon, size: 16, color: colors.muted),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 62,
            child: Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Text(
                label,
                style: TextStyle(color: colors.muted, fontSize: 13),
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: (mono ? IrisType.mono : const TextStyle()).copyWith(
                color: colors.foreground,
                fontSize: mono ? 13.5 : 14,
                height: 1.45,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// 서버·도구·입력 표
class ResponseFacts extends StatelessWidget {
  const ResponseFacts(this.rows, {super.key});

  final List<(String, String)> rows;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      margin: const EdgeInsets.only(top: 14),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.line2),
      ),
      child: Table(
        columnWidths: const {0: IntrinsicColumnWidth(), 1: FlexColumnWidth()},
        border: TableBorder(
          horizontalInside: BorderSide(color: colors.separator),
        ),
        children: [
          for (final (key, value) in rows)
            TableRow(
              children: [
                Container(
                  color: colors.level2,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 11,
                  ),
                  child: Text(
                    key,
                    style: TextStyle(color: colors.muted, fontSize: 13),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 11,
                  ),
                  child: Text(
                    value,
                    style: IrisType.mono.copyWith(
                      color: colors.foreground,
                      fontSize: 13,
                      height: 1.5,
                    ),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

// 변경(diff) 색은 1차 시안 dir-2 값
class _DiffColors {
  const _DiffColors(this.addBg, this.addInk, this.delBg, this.delInk);

  final Color addBg;
  final Color addInk;
  final Color delBg;
  final Color delInk;

  static const dark = _DiffColors(
    Color.fromRGBO(76, 195, 138, .13),
    Color(0xff7ddcac),
    Color.fromRGBO(255, 112, 112, .12),
    Color(0xffff9d9d),
  );
  static const light = _DiffColors(
    Color(0xffe1f4e9),
    Color(0xff136b40),
    Color(0xfffbe5e5),
    Color(0xffa82222),
  );
}

class DiffLine {
  const DiffLine(this.kind, this.text, [this.number]);

  // h 구간 머리, a 추가, d 삭제, c 그대로
  final String kind;
  final String text;
  final int? number;
}

class ParsedDiff {
  const ParsedDiff(this.lines, this.path, this.added, this.removed);

  final List<DiffLine> lines;
  final String? path;
  final int added;
  final int removed;
}

// 추가·삭제 줄이 하나도 없으면 null. 입력 형식이 diff 가 아닌 경우
ParsedDiff? parseDiff(String input) {
  final lines = <DiffLine>[];
  String? path;
  var added = 0, removed = 0;
  int? oldNo, newNo;
  for (final raw in input.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw.substring(4).replaceFirst(RegExp(r'^b/'), '').trim();
      continue;
    }
    if (raw.startsWith('--- ') ||
        raw.startsWith('diff ') ||
        raw.startsWith('index ')) {
      continue;
    }
    if (raw.startsWith('@@')) {
      final match = RegExp(r'@@ -(\d+)(?:,\d+)? \+(\d+)').firstMatch(raw);
      oldNo = match == null ? null : int.parse(match.group(1)!);
      newNo = match == null ? null : int.parse(match.group(2)!);
      lines.add(DiffLine('h', raw));
    } else if (raw.startsWith('+')) {
      added++;
      lines.add(DiffLine('a', raw.substring(1), newNo));
      newNo = newNo == null ? null : newNo + 1;
    } else if (raw.startsWith('-')) {
      removed++;
      lines.add(DiffLine('d', raw.substring(1), oldNo));
      oldNo = oldNo == null ? null : oldNo + 1;
    } else {
      lines.add(
        DiffLine('c', raw.startsWith(' ') ? raw.substring(1) : raw, newNo),
      );
      newNo = newNo == null ? null : newNo + 1;
      oldNo = oldNo == null ? null : oldNo + 1;
    }
  }
  if (added + removed == 0) return null;
  return ParsedDiff(lines, path, added, removed);
}

class ResponseDiff extends StatefulWidget {
  const ResponseDiff(this.diff, {this.fallbackName = '', super.key});

  final ParsedDiff diff;
  final String fallbackName;

  static const collapsedLines = 9;

  @override
  State<ResponseDiff> createState() => _ResponseDiffState();
}

class _ResponseDiffState extends State<ResponseDiff> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final palette = Theme.of(context).brightness == Brightness.dark
        ? _DiffColors.dark
        : _DiffColors.light;
    final diff = widget.diff;
    final path = diff.path ?? widget.fallbackName;
    final slash = path.lastIndexOf('/');
    final name = slash < 0 ? path : path.substring(slash + 1);
    final dir = slash < 0 ? '' : path.substring(0, slash + 1);
    final hidden = diff.lines.length - ResponseDiff.collapsedLines;
    final shown = _open || hidden <= 0
        ? diff.lines
        : diff.lines.take(ResponseDiff.collapsedLines).toList();
    return Container(
      key: const Key('response-diff'),
      margin: const EdgeInsets.only(top: 10, bottom: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: colors.level2,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.separator),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: colors.separator)),
            ),
            child: Row(
              children: [
                IrisIcon('file-text', size: 16, color: colors.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        style: IrisType.mono.copyWith(
                          color: colors.foreground,
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          height: 1.3,
                        ),
                      ),
                      if (dir.isNotEmpty)
                        Text(
                          dir,
                          style: IrisType.mono.copyWith(
                            color: colors.muted,
                            fontSize: 12,
                            height: 1.3,
                          ),
                        ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '+${diff.added}',
                  style: TextStyle(
                    color: palette.addInk,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  '−${diff.removed}',
                  style: TextStyle(
                    color: palette.delInk,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          for (final line in shown) _line(colors, palette, line),
          if (hidden > 0)
            GestureDetector(
              key: const Key('response-diff-more'),
              onTap: () => setState(() => _open = !_open),
              behavior: HitTestBehavior.opaque,
              child: Container(
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                alignment: Alignment.centerLeft,
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: colors.separator)),
                ),
                child: Row(
                  children: [
                    Transform.rotate(
                      angle: _open ? math.pi : 0,
                      child: IrisIcon(
                        'caret-down',
                        size: 14,
                        color: colors.link,
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      _open ? '접기' : '나머지 변경 $hidden줄 보기',
                      style: TextStyle(
                        color: colors.link,
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _line(IrisColors colors, _DiffColors palette, DiffLine line) {
    if (line.kind == 'h') {
      return Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
        color: colors.tint,
        child: Text(
          line.text,
          style: IrisType.mono.copyWith(
            color: colors.muted,
            fontSize: 12,
            height: 1.3,
          ),
        ),
      );
    }
    final add = line.kind == 'a';
    final del = line.kind == 'd';
    final ink = add
        ? palette.addInk
        : (del ? palette.delInk : colors.foreground2);
    final mono = IrisType.mono.copyWith(fontSize: 12.5, height: 20 / 12.5);
    return Container(
      color: add ? palette.addBg : (del ? palette.delBg : null),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 34,
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Text(
                line.number?.toString() ?? '',
                textAlign: TextAlign.right,
                style: mono.copyWith(color: colors.muted, fontSize: 11.5),
              ),
            ),
          ),
          SizedBox(
            width: 14,
            child: Text(
              add ? '+' : (del ? '−' : ''),
              textAlign: TextAlign.center,
              style: mono.copyWith(color: ink, fontWeight: FontWeight.w600),
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 8),
              // 긴 줄은 줄바꿈으로 끝까지 표시
              child: Text(line.text, style: mono.copyWith(color: ink)),
            ),
          ),
        ],
      ),
    );
  }
}

// 닫힌 요청의 제목과 설명. 답한 것이 확인된 경우만 "이미 답했습니다"
(String, String) responseGoneText(String gone) => switch (gone) {
  'expired' || 'gone-expired' => ('요청이 만료됐습니다', '에이전트가 더 기다리지 않습니다'),
  'already-answered' => ('이미 답했습니다', '다른 곳에서 먼저 답해 요청이 닫혔습니다'),
  _ => ('요청이 끝났습니다', '답했거나 취소되어 목록에서 사라졌습니다'),
};

String responseGoneBadge(String gone) =>
    gone == 'already-answered' ? '답함' : '종료';

// 닫힌 요청 화면. 다른 곳에서 먼저 답했거나 만료된 경우
class ResponseAnswered extends StatelessWidget {
  const ResponseAnswered({
    required this.title,
    required this.detail,
    required this.ghost,
    required this.kindLabel,
    required this.kindIcon,
    this.kindTone = ResponseTone.approval,
    this.kindGlyph,
    this.badge = '답함',
    super.key,
  });

  final String title;
  final String detail;
  // 원본 카드 오른쪽 위 표시. 답한 것이 확인되지 않은 종료는 '종료'
  final String badge;
  final Widget ghost;
  final String kindLabel;
  final String kindIcon;
  final ResponseTone kindTone;
  final String? kindGlyph;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return IrisFadeIn(
      child: Padding(
        padding: const EdgeInsets.only(top: 32),
        child: Column(
          children: [
            Container(
              width: 60,
              height: 60,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: colors.tint2,
                border: Border.all(color: colors.link, width: 1.5),
              ),
              child: Center(
                child: IrisIcon('monitor', size: 28, color: colors.link),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: colors.foreground,
                fontSize: 20,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              detail,
              textAlign: TextAlign.center,
              style: TextStyle(color: colors.muted, fontSize: 14),
            ),
            const SizedBox(height: 28),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: colors.separator),
              ),
              child: Stack(
                children: [
                  Opacity(
                    opacity: 0.6,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            _ghostTile(colors),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                kindLabel,
                                style: TextStyle(
                                  color: colors.foreground2,
                                  fontSize: 13,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                            const SizedBox(width: 56),
                          ],
                        ),
                        const SizedBox(height: 10),
                        ghost,
                      ],
                    ),
                  ),
                  Positioned(
                    right: 0,
                    top: 0,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: colors.level2,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        badge,
                        style: TextStyle(
                          color: colors.foreground2,
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _ghostTile(IrisColors colors) {
    final background = switch (kindTone) {
      ResponseTone.approval => colors.pink,
      ResponseTone.question => colors.yellow,
      ResponseTone.human => colors.lime,
    };
    return Container(
      width: 30,
      height: 30,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(9),
      ),
      child: kindGlyph != null
          ? Text(
              kindGlyph!,
              style: TextStyle(
                color: colors.ink,
                fontSize: 17,
                fontWeight: FontWeight.w800,
                height: 1,
              ),
            )
          : IrisIcon(kindIcon, size: 17, color: colors.ink),
    );
  }
}

// 답한 요청 화면 아래 막대. 홈으로 + 다음 요청
Widget responseAnsweredBar({
  required VoidCallback onHome,
  required int remaining,
  required VoidCallback? onNext,
}) => IrisActionBar(
  buttons: [
    IrisButton(
      key: const Key('response-home'),
      label: '홈으로',
      tone: remaining > 0 ? IrisButtonTone.ghost : IrisButtonTone.primary,
      onPressed: onHome,
    ),
    if (remaining > 0)
      IrisButton(
        key: const Key('response-next-request'),
        label: '다음 요청 · $remaining개 남음',
        tone: IrisButtonTone.primary,
        onPressed: onNext,
      ),
  ],
);

// 질문 진행 막대. 지난 칸 .55 농도, 현재 칸 진하게
class ResponseProgress extends StatelessWidget {
  const ResponseProgress({
    required this.count,
    required this.current,
    this.allDone = false,
    super.key,
  });

  final int count;
  final int current;
  final bool allDone;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Padding(
      padding: const EdgeInsets.only(top: 14),
      child: Row(
        children: [
          for (var i = 0; i < count; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            Expanded(
              child: AnimatedContainer(
                duration: irisSwapDuration,
                curve: irisEase,
                height: 4,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(4),
                  color: allDone || i < current
                      ? colors.link.withValues(alpha: 0.55)
                      : (i == current ? colors.link : colors.level3),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// 답한 질문·남은 질문 카드. todo 는 아직 답하지 않은 질문
class ResponseAnswerCard extends StatelessWidget {
  const ResponseAnswerCard({
    required this.question,
    required this.answer,
    this.number,
    this.todo = false,
    this.onEdit,
    super.key,
  });

  final String question;
  final String answer;
  final int? number;
  final bool todo;
  final VoidCallback? onEdit;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(14, 10, 6, 10),
      decoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.separator),
      ),
      child: Row(
        children: [
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: todo ? colors.level3 : colors.link,
            ),
            child: todo
                ? Text(
                    '$number',
                    style: TextStyle(
                      color: colors.foreground2,
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                    ),
                  )
                : IrisIcon('check', size: 12, color: colors.background),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  question,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: colors.muted, fontSize: 12),
                ),
                Text(
                  answer,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: todo ? colors.muted : colors.foreground,
                    fontSize: 14,
                    fontWeight: todo ? FontWeight.w500 : FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          if (onEdit != null)
            GestureDetector(
              onTap: onEdit,
              behavior: HitTestBehavior.opaque,
              child: Container(
                constraints: const BoxConstraints(minHeight: 44),
                padding: const EdgeInsets.symmetric(horizontal: 12),
                alignment: Alignment.center,
                child: Text(
                  '수정',
                  style: TextStyle(
                    color: colors.link,
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

// 답한 화면의 흐린 원본 내용 상자
Widget responseGhostCode(BuildContext context, String text, {String? prompt}) {
  final colors = context.iris;
  final style = IrisType.mono.copyWith(color: colors.foreground2);
  return Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
    decoration: BoxDecoration(
      color: colors.level2,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: colors.separator),
    ),
    child: Text(
      prompt == null ? text : '$prompt $text',
      maxLines: 3,
      overflow: TextOverflow.ellipsis,
      style: style,
    ),
  );
}
