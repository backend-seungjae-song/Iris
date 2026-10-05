import 'package:flutter/material.dart';

class TerminalCell {
  TerminalCell(this.value, this.style, {this.width = 1});
  String value;
  TextStyle style;
  int width;
}

class TerminalGrid {
  const TerminalGrid({
    required this.columns,
    required this.rows,
    required this.cells,
    this.cursorX = 0,
    this.cursorY = 0,
    this.cursorVisible = false,
  });
  final int columns;
  final int rows;
  final List<List<TerminalCell>> cells;
  final int cursorX;
  final int cursorY;
  final bool cursorVisible;
  String get plainText => cells
      .map((row) => row.map((cell) => cell.value).join().trimRight())
      .join('\n');
}

int terminalCharacterWidth(String character) {
  final rune = character.runes.first;
  if (rune < 32 ||
      (rune >= 0x300 && rune <= 0x36f) ||
      (rune >= 0xfe00 && rune <= 0xfe0f)) {
    return 0;
  }
  if ((rune >= 0x1100 && rune <= 0x115f) ||
      rune == 0x2329 ||
      rune == 0x232a ||
      (rune >= 0x2e80 && rune <= 0xa4cf && rune != 0x303f) ||
      (rune >= 0xac00 && rune <= 0xd7a3) ||
      (rune >= 0xf900 && rune <= 0xfaff) ||
      (rune >= 0xfe10 && rune <= 0xfe19) ||
      (rune >= 0xfe30 && rune <= 0xfe6f) ||
      (rune >= 0xff00 && rune <= 0xff60) ||
      (rune >= 0xffe0 && rune <= 0xffe6) ||
      (rune >= 0x1f1e6 && rune <= 0x1faff) ||
      (rune >= 0x20000 && rune <= 0x3fffd) ||
      character.contains('\ufe0f') ||
      character.contains('\u20e3')) {
    return 2;
  }
  return 1;
}

Color terminalPalette(int index) {
  const basic = [
    0xff000000,
    0xffcd0000,
    0xff00cd00,
    0xffcdcd00,
    0xff0000ee,
    0xffcd00cd,
    0xff00cdcd,
    0xffe5e5e5,
    0xff7f7f7f,
    0xffff0000,
    0xff00ff00,
    0xffffff00,
    0xff5c5cff,
    0xffff00ff,
    0xff00ffff,
    0xffffffff,
  ];
  if (index < 16) return Color(basic[index.clamp(0, 15)]);
  if (index >= 232) {
    final gray = 8 + (index.clamp(232, 255) - 232) * 10;
    return Color.fromARGB(255, gray, gray, gray);
  }
  const levels = [0, 95, 135, 175, 215, 255];
  final value = index - 16;
  return Color.fromARGB(
    255,
    levels[value ~/ 36],
    levels[(value ~/ 6) % 6],
    levels[value % 6],
  );
}

List<int> _sgrParameters(String value) {
  final result = <int>[];
  for (final parameter in value.split(';')) {
    final fields = parameter.split(':');
    if (fields.length == 1) {
      result.add(int.tryParse(parameter) ?? 0);
      continue;
    }
    final code = int.tryParse(fields[0]);
    final mode = int.tryParse(fields[1]);
    if (code != 38 && code != 48) continue;
    final components = fields.sublist(2);
    // 콜론 truecolor는 RGB 앞에 빈 값 또는 기본 색 공간(0)을 넣을 수 있다.
    if (mode == 2 &&
        components.length == 4 &&
        (components.first.isEmpty || components.first == '0')) {
      components.removeAt(0);
    }
    if (((mode == 2 && components.length == 3) ||
            (mode == 5 && components.length == 1)) &&
        components.every((component) => int.tryParse(component) != null)) {
      result.addAll([code!, mode!, ...components.map(int.parse)]);
    }
  }
  return result;
}

