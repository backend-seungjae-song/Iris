import 'package:flutter/material.dart';
import 'package:iris_remote/design/icon.dart';
import 'package:iris_remote/design/tokens.dart';
import 'package:iris_remote/remote/protocol.dart';

class BrowserGroup {
  const BrowserGroup(this.space, this.name, this.tabs, {this.agent});
  final BrowserSpace space;
  final RemoteAgent? agent;
  final String name;
  final List<BrowserTab> tabs;
}

class BrowserTabGroup {
  const BrowserTabGroup(
    this.name,
    this.tabs, {
    this.ref,
    this.collapsed = false,
    this.color,
  });
  final String? ref;
  final String name;
  final List<BrowserTab> tabs;
  final bool collapsed;
  final String? color;
}

List<BrowserTabGroup> browserTabGroups(
  BrowserTab tab,
  List<BrowserTab> tabs,
  List<BrowserTabGroupInfo> groups,
) {
  final local = tabs.where((item) => item.space == tab.space).toList();
  final result = <BrowserTabGroup>[];
  for (final group in groups.where((item) => item.space == tab.space)) {
    final owned = local.where((item) => item.group == group.ref).toList();
    if (owned.isNotEmpty) {
      result.add(
        BrowserTabGroup(
          group.name,
          owned,
          ref: group.ref,
          collapsed: group.collapsed,
          color: group.color,
        ),
      );
    }
  }
  final grouped = result
      .expand((item) => item.tabs)
      .map((item) => item.ref)
      .toSet();
  final rest = local.where((item) => !grouped.contains(item.ref)).toList();
  if (rest.isNotEmpty) result.add(BrowserTabGroup('그룹 없음', rest));
  return result;
}

List<BrowserGroup> browserGroups(
  List<BrowserSpace> spaces,
  List<BrowserTab> tabs,
  List<RemoteAgent> agents,
) {
  final ordered = [...spaces];
  int order(BrowserSpace space) =>
      agents
          .where((agent) => agent.spaceRef == space.ref)
          .firstOrNull
          ?.spaceOrder ??
      0x7fffffff;
  ordered.sort((a, b) => order(a).compareTo(order(b)));
  final result = <BrowserGroup>[];
  for (final space in ordered) {
    final local = tabs.where((tab) => tab.space == space.ref).toList();
    final sessions =
        agents
            .where(
              (agent) =>
                  agent.spaceRef == space.ref && agent.kind != 'terminal',
            )
            .toList()
          ..sort((a, b) => a.sessionOrder.compareTo(b.sessionOrder));
    final assigned = <String>{};
    for (final agent in sessions) {
      final owned = local
          .where((tab) => tab.sessions.contains(agent.ref))
          .toList();
      if (owned.isEmpty) continue;
      assigned.addAll(owned.map((tab) => tab.ref));
      result.add(BrowserGroup(space, agent.name, owned, agent: agent));
    }
    final user = local.where((tab) => !assigned.contains(tab.ref)).toList();
    if (user.isNotEmpty) result.add(BrowserGroup(space, '사용자 탭', user));
  }
  return result;
}

Color? browserGroupColor(String? value) {
  if (value == null) return null;
  final hex = value.replaceFirst('#', '');
  if (RegExp(r'^[0-9a-fA-F]{3}$').hasMatch(hex)) {
    return Color(
      int.parse(
        'ff${hex.split('').map((item) => '$item$item').join()}',
        radix: 16,
      ),
    );
  }
  if (RegExp(r'^[0-9a-fA-F]{6}$').hasMatch(hex)) {
    return Color(int.parse('ff$hex', radix: 16));
  }
  return const {
    'red': Colors.red,
    'blue': Colors.blue,
    'green': Colors.green,
    'orange': Colors.orange,
    'purple': Colors.purple,
    'pink': Colors.pink,
    'yellow': Colors.yellow,
    'gray': Colors.grey,
  }[value.toLowerCase()];
}

// 브라우저 시안 반경, --r-ctl 12 와 --r-card 16
const browserControlRadius = 12.0;
const browserCardRadius = 16.0;

// 선택 표시색, 시안 --sel. 다크는 brand, 라이트는 link
Color irisSelectionColor(BuildContext context) =>
    Theme.of(context).brightness == Brightness.dark
    ? context.iris.brand
    : context.iris.link;

// 맨 위 가로 탭 줄. 그룹 칩, 탭 칩, 새 탭 칩 순서로 한 줄 스크롤
class BrowserTabStrip extends StatelessWidget {
  const BrowserTabStrip({
    required this.groups,
    required this.collapsed,
    required this.selectedRef,
    required this.onSelect,
    required this.onToggleGroup,
    this.onNewTab,
    super.key,
  });

