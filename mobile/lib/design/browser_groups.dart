import 'package:flutter/material.dart';
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
