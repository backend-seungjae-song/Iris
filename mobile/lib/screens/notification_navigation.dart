import 'package:flutter/material.dart';
import 'package:iris_remote/design/session_header.dart';
import 'package:iris_remote/screens/terminal_screen.dart';

class NotificationNavigation extends NavigatorObserver {
  static final instance = NotificationNavigation();

  String? get visibleAgent {
    String? ref;
    void visit(Element element) {
      final widget = element.widget;
      if (widget is IrisSessionHeader &&
          widget.mode != SessionMode.browser &&
          ModalRoute.of(element)?.isCurrent == true) {
        ref = widget.tabs
            .whereType<IrisAgentTab>()
            .where((tab) => tab.selected)
            .firstOrNull
            ?.agent
            .ref;
      }
      if (widget is TerminalAgentMarker &&
          ModalRoute.of(element)?.isCurrent == true) {
        ref = widget.agentRef;
      }
      element.visitChildElements(visit);
    }

    navigator?.context.visitChildElements(visit);
    return ref;
  }

  void openResponses() => navigator?.popUntil((route) => route.isFirst);
}
