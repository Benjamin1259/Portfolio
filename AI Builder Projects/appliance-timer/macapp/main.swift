// Appliance Timer for macOS: a menu bar app that shows the Chrome extension's panel.
//
// The panel (popup.html + core.js, the same files as the extension) runs in a WKWebView kept alive in the
// background, so the menu bar title can show today's best start time, like the extension's badge.
//   appliance://app/…   the page's files, from the app bundle. model.json and scores.json come from
//                       ~/Library/Application Support/Appliance Timer/ when the daily retrain has put newer ones there.
//   native bridge       settings storage (in place of chrome.storage), exact network time, the menu bar title.

import AppKit
import ServiceManagement
import UserNotifications
import WebKit

let appSupport: URL = {
    let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Appliance Timer", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}()
let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
let refreshMinutes = 30.0
let panelWidth = 420.0, panelMargin = 8.0     // the panel docks to the right edge of the screen

// MARK: - Settings shared with the Chrome extension
// Appliances and preferences live in one JSON file. The panel reads and writes it through the bridge; the Chrome
// extension reaches it through native messaging (this same app, launched by Chrome in host mode: see bottom).

let settingsURL = appSupport.appendingPathComponent("settings.json")

enum Settings {
    static func load() -> [String: Any] {
        if let data = try? Data(contentsOf: settingsURL),
           let all = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { return all }
        // First run: start from what the app kept in its own preferences before settings were shared
        var all: [String: Any] = [:]
        for (key, value) in UserDefaults.standard.dictionaryRepresentation() where key.hasPrefix("store.") {
            if let text = value as? String, let data = text.data(using: .utf8),
               let v = try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) { all[String(key.dropFirst(6))] = v }
        }
        if !all.isEmpty { save(all) }
        return all
    }
    static func save(_ all: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: all, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: settingsURL, options: .atomic)
        }
    }
    static func get(_ key: String) -> Any? { load()[key] }
    static func set(_ items: [String: Any]) {
        var all = load()
        for (k, v) in items { all[k] = v }
        save(all)
    }
    static var modified: Date? { (try? settingsURL.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate }
}

func jsonText(_ v: Any?) -> String? {
    guard let v, !(v is NSNull), let d = try? JSONSerialization.data(withJSONObject: v, options: .fragmentsAllowed) else { return nil }
    return String(data: d, encoding: .utf8)
}

// MARK: - The page's files

final class LocalFiles: NSObject, WKURLSchemeHandler {
    static let types = ["html": "text/html", "js": "text/javascript", "css": "text/css",
                        "json": "application/json", "png": "image/png", "svg": "image/svg+xml"]
    static let updatable: Set<String> = ["model.json", "scores.json"]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = String(url.path.drop(while: { $0 == "/" }))
        if path.isEmpty { path = "popup.html" }
        let sources = (Self.updatable.contains(path) ? [appSupport] : []) + [webRoot]
        let file = path.contains("..") ? nil
            : sources.map { $0.appendingPathComponent(path) }.first { FileManager.default.fileExists(atPath: $0.path) }
        guard let file, let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didReceive(Data())
            task.didFinish()
            return
        }
        let headers = ["Content-Type": Self.types[file.pathExtension] ?? "application/octet-stream", "Cache-Control": "no-store"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - Native bridge (see shim.js)

/// Server time in epoch ms. Cloudflare's trace gives milliseconds; Open-Meteo's Date header whole seconds.
func networkTime() async -> [String: Any]? {
    var request = URLRequest(url: URL(string: "https://www.cloudflare.com/cdn-cgi/trace")!)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 8
    if let (data, _) = try? await URLSession.shared.data(for: request),
       let text = String(data: data, encoding: .utf8),
       let line = text.split(separator: "\n").first(where: { $0.hasPrefix("ts=") }),
       let ts = Double(line.dropFirst(3)) {
        return ["ms": ts * 1000, "via": "Cloudflare"]
    }
    request.url = URL(string: "https://api.open-meteo.com/v1/forecast?latitude=37.76&longitude=-122.43&current=temperature_2m")
    if let (_, response) = try? await URLSession.shared.data(for: request),
       let header = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Date") {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let d = f.date(from: header) { return ["ms": d.timeIntervalSince1970 * 1000 + 500, "via": "Open-Meteo"] }
    }
    return nil
}