  final List<BrowserTabGroup> groups;
  final Set<String> collapsed;
  final String selectedRef;
  final ValueChanged<BrowserTab> onSelect;
  final ValueChanged<String> onToggleGroup;
  final VoidCallback? onNewTab;

  @override
  Widget build(BuildContext context) {
    final items = <Widget>[
      for (final group in groups) ...[
        _GroupChip(
          group: group,
          collapsed: group.ref != null && collapsed.contains(group.ref),
          onPressed: group.ref == null ? null : () => onToggleGroup(group.ref!),
        ),
        if (group.ref == null || !collapsed.contains(group.ref))
          for (final item in group.tabs)
            _TabChip(
              key: Key('session-browser-tab-${item.ref}'),
              tab: item,
              selected: item.ref == selectedRef,
              onPressed: () => onSelect(item),
            ),
      ],
      if (onNewTab != null) _NewTabChip(onPressed: onNewTab!),
    ];
    return SizedBox(
      key: const Key('session-tabs'),
      height: 52,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        itemCount: items.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (_, index) => items[index],
      ),
    );
  }
}

// 칩 바탕. 높이 36, 알약, 선택되면 선택색 테두리 1.5
class _Chip extends StatelessWidget {
  const _Chip({
    required this.child,
    required this.onPressed,
    this.selected = false,
    this.padding = const EdgeInsets.symmetric(horizontal: 12),
  });

  final Widget child;
  final VoidCallback? onPressed;
  final bool selected;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final selection = irisSelectionColor(context);
    return Semantics(
      button: true,
      selected: selected,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onPressed,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: irisEase,
          height: 36,
          padding: padding,
          decoration: BoxDecoration(
            color: selected ? colors.tint2 : colors.level2,
            borderRadius: BorderRadius.circular(IrisRadius.pill),
          ),
          foregroundDecoration: BoxDecoration(
            borderRadius: BorderRadius.circular(IrisRadius.pill),
            border: Border.all(
              color: selected ? selection : colors.separator,
              width: selected ? 1.5 : 1,
            ),
          ),
          child: DefaultTextStyle.merge(
            style: TextStyle(
              fontSize: 13,
              height: 16 / 13,
              fontWeight: FontWeight.w500,
              color: selected ? colors.foreground : colors.foreground2,
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [child]),
          ),
        ),
      ),
    );
  }
}

class _GroupChip extends StatelessWidget {
  const _GroupChip({
    required this.group,
    required this.collapsed,
    required this.onPressed,
  });

  final BrowserTabGroup group;
  final bool collapsed;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final color = browserGroupColor(group.color) ?? context.iris.muted;
    return _Chip(
      onPressed: onPressed,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: color,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 120),
            child: Text(
              group.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (group.ref != null) ...[
            const SizedBox(width: 4),
            IrisIcon(
              collapsed ? 'caret-right' : 'caret-down',
              size: 12,
              color: context.iris.muted,
            ),
          ],
        ],
      ),
    );
  }
}

class _TabChip extends StatelessWidget {
  const _TabChip({
    required this.tab,
    required this.selected,
    required this.onPressed,
    super.key,
  });

  final BrowserTab tab;
  final bool selected;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = context.iris;
    final host = Uri.tryParse(tab.url)?.host ?? '';
    final source = tab.title.isNotEmpty ? tab.title : host;
    return _Chip(
      selected: selected,
      onPressed: onPressed,
      padding: const EdgeInsets.fromLTRB(7, 0, 12, 0),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          // 파비콘 자리, 첫 글자 상자 22
          Container(
            width: 22,
            height: 22,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: colors.level1,
              borderRadius: BorderRadius.circular(IrisRadius.small),
              border: Border.all(color: colors.separator),
            ),
            child: Text(
              source.isEmpty ? '·' : source.characters.first.toUpperCase(),
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                color: colors.foreground,
              ),
            ),
          ),
          const SizedBox(width: 7),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 150),
            child: Text(
              tab.title.isEmpty ? host : tab.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (tab.aiControlled) ...[
            const SizedBox(width: 7),
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: colors.pink,
                borderRadius: BorderRadius.circular(3),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _NewTabChip extends StatelessWidget {
  const _NewTabChip({required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => KeyedSubtree(
    key: const Key('browser-new-tab'),
    child: _Chip(
      onPressed: onPressed,
      padding: const EdgeInsets.fromLTRB(10, 0, 12, 0),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IrisIcon('plus', size: 16, color: context.iris.foreground2),
          const SizedBox(width: 6),
          const Text('새 탭'),
        ],
      ),
    ),
  );
}
