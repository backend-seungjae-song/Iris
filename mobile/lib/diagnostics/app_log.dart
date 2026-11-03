import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

// 디버그 빌드에서만 동작하는 동작·오류 기록. 로그캣의 [iris] 줄로 출력하고 파일은 쓰지 않는다
// 본문·PIN·토큰은 기록하지 않고 메시지 종류, 요청 번호, 화면 이름, 오류와 스택만 남긴다
// 같은 줄이 연달아 오면 횟수로 합쳐 출력량을 줄인다
class AppLog {
  AppLog._();

  static bool _on = false;
  static String _last = '';
  static int _repeats = 0;
  static void Function(String line) _sink = (line) => debugPrint(line);

  @visibleForTesting
  static void useSink(void Function(String line) sink) {
    _sink = sink;
    _on = true;
    _last = '';
    _repeats = 0;
  }

  static void install() {
    if (!kDebugMode) return;
    _on = true;
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      write('error', '${details.exceptionAsString()}\n${details.stack ?? ''}');
      if (previous != null) {
        previous(details);
      } else {
        FlutterError.presentError(details);
      }
    };
    final dispatcher = WidgetsBinding.instance.platformDispatcher;
    final previousAsync = dispatcher.onError;
    dispatcher.onError = (error, stack) {
      write('async-error', '$error\n$stack');
      return previousAsync?.call(error, stack) ?? false;
    };
    write('start', 'app');
  }

  static void write(String kind, String text) {
    if (!_on) return;
    final line = '$kind $text';
    if (line == _last) {
      _repeats++;
      return;
    }
    if (_repeats > 0) {
      _sink('[iris] (직전 줄 $_repeats회 반복)');
      _repeats = 0;
    }
    _last = line;
    _sink('[iris] $line');
  }
}

// 화면 이동 기록
class AppLogNavigatorObserver extends NavigatorObserver {
  String _name(Route<dynamic>? route) => route == null
      ? '-'
      : (route.settings.name ?? route.runtimeType.toString());

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      AppLog.write(
        'route',
        'push ${_name(route)} from ${_name(previousRoute)}',
      );

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) =>
      AppLog.write('route', 'pop ${_name(route)} to ${_name(previousRoute)}');

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) =>
      AppLog.write(
        'route',
        'replace ${_name(oldRoute)} with ${_name(newRoute)}',
      );
}