// MARK: - Notifications ("Start now" alerts, scheduled by badge.js)

let alerts = UNUserNotificationCenter.current()
let alertPrefix = "start-"

func authStatus(_ s: UNAuthorizationStatus) -> String {
    switch s {
    case .authorized, .provisional, .ephemeral: return "authorized"
    case .denied: return "denied"
    default: return "notDetermined"
    }
}

/// Replace every scheduled "Start now" alert with `items` ([{id, at (epoch ms), title, body}]).
/// macOS delivers them at their time even if the app has quit, as long as the Mac is awake.
func scheduleAlerts(_ items: [[String: Any]]) {
    alerts.getPendingNotificationRequests { pending in
        alerts.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(alertPrefix) })
        for item in items {
            guard let id = item["id"] as? String, let ms = item["at"] as? Double else { continue }
            let content = UNMutableNotificationContent()
            content.title = item["title"] as? String ?? "Appliance Timer"
            content.body = item["body"] as? String ?? ""
            content.sound = .default
            content.categoryIdentifier = "start"
            let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second],
                                                       from: Date(timeIntervalSince1970: ms / 1000))
            let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
            alerts.add(UNNotificationRequest(identifier: id.hasPrefix(alertPrefix) ? id : alertPrefix + id, content: content, trigger: trigger))
        }
        NSLog("Appliance Timer alerts: %d scheduled", items.count)
    }
}

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var app: AppDelegate?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "bad message")
        }
        switch op {
        case "get":     // the page passes values as JSON text; the shared settings file holds them as JSON
            replyHandler(jsonText(Settings.get(body["key"] as? String ?? "")), nil)
        case "set":
            var items: [String: Any] = [:]
            for (key, json) in body["items"] as? [String: String] ?? [:] {
                items[key] = json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0, options: .fragmentsAllowed) } ?? NSNull()
            }
            Settings.set(items)
            app?.settingsSeen = Settings.modified
            replyHandler(true, nil)
        case "badge":
            app?.showBadge(body["text"] as? String ?? "", tooltip: body["title"] as? String ?? "Appliance Timer")
            replyHandler(true, nil)
        case "log":     // page errors (see shim.js), for Console.app
            NSLog("Appliance Timer page: %@", body["text"] as? String ?? "")
            replyHandler(true, nil)
        case "time":
            Task { @MainActor in replyHandler(await networkTime(), nil) }
        case "notify-auth":     // "status" or "request" → "authorized" | "denied" | "notDetermined"
            if body["action"] as? String == "request" {
                alerts.requestAuthorization(options: [.alert, .sound]) { _, _ in
                    alerts.getNotificationSettings { st in DispatchQueue.main.async { replyHandler(authStatus(st.authorizationStatus), nil) } }
                }
            } else {
                alerts.getNotificationSettings { st in DispatchQueue.main.async { replyHandler(authStatus(st.authorizationStatus), nil) } }
            }
        case "schedule":
            scheduleAlerts(body["items"] as? [[String: Any]] ?? [])
            replyHandler(true, nil)
        case "ics":     // "Add to calendar → Apple Calendar": save the event and open it in Calendar
            let name = (body["name"] as? String ?? "event.ics").replacingOccurrences(of: "/", with: "-")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            do {
                try (body["text"] as? String ?? "").write(to: url, atomically: true, encoding: .utf8)
                app?.keepOpen = true
                NSWorkspace.shared.open(url)
                replyHandler(true, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        default:
            replyHandler(nil, "unknown op \(op)")
        }
    }
}

// MARK: - Menu bar app

