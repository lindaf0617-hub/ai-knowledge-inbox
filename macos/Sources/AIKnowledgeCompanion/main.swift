import AppKit
import Carbon
import CryptoKit
import Foundation
import Security
import UniformTypeIdentifiers

private let serviceURL = URL(string: "http://127.0.0.1:43127")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var statusItem: NSStatusItem!
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var serviceProcess: Process?
    private var captureWindow: NSWindow?
    private var captureController: CaptureWindowController?
    private var proofValidUntil = Date.distantPast
    private var proofToken = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        do {
            try startService()
            try verifyServiceIdentity()
            configureStatusItem()
            try registerHotKey()
            notify(title: "AI Knowledge Companion", text: "Copy AI content and press Command + ;")
        } catch {
            showError(error.localizedDescription)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
        if let process = serviceProcess, process.isRunning { process.terminate() }
    }

    private func configureStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.title = "AI"
            button.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .bold)
            button.toolTip = "AI Knowledge Companion — Command + ;"
        }
        let menu = NSMenu()
        menu.addItem(withTitle: "Save Clipboard (Command + ;)", action: #selector(showCapture), keyEquivalent: "")
        menu.addItem(withTitle: "Pair Browser Extension…", action: #selector(showPairingCode), keyEquivalent: "")
        menu.addItem(withTitle: "Save Diagnostics…", action: #selector(saveDiagnostics), keyEquivalent: "")
        menu.addItem(withTitle: "Open Knowledge Data", action: #selector(openDataFolder), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q")
        menu.items.forEach { $0.target = self }
        statusItem.menu = menu
    }

    private func registerHotKey() throws {
        var hotKeyID = EventHotKeyID(signature: OSType(0x41494B42), id: 1)
        let result = RegisterEventHotKey(
            UInt32(kVK_ANSI_Semicolon),
            UInt32(cmdKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        guard result == noErr else {
            throw CompanionError.message("Command + ; is already used by another app.")
        }
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        let pointer = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData in
                guard let userData else { return noErr }
                let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { delegate.showCapture() }
                return noErr
            },
            1,
            &eventType,
            pointer,
            &eventHandler
        )
    }

    private func startService() throws {
        if serviceIsHealthy() { return }
        guard
            let resources = Bundle.main.resourceURL,
            let server = Bundle.main.url(forResource: "server", withExtension: "js"),
            let node = bundledNodeURL(resources: resources)
        else {
            throw CompanionError.message("Bundled local service files are missing.")
        }

        let dataDirectory = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AIKnowledgeInbox", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dataDirectory,
            withIntermediateDirectories: true
        )

        let process = Process()
        process.executableURL = node
        process.arguments = [server.path]
        var environment = ProcessInfo.processInfo.environment
        environment["AI_KNOWLEDGE_DATA_DIR"] = dataDirectory.path
        if let oneDrive = findOneDriveFolder() {
            environment["AI_KNOWLEDGE_ONEDRIVE"] = oneDrive.path
        }
        process.environment = environment
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        serviceProcess = process

        for _ in 0..<25 {
            Thread.sleep(forTimeInterval: 0.2)
            if serviceIsHealthy() { return }
            if !process.isRunning { break }
        }
        throw CompanionError.message("The local knowledge service failed to start.")
    }

    private func bundledNodeURL(resources: URL) -> URL? {
        #if arch(arm64)
        return resources.appendingPathComponent("node-arm64")
        #else
        return resources.appendingPathComponent("node-x64")
        #endif
    }

    private func findOneDriveFolder() -> URL? {
        let cloudStorage = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/CloudStorage", isDirectory: true)
        guard let children = try? FileManager.default.contentsOfDirectory(
            at: cloudStorage,
            includingPropertiesForKeys: nil
        ) else { return nil }
        return children
            .filter { $0.lastPathComponent.lowercased().hasPrefix("onedrive") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .first
    }

    private func serviceIsHealthy() -> Bool {
        var request = URLRequest(url: serviceURL.appendingPathComponent("health"))
        request.timeoutInterval = 0.6
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            healthy = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1)
        return healthy
    }

    private var dataDirectory: URL {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AIKnowledgeInbox", isDirectory: true)
    }

    private func loadAuthToken() throws -> String {
        let tokenURL = dataDirectory.appendingPathComponent("auth-token")
        let token = try String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw CompanionError.message("The local service authentication token is invalid.")
        }
        return token
    }

    private func randomNonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard result == errSecSuccess else {
            throw CompanionError.message("Could not generate an authentication nonce.")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private func proofBytes(_ value: String) -> [UInt8]? {
        guard value.count == 64 else { return nil }
        var result: [UInt8] = []
        var index = value.startIndex
        while index < value.endIndex {
            let end = value.index(index, offsetBy: 2)
            guard let byte = UInt8(value[index..<end], radix: 16) else { return nil }
            result.append(byte)
            index = end
        }
        return result
    }

    private func fixedTimeEqual(_ left: [UInt8], _ right: [UInt8]) -> Bool {
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    private func invalidateServiceProof() {
        proofValidUntil = .distantPast
        proofToken = ""
    }

    private func verifyServiceIdentity() throws {
        do {
            let token = try loadAuthToken()
            if token == proofToken && Date() < proofValidUntil { return }
            invalidateServiceProof()
            let domain = "AIKnowledgeInbox.LocalAPI.AuthChallenge"
            let protocolVersion = 1
            let nonce = try randomNonce()
            var request = URLRequest(url: serviceURL.appendingPathComponent("auth/challenge"))
            request.httpMethod = "POST"
            request.timeoutInterval = 3
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "protocol": protocolVersion,
                "nonce": nonce
            ])

            let semaphore = DispatchSemaphore(value: 0)
            var responseData: Data?
            var responseStatus = 0
            URLSession.shared.dataTask(with: request) { data, response, _ in
                responseData = data
                responseStatus = (response as? HTTPURLResponse)?.statusCode ?? 0
                semaphore.signal()
            }.resume()
            guard semaphore.wait(timeout: .now() + 4) == .success,
                  responseStatus == 200,
                  let responseData,
                  let challenge = try? JSONDecoder().decode(
                    AuthenticationChallenge.self,
                    from: responseData
                  ),
                  challenge.domain == domain,
                  challenge.protocolVersion == protocolVersion,
                  challenge.nonce == nonce,
                  let supplied = proofBytes(challenge.proof)
            else {
                throw CompanionError.message("Invalid authentication challenge.")
            }
            let message = "\(domain)\n\(protocolVersion)\n\(nonce)"
            let key = SymmetricKey(data: Data(token.utf8))
            let expected = Array(HMAC<SHA256>.authenticationCode(
                for: Data(message.utf8),
                using: key
            ))
            guard fixedTimeEqual(expected, supplied) else {
                throw CompanionError.message("Authentication challenge did not match.")
            }
            proofValidUntil = Date().addingTimeInterval(15)
            proofToken = token
        } catch {
            invalidateServiceProof()
            throw CompanionError.message(
                "SECURITY ERROR: The desktop service identity could not be verified. No credential was sent. Stop and restart the companion."
            )
        }
    }

    private func authorizedRequest(path: String, method: String = "GET") throws -> URLRequest {
        try verifyServiceIdentity()
        let token = try loadAuthToken()
        var request = URLRequest(url: serviceURL.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    @objc private func showPairingCode() {
        do {
            let request = try authorizedRequest(path: "pairing/code", method: "POST")
            URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    if let error {
                        self?.invalidateServiceProof()
                        self?.showError(error.localizedDescription)
                        return
                    }
                    guard (response as? HTTPURLResponse)?.statusCode == 201,
                          let data,
                          let result = try? JSONDecoder().decode(PairingResult.self, from: data)
                    else {
                        self?.invalidateServiceProof()
                        self?.showError("Could not generate a pairing code.")
                        return
                    }
                    let alert = NSAlert()
                    alert.messageText = "Pair Browser Extension"
                    alert.informativeText = "Enter this one-time code in the extension popup:\n\n\(result.code)\n\nIt expires in 5 minutes."
                    alert.runModal()
                }
            }.resume()
        } catch {
            showError(error.localizedDescription)
        }
    }

    @objc private func saveDiagnostics() {
        do {
            let request = try authorizedRequest(path: "diagnostics")
            URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
                DispatchQueue.main.async {
                    if let error {
                        self?.invalidateServiceProof()
                        self?.showError(error.localizedDescription)
                        return
                    }
                    guard (response as? HTTPURLResponse)?.statusCode == 200, let data else {
                        self?.invalidateServiceProof()
                        self?.showError("Could not export diagnostics.")
                        return
                    }
                    let panel = NSSavePanel()
                    panel.nameFieldStringValue = "ai-knowledge-inbox-diagnostics.json"
                    panel.allowedContentTypes = [.json]
                    if panel.runModal() == .OK, let url = panel.url {
                        do { try data.write(to: url, options: .atomic) }
                        catch { self?.showError(error.localizedDescription) }
                    }
                }
            }.resume()
        } catch {
            showError(error.localizedDescription)
        }
    }

    @objc private func showCapture() {
        guard captureWindow == nil else {
            captureWindow?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let text = NSPasteboard.general.string(forType: .string)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            notify(title: "Nothing to save", text: "Copy text in an AI app first.")
            return
        }

        let controller = CaptureWindowController(content: text) { [weak self] payload in
            self?.save(payload: payload)
        }
        captureController = controller
        captureWindow = controller.window
        captureWindow?.delegate = self
        captureWindow?.center()
        captureWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        captureWindow = nil
        captureController = nil
    }

    private func save(payload: EntryPayload) {
        guard let body = try? JSONEncoder().encode(payload) else { return }
        guard var request = try? authorizedRequest(path: "entries", method: "POST") else {
            showError("The local service authentication token is unavailable.")
            return
        }
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                if let error {
                    self?.invalidateServiceProof()
                    self?.showError(error.localizedDescription)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if !(200..<300).contains(status) {
                    self?.invalidateServiceProof()
                    let message = data.flatMap { try? JSONDecoder().decode(APIError.self, from: $0).error }
                        ?? "Save failed."
                    self?.showError(message)
                    return
                }
                self?.captureWindow?.close()
                self?.notify(title: "Saved", text: "Clipboard content was added to your library.")
            }
        }.resume()
    }

    @objc private func openDataFolder() {
        let url = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AIKnowledgeInbox", isDirectory: true)
        NSWorkspace.shared.open(url)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func notify(title: String, text: String) {
        let notification = NSUserNotification()
        notification.title = title
        notification.informativeText = text
        NSUserNotificationCenter.default.deliver(notification)
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "AI Knowledge Companion"
        alert.informativeText = message
        alert.runModal()
    }
}

