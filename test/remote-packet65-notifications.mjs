import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const android = 'mobile/android/app/src/main/kotlin/app/iris/iris_remote/';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('packet65 Android 새 고중요도 채널·무내용 문구·무음 갱신·0건 제거', () => {
  const source = read(`${android}KeepAliveService.kt`);
  assert.match(source, /REQUEST_CHANNEL = "iris\.remote\.requests\.v2"/);
  assert.match(source, /CONNECTION_CHANNEL = "iris\.remote\.connection\.min"/);
  assert.match(source, /deleteNotificationChannel\("iris\.remote\.requests"\)/);
  assert.match(source, /NotificationManager\.IMPORTANCE_HIGH/);
  assert.match(source, /"응답 요청 \$\{count\}건"/);
  assert.match(source, /private fun stopConnection\(\)[\s\S]*?cancel\(REQUEST_NOTIFICATION\)[\s\S]*?stopForeground\(STOP_FOREGROUND_REMOVE\)/);
  assert.doesNotMatch(source, /EXTRA_DISCONNECTED|연결이 끊겼습니다/);
  assert.match(source, /count <= 0[\s\S]*?cancel\(REQUEST_NOTIFICATION\)/);
  assert.match(source, /onlyAlertOnce = !alert/);
  assert.match(source, /REQUEST_QUIET_CHANNEL = "iris\.remote\.requests\.quiet"/);
  assert.match(source, /NotificationManager\.IMPORTANCE_LOW/);
  assert.match(source, /if \(alert\) REQUEST_CHANNEL else REQUEST_QUIET_CHANNEL/);
  assert.doesNotMatch(source, /setSilent/);
  assert.doesNotMatch(source, /count > requestCount|setContentText|setSubText/);
});

test('packet65 클릭 intent·일회 소비·Flutter 전달·화면 보안', () => {
  const service = read(`${android}KeepAliveService.kt`);
  const channel = read(`${android}KeepAliveChannel.kt`);
  const activity = read(`${android}MainActivity.kt`);
  assert.match(service, /putExtra\(EXTRA_OPEN_RESPONSES, opensResponses\)/);
  assert.match(service, /if \(opensResponses\) 1 else 0/);
  assert.match(channel, /putExtra\(KeepAliveService\.EXTRA_ALERT/);
  assert.match(channel, /"takeOpenResponses"[\s\S]*?activity\.takeOpenResponses\(\)/);
  assert.match(channel, /invokeMethod\("openResponses", null\)/);
  assert.match(activity, /override fun onNewIntent/);
  assert.match(activity, /removeExtra\(KeepAliveService\.EXTRA_OPEN_RESPONSES\)/);
  assert.match(activity, /WindowManager\.LayoutParams\.FLAG_SECURE/);
  const connection = read('mobile/lib/screens/connection_screen.dart');
  assert.match(connection, /state\.terminalQuestions/);
  assert.match(connection, /state\.agents/);
  assert.match(connection, /visibleAgent: NotificationNavigation\.instance\.visibleAgent/);
  assert.match(connection, /update\(update\.count, alert: update\.alert\)/);
  assert.match(read('mobile/lib/main.dart'), /navigatorObservers: \[\s*NotificationNavigation\.instance,?(?:\s*[A-Za-z]+\(\),?)?\s*\]/);
  assert.match(read('mobile/lib/screens/agent_list_screen.dart'), /_scroll\.jumpTo\(0\)/);
});