/// The panel: a borderless window docked to the right edge of the screen, like Chrome's side panel.
final class SidePanel: NSPanel {
    override var canBecomeKey: Bool { true }     // so the search box and other fields take typing
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, WKUIDelegate,
                         UNUserNotificationCenterDelegate {
    let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var panel: SidePanel!
    var panelShown: Bool { panel?.isVisible ?? false }
    /// Set when the panel sends the user to another app (Calendar, the browser): the panel then stays open while they
    /// click around there, until they click back in the panel
    var keepOpen = false
    let bridge = Bridge()
    var web: WKWebView!
    var loadedAt = Date()
    var pendingBadge: (text: String, tooltip: String)?

    func applicationDidFinishLaunching(_ note: Notification) {
        bridge.app = self
        installEditMenu()
        alerts.delegate = self
        let snooze = UNNotificationAction(identifier: "snooze", title: "Snooze 30 min", options: [])
        alerts.setNotificationCategories([UNNotificationCategory(identifier: "start", actions: [snooze], intentIdentifiers: [])])
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalFiles(), forURLScheme: "appliance")
        if #available(macOS 14.0, *) {
            // The page lives in a hidden panel most of the time. WebKit would suspend it after a few seconds,
            // before it computes the menu bar time; keep it running (it's idle apart from a 15 s clock tick).
            config.preferences.inactiveSchedulingPolicy = .none
        }
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "native")
        if let shim = try? String(contentsOf: webRoot.appendingPathComponent("shim.js"), encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 760), configuration: config)
        web.setValue(false, forKey: "drawsBackground")   // no white flash before the page's own background paints
        web.uiDelegate = self
        load()

        panel = SidePanel(contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 760), styleMask: [.borderless],
                          backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let box = NSView()
        box.wantsLayer = true
        box.layer?.cornerRadius = 12
        box.layer?.masksToBounds = true
        web.frame = box.bounds
        web.autoresizingMask = [.width, .height]
        box.addSubview(web)
        panel.contentView = box
        // Close when the user clicks anywhere outside the app (a global monitor sees clicks in other apps only), or
        // presses Esc in the panel. Not on "app resigned active": a menu bar click briefly activates the app and
        // macOS then hands focus back, which would close the panel the moment it opens.
        NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            if self?.keepOpen == false { self?.closePanel() }
        }
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] e in
            if e.window === self?.panel { self?.keepOpen = false }     // back in the panel: outside clicks close it again
            return e
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if e.keyCode == 53, self?.panelShown == true { self?.closePanel(); return nil }
            return e
        }

        if let button = status.button {
            let icon = NSImage(systemSymbolName: "sun.max.fill", accessibilityDescription: "Appliance Timer")
            icon?.isTemplate = true
            button.image = icon
            button.imagePosition = .imageLeading
            button.toolTip = "Appliance Timer"
            button.target = self
            button.action = #selector(clicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // Testing aid: `Appliance Timer --show-panel` opens the panel at launch and logs where it is
        if CommandLine.arguments.contains("--show-panel") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [self] in
                showPanel()
                NSLog("Appliance Timer panel: visible %d active %d frame %@", panelShown, NSApp.isActive, NSStringFromRect(panel.frame))
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [self] in
                    NSLog("Appliance Timer panel after 2s: visible %d active %d", panelShown, NSApp.isActive)
                }
            }
        }
        Timer.scheduledTimer(withTimeInterval: refreshMinutes * 60, repeats: true) { [weak self] _ in self?.refreshBadge() }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(woke),
                                                          name: NSWorkspace.didWakeNotification, object: nil)
    }

    /// A menu bar app has no menus of its own, and on macOS the Edit menu is what makes ⌘X/⌘C/⌘V/⌘A/⌘Z work in
    /// text fields. This one is never shown (no Dock icon or app menu) but its shortcuts work in the panel.
    func installEditMenu() {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        let main = NSMenu()
        main.addItem(NSMenuItem(title: "Appliance Timer", action: nil, keyEquivalent: ""))
        main.addItem(editItem)
        NSApp.mainMenu = main
    }

    var settingsSeen: Date?     // settings file time when the page last read it

    func load() {
        loadedAt = Date()
        settingsSeen = Settings.modified
        web.load(URLRequest(url: URL(string: "appliance://app/popup.html")!))
    }

    /// Every 30 min: reload the page (it keeps the model in memory, and the daily retrain may have replaced it),
    /// which also recomputes the menu bar title. While the panel is open, only the title is refreshed.
    func refreshBadge() {
        if panelShown { web.evaluateJavaScript("globalThis.__updateBadge?.()") } else { load() }
    }

    /// After sleep or a long time closed, the page's day, forecast and model may be stale: reload it.
    @objc func woke() { load() }

    @objc func closePanel() {
        guard panelShown else { return }
        keepOpen = false
        panel.orderOut(nil)
        if let b = pendingBadge { pendingBadge = nil; showBadge(b.text, tooltip: b.tooltip) }
    }

    /// Links that open a new tab (e.g. "Search Google for its energy use") open in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme) { keepOpen = true; NSWorkspace.shared.open(url) }
        return nil
    }

    func showBadge(_ text: String, tooltip: String) {
        // Changing the title resizes the menu bar item, which would shift the icon while the panel is open:
        // hold the update until it closes
        if panelShown { pendingBadge = (text, tooltip); return }
        status.button?.title = text.isEmpty ? "" : " " + text
        status.button?.toolTip = tooltip
        NSLog("Appliance Timer menu bar: %@ | %@", text, tooltip)
        snapshotIfAsked()
    }

    /// Testing aid: `Appliance Timer --snapshot out.png` renders the panel to a PNG once it has loaded, then quits.
    func snapshotIfAsked() {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return }
        let out = URL(fileURLWithPath: args[i + 1])
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [self] in
            let height = 2400.0
            web.setFrameSize(NSSize(width: 420, height: height))     // tall enough for the whole panel
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
                web.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) { try? png.write(to: out) }
                    NSApp.terminate(nil)
                }
            }
        }
    }

    // Show alerts even while the panel is open
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    // Snooze: the same alert again in 30 minutes. Clicking the alert: open the panel.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let request = response.notification.request
        if response.actionIdentifier == "snooze" {
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 30 * 60, repeats: false)
            alerts.add(UNNotificationRequest(identifier: "snoozed-" + UUID().uuidString, content: request.content, trigger: trigger))
        } else if response.actionIdentifier == UNNotificationDefaultActionIdentifier {
            DispatchQueue.main.async { if !self.panelShown { self.showPanel() } }
        }
        done()
    }

    @objc func clicked() {
        if NSApp.currentEvent?.type == .rightMouseUp { return showMenu() }
        if panelShown { return closePanel() }
        showPanel()
    }

    func showPanel() {
        // Reload if it's been a while, or if the Chrome extension changed the shared settings since
        if Date().timeIntervalSince(loadedAt) > refreshMinutes * 60 || Settings.modified != settingsSeen { load() }
        // Docked to the right edge of the screen the menu bar icon is on, from just under the menu bar to the bottom
        guard let screen = status.button?.window?.screen ?? NSScreen.main else { return }
        let area = screen.visibleFrame, m = panelMargin
        panel.setFrame(NSRect(x: area.maxX - panelWidth - m, y: area.minY + m, width: panelWidth, height: area.height - 2 * m),
                       display: true)
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refresh), keyEquivalent: "r").target = self
        let login = menu.addItem(withTitle: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Appliance Timer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        status.menu = menu
        status.button?.performClick(nil)
        status.menu = nil          // so the next left click opens the panel again
    }

    @objc func refresh() { load() }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Couldn't change Open at Login"
            alert.informativeText = "\(error.localizedDescription)\n\nMove Appliance Timer to your Applications folder and try again."
            alert.runModal()
        }
    }
}

