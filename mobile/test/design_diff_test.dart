import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';

const _screens = <String>[
  'h',
  'sa',
  'sb',
  'sc',
  'sd',
  'ba',
  'bb',
  'bc',
  'bd',
  'be',
  'bf',
  'bg',
  'ta',
  'tb',
  'tc',
  'ga',
  'gb',
  'gc',
];

const _localWindow = 12;
const _defaultBlurRadius = 24;
const _defaultPassLocalDifference = 19.5;
const _topMaskHeight = 54;
const _bottomChromeTop = 829;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final reportOnly = Platform.environment['DESIGN_DIFF_REPORT_ONLY'] == '1';
  final blurRadius =
      int.tryParse(Platform.environment['DESIGN_DIFF_BLUR_RADIUS'] ?? '') ??
      _defaultBlurRadius;
  final passLocalDifference =
      double.tryParse(Platform.environment['DESIGN_DIFF_THRESHOLD'] ?? '') ??
      _defaultPassLocalDifference;
  final actualDirectory =
      Platform.environment['DESIGN_DIFF_ACTUAL_DIR'] ?? 'test/goldens';
  final outputDirectory =
      Platform.environment['DESIGN_DIFF_OUTPUT_DIR'] ?? 'build/design-diff';
  final tones =
      Platform.environment['DESIGN_DIFF_TONES']?.split(',') ??
      const ['dark', 'light'];

  for (final tone in tones) {
    for (final screen in _screens) {
      test('$tone $screen 전체 화면 대조', () async {
        final referencePath = screen == 'sb'
            ? 'test/design_ref/overrides/$tone-sb.png'
            : 'test/design_ref/$tone-$screen.png';
        final result = await _compareDesignImages(
          reference: File(referencePath),
          actual: File('$actualDirectory/$tone-$screen.png'),
          difference: File('$outputDirectory/$tone-$screen.png'),
          blurRadius: blurRadius,
          passLocalDifference: passLocalDifference,
        );
        // 표로 옮길 수 있는 시험 결과
        // ignore: avoid_print
        print(
          'DESIGN_DIFF $tone-$screen '
          'MAX ${result.maximumLocalDifference.toStringAsFixed(3)} '
          'MEAN ${result.meanDifference.toStringAsFixed(3)} '
          'AT ${result.maximumWindow.left},${result.maximumWindow.top}',
        );
        if (!reportOnly) {
          expect(
            result.maximumLocalDifference,
            lessThanOrEqualTo(passLocalDifference),
            reason:
                '$tone-$screen 국소 차이 '
                '${result.maximumLocalDifference.toStringAsFixed(3)} '
                '(기준 $passLocalDifference/255, '
                '위치 ${result.maximumWindow.left},${result.maximumWindow.top}, '
                '이미지 ${result.difference.path})',
          );
        }
      });
    }
  }
}

class _DesignDiffResult {
  const _DesignDiffResult({
    required this.maximumLocalDifference,
    required this.meanDifference,
    required this.maximumWindow,
    required this.difference,
  });

  final double maximumLocalDifference;
  final double meanDifference;
  final _PixelRect maximumWindow;
  final File difference;
}

Future<_DesignDiffResult> _compareDesignImages({
  required File reference,
  required File actual,
  required File difference,
  int blurRadius = _defaultBlurRadius,
  double passLocalDifference = _defaultPassLocalDifference,
}) async {
  final expected = await _decode(reference);
  final observed = await _decode(actual);
  if (expected.width != observed.width || expected.height != observed.height) {
    throw TestFailure(
      '${actual.path} 크기 ${observed.width}x${observed.height}, '
      '기준 ${expected.width}x${expected.height}',
    );
  }

  final width = expected.width;
  final height = expected.height;
  final expectedBytes = await _rgba(expected);
  final actualBytes = await _rgba(observed);
  _normalizeMaskedRegions(expectedBytes, actualBytes, width, height);
  final expectedBlurred = _boxBlur(expectedBytes, width, height, blurRadius);
  final actualBlurred = _boxBlur(actualBytes, width, height, blurRadius);
  final differences = Float64List(width * height);
  final integral = Float64List((width + 1) * (height + 1));
  final countIntegral = Uint32List((width + 1) * (height + 1));
  var differenceTotal = 0.0;
  var compared = 0;

  for (var y = 0; y < height; y++) {
    var rowDifference = 0.0;
    var rowCount = 0;
    for (var x = 0; x < width; x++) {
      final offset = (y * width + x) * 4;
      final masked = _masked(x, y);
      final value = masked
          ? 0.0
          : (_channelDifference(expectedBlurred, actualBlurred, offset, 0) +
                    _channelDifference(
                      expectedBlurred,
                      actualBlurred,
                      offset,
                      1,
                    ) +
                    _channelDifference(
                      expectedBlurred,
                      actualBlurred,
                      offset,
                      2,
                    )) /
                3;
      differences[y * width + x] = value;
      if (!masked) {
        differenceTotal += value;
        compared++;
        rowDifference += value;
        rowCount++;
      }
      final integralIndex = (y + 1) * (width + 1) + x + 1;
      integral[integralIndex] =
          integral[integralIndex - width - 1] + rowDifference;
      countIntegral[integralIndex] =
          countIntegral[integralIndex - width - 1] + rowCount;
    }
  }

  var maximum = -1.0;
  var maximumWindow = const _PixelRect(0, 0, _localWindow, _localWindow);
  for (var top = _topMaskHeight; top <= height - _localWindow; top++) {
    for (var left = 0; left <= width - _localWindow; left++) {
      final right = left + _localWindow;
      final bottom = top + _localWindow;
      final sum = _area(integral, width + 1, left, top, right, bottom);
      final count = _area(countIntegral, width + 1, left, top, right, bottom);
      if (count != _localWindow * _localWindow) continue;
      final local = sum / count;
      if (local > maximum) {
        maximum = local;
        maximumWindow = _PixelRect(left, top, right, bottom);
      }
    }
  }

  final marked = Uint8List.fromList(actualBytes);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      if (_masked(x, y)) continue;
      final value = differences[y * width + x];
      if (value < passLocalDifference) continue;
      final offset = (y * width + x) * 4;
      marked[offset] = 255;
      marked[offset + 1] = math.max(0, 168 - value.round() * 4);
      marked[offset + 2] = 48;
      marked[offset + 3] = 255;
    }
  }
  _markWindow(marked, width, height, maximumWindow);

  await difference.parent.create(recursive: true);
  await difference.writeAsBytes(await _encodeRgba(marked, width, height));
  expected.dispose();
  observed.dispose();

  return _DesignDiffResult(
    maximumLocalDifference: maximum,
    meanDifference: differenceTotal / compared,
    maximumWindow: maximumWindow,
    difference: difference,
  );
}

