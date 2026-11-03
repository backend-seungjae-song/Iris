import Flutter
import UIKit

class SceneDelegate: FlutterSceneDelegate {
  private let privacyShield = PrivacyShield()

  override func sceneWillResignActive(_ scene: UIScene) {
    privacyShield.cover(scene)
    super.sceneWillResignActive(scene)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    privacyShield.uncover()
    super.sceneDidBecomeActive(scene)
  }
}