// MARK: - Chrome native messaging host
// Chrome starts this app with its extension's origin as an argument and talks over stdin/stdout: each message is a
// 4-byte length (native byte order) followed by JSON. {op: "get", key} → {ok, value}; {op: "set", items} → {ok}.
func runNativeHost() -> Never {
    let input = FileHandle.standardInput, output = FileHandle.standardOutput
    while true {
        let head = input.readData(ofLength: 4)
        guard head.count == 4 else { exit(0) }          // Chrome closed the pipe
        let length = head.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        let body = input.readData(ofLength: Int(length))
        var reply: [String: Any] = ["ok": false]
        if let msg = try? JSONSerialization.jsonObject(with: body) as? [String: Any] {
            switch msg["op"] as? String {
            case "get": reply = ["ok": true, "value": Settings.get(msg["key"] as? String ?? "") ?? NSNull()]
            case "set": Settings.set(msg["items"] as? [String: Any] ?? [:]); reply = ["ok": true]
            case "ping": reply = ["ok": true]
            default: break
            }
        }
        let out = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data("{}".utf8)
        var n = UInt32(out.count)
        output.write(Data(bytes: &n, count: 4))
        output.write(out)
    }
}
if CommandLine.arguments.contains(where: { $0.hasPrefix("chrome-extension://") }) { runNativeHost() }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)     // menu bar only: no Dock icon
app.run()