Uint8List _boxBlur(Uint8List source, int width, int height, int radius) {
  final result = Uint8List(source.length);
  final stride = width + 1;
  for (var channel = 0; channel < 3; channel++) {
    final integral = Uint32List((width + 1) * (height + 1));
    for (var y = 0; y < height; y++) {
      var row = 0;
      for (var x = 0; x < width; x++) {
        row += source[(y * width + x) * 4 + channel];
        final index = (y + 1) * stride + x + 1;
        integral[index] = integral[index - stride] + row;
      }
    }
    for (var y = 0; y < height; y++) {
      final top = math.max(0, y - radius);
      final bottom = math.min(height, y + radius + 1);
      for (var x = 0; x < width; x++) {
        final left = math.max(0, x - radius);
        final right = math.min(width, x + radius + 1);
        final sum = _area(integral, stride, left, top, right, bottom);
        result[(y * width + x) * 4 + channel] =
            (sum / ((right - left) * (bottom - top))).round();
      }
    }
  }
  for (var pixel = 0; pixel < width * height; pixel++) {
    result[pixel * 4 + 3] = 255;
  }
  return result;
}

num _area(
  List<num> integral,
  int stride,
  int left,
  int top,
  int right,
  int bottom,
) =>
    integral[bottom * stride + right] -
    integral[top * stride + right] -
    integral[bottom * stride + left] +
    integral[top * stride + left];

double _channelDifference(
  Uint8List expected,
  Uint8List actual,
  int offset,
  int channel,
) => (expected[offset + channel] - actual[offset + channel]).abs().toDouble();

void _markWindow(Uint8List bytes, int width, int height, _PixelRect rect) {
  for (var y = rect.top; y < rect.bottom; y++) {
    for (var x = rect.left; x < rect.right; x++) {
      if (x != rect.left &&
          x != rect.right - 1 &&
          y != rect.top &&
          y != rect.bottom - 1) {
        continue;
      }
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      final offset = (y * width + x) * 4;
      bytes[offset] = 255;
      bytes[offset + 1] = 0;
      bytes[offset + 2] = 255;
      bytes[offset + 3] = 255;
    }
  }
}

bool _masked(int x, int y) =>
    y < _topMaskHeight ||
    y >= _bottomChromeTop ||
    (y >= 760 && (x < 12 || x >= 382));

void _normalizeMaskedRegions(
  Uint8List expected,
  Uint8List actual,
  int width,
  int height,
) {
  for (var y = 0; y < height; y++) {
    if (!_masked(0, y)) continue;
    final start = y * width * 4;
    final end = start + width * 4;
    actual.setRange(start, end, expected, start);
  }
}

class _PixelRect {
  const _PixelRect(this.left, this.top, this.right, this.bottom);

  final int left;
  final int top;
  final int right;
  final int bottom;
}

Future<ui.Image> _decode(File file) async {
  if (!file.existsSync()) throw TestFailure('${file.path} 파일 없음');
  final codec = await ui.instantiateImageCodec(await file.readAsBytes());
  final frame = await codec.getNextFrame();
  codec.dispose();
  return frame.image;
}

Future<Uint8List> _rgba(ui.Image image) async {
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  if (data == null) throw TestFailure('이미지 픽셀을 읽을 수 없음');
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

Future<Uint8List> _encodeRgba(Uint8List bytes, int width, int height) async {
  final buffer = await ui.ImmutableBuffer.fromUint8List(bytes);
  final descriptor = ui.ImageDescriptor.raw(
    buffer,
    width: width,
    height: height,
    pixelFormat: ui.PixelFormat.rgba8888,
  );
  final codec = await descriptor.instantiateCodec();
  final frame = await codec.getNextFrame();
  final data = await frame.image.toByteData(format: ui.ImageByteFormat.png);
  frame.image.dispose();
  codec.dispose();
  descriptor.dispose();
  buffer.dispose();
  if (data == null) throw TestFailure('차이 이미지를 만들 수 없음');
  return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}