TerminalGrid parseTerminalGrid(
  String input, {
  required int columns,
  required int rows,
}) {
  if (columns <= 0 || rows <= 0) throw ArgumentError('터미널 열·행 수 확인 필요');
  const foregroundDefault = Color(0xffc9dcea),
      backgroundDefault = Color(0xff101820);
  const base = TextStyle(color: foregroundDefault, fontFamily: 'monospace');
  List<List<TerminalCell>> empty() => List.generate(
    rows,
    (_) => List.generate(columns, (_) => TerminalCell(' ', base)),
  );
  var cells = empty();
  List<List<TerminalCell>>? normal;
  var x = 0, y = 0, savedX = 0, savedY = 0;
  var cursorVisible = false;
  var bold = false,
      italic = false,
      underline = false,
      inverse = false,
      dim = false;
  Color? foreground, background;
  TextStyle current() {
    final fg = inverse
        ? background ?? backgroundDefault
        : foreground ?? foregroundDefault;
    final bg = inverse ? foreground ?? foregroundDefault : background;
    return base.copyWith(
      color: fg.withValues(alpha: dim ? .55 : 1),
      backgroundColor: bg,
      fontWeight: bold ? FontWeight.bold : FontWeight.normal,
      fontStyle: italic ? FontStyle.italic : FontStyle.normal,
      decoration: underline ? TextDecoration.underline : TextDecoration.none,
    );
  }

  void sgr(List<int> codes) {
    if (codes.isEmpty) codes = [0];
    for (var i = 0; i < codes.length; i++) {
      final code = codes[i];
      switch (code) {
        case 0:
          bold = italic = underline = inverse = dim = false;
          foreground = background = null;
        case 1:
          bold = true;
        case 2:
          dim = true;
        case 3:
          italic = true;
        case 4:
          underline = true;
        case 7:
          inverse = true;
        case 22:
          bold = dim = false;
        case 23:
          italic = false;
        case 24:
          underline = false;
        case 27:
          inverse = false;
        case 39:
          foreground = null;
        case 49:
          background = null;
        case 38:
        case 48:
          Color? color;
          if (i + 2 < codes.length && codes[i + 1] == 5) {
            color = terminalPalette(codes[i + 2].clamp(0, 255));
            i += 2;
          } else if (i + 4 < codes.length && codes[i + 1] == 2) {
            color = Color.fromARGB(
              255,
              codes[i + 2].clamp(0, 255),
              codes[i + 3].clamp(0, 255),
              codes[i + 4].clamp(0, 255),
            );
            i += 4;
          }
          if (color != null) {
            if (code == 38) {
              foreground = color;
            } else {
              background = color;
            }
          }
        default:
          if (code >= 30 && code <= 37) foreground = terminalPalette(code - 30);
          if (code >= 40 && code <= 47) background = terminalPalette(code - 40);
          if (code >= 90 && code <= 97) {
            foreground = terminalPalette(code - 90 + 8);
          }
          if (code >= 100 && code <= 107) {
            background = terminalPalette(code - 100 + 8);
          }
      }
    }
  }

  void erase(int start, int end) {
    for (
      var position = start.clamp(0, rows * columns);
      position < end.clamp(0, rows * columns);
      position++
    ) {
      cells[position ~/ columns][position % columns] = TerminalCell(
        ' ',
        current(),
      );
    }
  }

  final ansi = RegExp(r'\x1b\[([0-9;:?]*)([ -/]*)([@-~])');
  final osc = RegExp(r'\x1b\][\s\S]*?(?:\x07|\x1b\\)');
  var index = 0;
  while (index < input.length) {
    final escape = osc.matchAsPrefix(input, index);
    if (escape != null) {
      index = escape.end;
      continue;
    }
    final match = ansi.matchAsPrefix(input, index);
    if (match != null) {
      final private = match[1]!.startsWith('?');
      final params = match[1]!
          .replaceFirst('?', '')
          .replaceAll(':', ';')
          .split(';')
          .map((value) => int.tryParse(value) ?? 0)
          .toList();
      final command = match[3]!;
      final n = params.first == 0 ? 1 : params.first;
      if (command == 'm') {
        final colors = _sgrParameters(match[1]!);
        if (colors.isNotEmpty) sgr(colors);
      } else if (private && (command == 'h' || command == 'l')) {
        for (final mode in params) {
          if (mode == 25) cursorVisible = command == 'h';
          if (mode == 1049 || mode == 1047 || mode == 47) {
            if (command == 'h') {
              normal ??= cells;
              cells = empty();
              savedX = x;
              savedY = y;
              x = y = 0;
            } else if (normal != null) {
              cells = normal;
              normal = null;
              x = savedX;
              y = savedY;
            }
          }
        }
      } else {
        switch (command) {
          case 'A':
            y = (y - n).clamp(0, rows - 1);
          case 'B':
          case 'e':
            y = (y + n).clamp(0, rows - 1);
          case 'C':
          case 'a':
            x = (x + n).clamp(0, columns - 1);
          case 'D':
            x = (x - n).clamp(0, columns - 1);
          case 'E':
            y = (y + n).clamp(0, rows - 1);
            x = 0;
          case 'F':
            y = (y - n).clamp(0, rows - 1);
            x = 0;
          case 'G':
            x = (n - 1).clamp(0, columns - 1);
          case 'd':
            y = (n - 1).clamp(0, rows - 1);
          case 'H':
          case 'f':
            y = (n - 1).clamp(0, rows - 1);
            x = ((params.length > 1 && params[1] > 0 ? params[1] : 1) - 1)
                .clamp(0, columns - 1);
          case 'J':
            final mode = params.first;
            erase(
              mode == 0 ? y * columns + x : 0,
              mode == 1 ? y * columns + x + 1 : rows * columns,
            );
          case 'K':
            final mode = params.first;
            erase(
              y * columns + (mode == 0 ? x : 0),
              y * columns + (mode == 1 ? x + 1 : columns),
            );
          case 's':
            savedX = x;
            savedY = y;
          case 'u':
            x = savedX;
            y = savedY;
        }
      }
      index = match.end;
      continue;
    }
    if (input.codeUnitAt(index) == 27) {
      index += index + 1 < input.length ? 2 : 1;
      continue;
    }
    final nextEscape = input.indexOf('\x1b', index);
    final end = nextEscape < 0 ? input.length : nextEscape;
    for (final character in input.substring(index, end).characters) {
      if (character == '\r\n' || character == '\n') {
        y++;
        x = 0;
        continue;
      }
      if (character == '\r') {
        x = 0;
        continue;
      }
      if (character == '\b') {
        x = (x - 1).clamp(0, columns - 1);
        continue;
      }
      if (character == '\t') {
        x = ((x ~/ 8 + 1) * 8).clamp(0, columns);
        continue;
      }
      final width = terminalCharacterWidth(character);
      if (width == 0) {
        if (y < rows && x > 0) cells[y][x - 1].value += character;
        continue;
      }
      // 원본 pane의 줄 배치 보존
      if (y >= rows || x + width > columns) continue;
      if (x > 0 && cells[y][x].width == 0) {
        cells[y][x - 1] = TerminalCell(' ', current());
      }
      cells[y][x] = TerminalCell(character, current(), width: width);
      if (width == 2) cells[y][x + 1] = TerminalCell('', current(), width: 0);
      x += width;
    }
    index = end;
  }
  return TerminalGrid(
    columns: columns,
    rows: rows,
    cells: cells,
    cursorX: x.clamp(0, columns - 1),
    cursorY: y.clamp(0, rows - 1),
    cursorVisible: cursorVisible,
  );
}

