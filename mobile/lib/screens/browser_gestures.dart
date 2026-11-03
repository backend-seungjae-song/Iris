import 'dart:math' as math;

import 'package:flutter/painting.dart';

enum BrowserGesture { pending, scroll, pinch }

// travel: 두 손가락이 시작점에서 움직인 방향의 코사인(같은 방향 1, 반대 -1).
// 같은 방향으로 움직이면 손가락 간격이 조금 변해도 스크롤이다.
BrowserGesture classifyBrowserGesture({
  required double distanceChange,
  required double centerMove,
  double threshold = 6,
  double? travel,
}) {
  if (travel != null) {
    if (travel >= 0.5) {
      return centerMove >= threshold
          ? BrowserGesture.scroll
          : BrowserGesture.pending;
    }
    if (travel <= -0.3) {
      return distanceChange >= threshold
          ? BrowserGesture.pinch
          : BrowserGesture.pending;
    }
    if (math.max(distanceChange, centerMove) < threshold * 3) {
      return BrowserGesture.pending;
    }
  }
  if (distanceChange >= math.max(threshold, centerMove * 1.5)) {
    return BrowserGesture.pinch;
  }
  if (centerMove >= threshold) return BrowserGesture.scroll;
  return BrowserGesture.pending;
}

// 두 손가락이 시작점에서 움직인 방향의 코사인, 한쪽이 거의 안 움직였으면 null
double? browserTravelCosine(Offset first, Offset second) {
  final a = first.distance, b = second.distance;
  if (a < 2 || b < 2) return null;
  return (first.dx * second.dx + first.dy * second.dy) / (a * b);
}

Offset browserInertiaVelocity(Offset velocity, double seconds) =>
    velocity * math.exp(-5 * seconds);

Rect browserFrameBaseRect(Size size, Size frame) {
  final scale = math.min(size.width / frame.width, size.height / frame.height);
  return Rect.fromLTWH(
    (size.width - frame.width * scale) / 2,
    (size.height - frame.height * scale) / 2,
    frame.width * scale,
    frame.height * scale,
  );
}