final class CaptureWindowController: NSWindowController {
    private let titleField = NSTextField()
    private let contentView = NSTextView()
    private let projectField = NSTextField()
    private let tagsField = NSTextField()
    private let saveHandler: (EntryPayload) -> Void

    init(content: String, saveHandler: @escaping (EntryPayload) -> Void) {
        self.saveHandler = saveHandler
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 650),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.09, blue: 0.17, alpha: 1)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        buildUI(content: content)
    }

    required init?(coder: NSCoder) { nil }

    private func buildUI(content: String) {
        guard let root = window?.contentView else { return }
        let accent = NSColor(calibratedRed: 0.32, green: 0.85, blue: 0.95, alpha: 1)
        let link = NSColor(calibratedRed: 0.66, green: 0.62, blue: 0.97, alpha: 1)
        let text = NSColor(calibratedRed: 0.97, green: 0.98, blue: 1, alpha: 1)
        let muted = NSColor(calibratedRed: 0.68, green: 0.77, blue: 0.87, alpha: 1)
        let surface = NSColor(calibratedRed: 0.07, green: 0.15, blue: 0.26, alpha: 1)

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 26, left: 28, bottom: 24, right: 28)
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: root.topAnchor),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor)
        ])

        let system = label("CAPTURE NODE // COPILOT CLIPBOARD", size: 11, color: link, mono: true)
        let heading = label("Save to AI Knowledge Inbox", size: 25, color: text, weight: .semibold)
        let subtitle = label("Review the clipboard content before committing it to your library.", size: 13, color: muted)
        stack.addArrangedSubview(system)
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(subtitle)

        let divider = NSBox()
        divider.boxType = .separator
        divider.borderColor = accent
        stack.addArrangedSubview(divider)

        titleField.stringValue = content.split(separator: "\n").first.map(String.init) ?? "Untitled knowledge"
        titleField.placeholderString = "Title"
        styleField(titleField, surface: surface, text: text)
        stack.addArrangedSubview(fieldGroup("TITLE", control: titleField, color: muted))

        contentView.string = content
        contentView.font = NSFont.systemFont(ofSize: 14)
        contentView.textColor = text
        contentView.backgroundColor = NSColor(calibratedRed: 0.05, green: 0.13, blue: 0.23, alpha: 1)
        contentView.isRichText = false
        contentView.textContainerInset = NSSize(width: 10, height: 10)
        let scroll = NSScrollView()
        scroll.documentView = contentView
        scroll.hasVerticalScroller = true
        scroll.borderType = .lineBorder
        scroll.heightAnchor.constraint(equalToConstant: 300).isActive = true
        stack.addArrangedSubview(fieldGroup("CONTENT", control: scroll, color: muted))

        let metadata = NSStackView()
        metadata.orientation = .horizontal
        metadata.spacing = 12
        styleField(projectField, surface: surface, text: text)
        styleField(tagsField, surface: surface, text: text)
        projectField.placeholderString = "Project"
        tagsField.placeholderString = "Tags, comma separated"
        metadata.addArrangedSubview(fieldGroup("PROJECT", control: projectField, color: muted))
        metadata.addArrangedSubview(fieldGroup("TAGS", control: tagsField, color: muted))
        metadata.distribution = .fillEqually
        stack.addArrangedSubview(metadata)

        let footer = NSStackView()
        footer.orientation = .horizontal
        let status = label(
            "SYSTEM ONLINE // SQLITE LOCAL // ONEDRIVE SYNC",
            size: 11,
            color: NSColor(calibratedRed: 0.39, green: 0.90, blue: 0.77, alpha: 1),
            mono: true
        )
        let spacer = NSView()
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        let save = NSButton(title: "Save to Library", target: self, action: #selector(save))
        save.bezelColor = accent
        footer.addArrangedSubview(status)
        footer.addArrangedSubview(spacer)
        footer.addArrangedSubview(cancel)
        footer.addArrangedSubview(save)
        stack.addArrangedSubview(footer)
    }

    private func label(
        _ value: String,
        size: CGFloat,
        color: NSColor,
        weight: NSFont.Weight = .regular,
        mono: Bool = false
    ) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.textColor = color
        field.font = mono
            ? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
            : NSFont.systemFont(ofSize: size, weight: weight)
        return field
    }

    private func styleField(_ field: NSTextField, surface: NSColor, text: NSColor) {
        field.isBezeled = true
        field.bezelStyle = .squareBezel
        field.drawsBackground = true
        field.backgroundColor = surface
        field.textColor = text
        field.font = NSFont.systemFont(ofSize: 14)
    }

    private func fieldGroup(_ title: String, control: NSView, color: NSColor) -> NSView {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 6
        stack.addArrangedSubview(label(title, size: 11, color: color, weight: .bold, mono: true))
        stack.addArrangedSubview(control)
        return stack
    }

    @objc private func cancel() { window?.close() }

    @objc private func save() {
        let content = contentView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { NSSound.beep(); return }
        let tags = tagsField.stringValue
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        saveHandler(EntryPayload(
            title: titleField.stringValue,
            content: content,
            source: "https://copilot.microsoft.com/",
            project: projectField.stringValue,
            tags: tags
        ))
    }
}

struct EntryPayload: Codable {
    let title: String
    let content: String
    let source: String
    let project: String
    let tags: [String]
}

struct APIError: Codable { let error: String }
struct PairingResult: Codable { let code: String }
struct AuthenticationChallenge: Codable {
    let domain: String
    let protocolVersion: Int
    let nonce: String
    let proof: String

    enum CodingKeys: String, CodingKey {
        case domain, nonce, proof
        case protocolVersion = "protocol"
    }
}

enum CompanionError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let value): return value }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
