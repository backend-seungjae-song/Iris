import 'package:flutter_test/flutter_test.dart';
import 'package:iris_remote/diagnostics/app_log.dart';

void main() {
  test('같은 줄은 횟수로 합쳐 출력한다', () {
    final lines = <String>[];
    AppLog.useSink(lines.add);
    for (var i = 0; i < 5; i++) {
      AppLog.write('recv', 'AgentsMessage');
    }
    AppLog.write('send', 'agents.get rid=1');
    expect(lines, [
      '[iris] recv AgentsMessage',
      '[iris] (직전 줄 4회 반복)',
      '[iris] send agents.get rid=1',
    ]);
  });
}
