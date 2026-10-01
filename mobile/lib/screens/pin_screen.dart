import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:iris_remote/design/buttons.dart';
import 'package:iris_remote/design/flow.dart';
import 'package:iris_remote/design/tokens.dart';

class AccessPinScreen extends StatefulWidget {
  const AccessPinScreen({super.key});

  @override
  State<AccessPinScreen> createState() => _AccessPinScreenState();
}

class _AccessPinScreenState extends State<AccessPinScreen> {
  final TextEditingController _controller = TextEditingController();

  @override
  void initState() {
    super.initState();
    _controller.addListener(_changed);
  }

  @override
  void dispose() {
    _controller
      ..removeListener(_changed)
      ..dispose();
    super.dispose();
  }

  void _changed() => setState(() {});

  void _submit() {
    if (_controller.text.length < 6) return;
    Navigator.of(context).pop(_controller.text);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            IrisFlowHeader(
              title: '접속 PIN',
              onBack: () => Navigator.of(context).pop(),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 32, 20, 24),
                children: [
                  Text(
                    'Mac에서 정한 PIN을 입력하세요',
                    style: TextStyle(
                      color: context.iris.foreground,
                      fontSize: 24,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    '연결할 때마다 확인하며 이 폰에는 저장하지 않습니다.',
                    style: TextStyle(
                      color: context.iris.muted,
                      fontSize: 16,
                      height: 1.45,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Mac의 Iris 원격 화면 → 접속 PIN에서 정하고 바꿉니다.',
                    style: TextStyle(
                      color: context.iris.muted,
                      fontSize: 14,
                      height: 1.45,
                    ),
                  ),
                  const SizedBox(height: 28),
                  TextField(
                    key: const Key('access-pin-input'),
                    controller: _controller,
                    autofocus: true,
                    obscureText: true,
                    keyboardType: TextInputType.number,
                    textInputAction: TextInputAction.done,
                    autofillHints: null,
                    enableSuggestions: false,
                    autocorrect: false,
                    maxLength: 32,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(
                      labelText: 'PIN',
                      hintText: '숫자 6자리 이상',
                      counterText: '',
                    ),
                    onSubmitted: (_) => _submit(),
                  ),
                  const SizedBox(height: 20),
                  Row(
                    children: [
                      IrisButton(
                        key: const Key('access-pin-submit'),
                        label: '연결',
                        tone: IrisButtonTone.primary,
                        height: 56,
                        onPressed: _controller.text.length >= 6
                            ? _submit
                            : null,
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
