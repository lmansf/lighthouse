// §35 §1: Dynamic Type live-resolve. WKWebView fixes the resolved root font
// size at page load, so a Dynamic Type change made while Lighthouse is
// running would not take effect until the next launch. This observer watches
// UIContentSizeCategory.didChangeNotification and reloads the app's
// webviews — the shell restores its state from the persisted stores, so the
// reload is a size re-resolve, not data loss. THIN by the house convention:
// plumbing only, started once from the Rust boot hook via the ObjC-runtime
// idiom (see commands.rs::start_content_size_observer).

#if os(iOS)

import UIKit
import WebKit

@objc(LHContentSizeObserver)
final class LHContentSizeObserver: NSObject {
    private static let shared = LHContentSizeObserver()
    private var started = false

    @objc(startShared)
    static func startShared() {
        shared.start()
    }

    private func start() {
        guard !started else { return }
        started = true
        NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification,
            object: nil,
            queue: .main
        ) { _ in
            for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
                for window in scene.windows {
                    Self.reloadWebViews(in: window)
                }
            }
        }
    }

    private static func reloadWebViews(in view: UIView) {
        if let webView = view as? WKWebView {
            webView.reload()
            return
        }
        for subview in view.subviews {
            reloadWebViews(in: subview)
        }
    }
}

#endif
