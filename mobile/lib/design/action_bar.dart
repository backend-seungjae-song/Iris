import 'package:flutter/material.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/tokens.dart';

// 하단 고정 동작 막대 .foot. 모든 화면 공통
// buttons 는 1~2개. primary 톤이 있으면 그 버튼이 남는 폭을 차지하고 나머지는 내용 폭
class IrisActionBar extends StatelessWidget {
  const IrisActionBar({required this.buttons, this.safeArea = true, super.key})
    : assert(buttons.length >= 1 && buttons.length <= 2);

  final List<IrisButton> buttons;
  // 하단 시스템 영역(제스처 막대) 높이를 아래 패딩에 더함. 이미 SafeArea 안이면 false
  final bool safeArea;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final anyPrimary = buttons.any((b) => b.tone == IrisButtonTone.primary);
    final children = <Widget>[];
    for (final (index, button) in buttons.indexed) {
      if (index > 0) children.add(const SizedBox(width: 8));
      final grows = anyPrimary ? button.tone == IrisButtonTone.primary : true;
      // 버튼 키를 본체에 유지, 테스트·접근성 탐색용
      final body = KeyedSubtree(key: button.key, child: button.body(context));
      children.add(grows ? Expanded(child: body) : body);
    }
    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.background,
        border: Border(top: BorderSide(color: colors.separator)),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          16,
          12,
          16,
          10 + (safeArea ? MediaQuery.paddingOf(context).bottom : 0),
        ),
        child: Row(children: children),
      ),
    );
  }
}