double terminalFontSize(double width, int columns) {
  final painter = TextPainter(
    text: const TextSpan(
      text: 'M',
      style: TextStyle(fontFamily: 'monospace', fontSize: 16),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  return (width / columns / painter.width * 16).clamp(.01, 16);
}

({int column, int row}) terminalCellAt(
  Offset point,
  double cellWidth,
  double cellHeight,
  int columns,
  int rows,
) => (
  column: (point.dx / cellWidth).floor().clamp(0, columns - 1) + 1,
  row: (point.dy / cellHeight).floor().clamp(0, rows - 1) + 1,
);

class TerminalGridPainter extends CustomPainter {
  const TerminalGridPainter(this.grid, this.fontSize);
  final TerminalGrid grid;
  final double fontSize;
  @override
  void paint(Canvas canvas, Size size) {
    final cellWidth = size.width / grid.columns,
        cellHeight = size.height / grid.rows;
    for (var y = 0; y < grid.rows; y++) {
      for (var x = 0; x < grid.columns; x++) {
        final cell = grid.cells[y][x];
        if (cell.width == 0) continue;
        final rect = Rect.fromLTWH(
          x * cellWidth,
          y * cellHeight,
          cellWidth * cell.width,
          cellHeight,
        );
        if (cell.style.backgroundColor != null) {
          canvas.drawRect(rect, Paint()..color = cell.style.backgroundColor!);
        }
        if (cell.value.trim().isEmpty) continue;
        final painter = TextPainter(
          text: TextSpan(
            text: cell.value,
            style: cell.style.copyWith(
              fontSize: fontSize,
              backgroundColor: null,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        canvas.save();
        canvas.clipRect(rect);
        canvas.translate(rect.left, rect.top);
        if (painter.width > rect.width) {
          canvas.scale(rect.width / painter.width, 1);
        }
        painter.paint(canvas, Offset(0, (cellHeight - painter.height) / 2));
        canvas.restore();
      }
    }
    if (grid.cursorVisible) {
      canvas.drawRect(
        Rect.fromLTWH(
          grid.cursorX * cellWidth,
          grid.cursorY * cellHeight,
          cellWidth,
          cellHeight,
        ),
        Paint()..color = Colors.white.withValues(alpha: .4),
      );
    }
  }

  @override
  bool shouldRepaint(TerminalGridPainter oldDelegate) =>
      oldDelegate.grid != grid || oldDelegate.fontSize != fontSize;
}

String terminalErrorMessage(String code) => switch (code) {
  'terminal-frame-too-large' => '터미널 화면이 48 KiB를 넘어 표시할 수 없습니다.',
  'terminal-layout-unavailable' => '터미널 화면 크기를 확인할 수 없습니다. 다시 연결하세요.',
  _ => '터미널 화면을 읽지 못했습니다. 컴퓨터에서 pane 상태를 확인하세요.',
};
