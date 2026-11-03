import 'package:flutter/material.dart';

String irisNavSvg(String shapes, Color color) {
  final hex = color.toARGB32().toRadixString(16).padLeft(8, '0');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" '
      'fill="none" stroke="#${hex.substring(2)}" stroke-opacity="${color.a}" '
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      '$shapes</svg>';
}

// 설정 슬라이더 아이콘. 홈 머리글 오른쪽 버튼
const irisSlidersShapes =
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>';
