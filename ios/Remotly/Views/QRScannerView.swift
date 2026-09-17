// Camera QR scanner (AVCaptureSession + AVCaptureMetadataOutput). Shows a hint instead of a preview
// when no camera is available (Simulator) or access is denied.
import AVFoundation
import SwiftUI
import UIKit

@MainActor
struct QRScannerView: UIViewRepresentable {
    var onCode: @MainActor (String) -> Void

    func makeUIView(context: Context) -> QRPreviewView {
        let view = QRPreviewView()
        view.onCode = onCode
        view.start()
        return view
    }

    func updateUIView(_ uiView: QRPreviewView, context: Context) {
        uiView.onCode = onCode
    }

    static func dismantleUIView(_ uiView: QRPreviewView, coordinator: ()) {
        uiView.stop()
    }
}

final class QRPreviewView: UIView {
    var onCode: (@MainActor (String) -> Void)?
    private let scanner = QRScanner()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let hint = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        backgroundColor = UIColor(rgb: 0x0B0C0E) // DesignTokens.bg
        hint.textColor = UIColor(rgb: 0xB4B9C0) // DesignTokens.fg2
        hint.textAlignment = .center
        hint.numberOfLines = 0
        hint.font = .systemFont(ofSize: 15)
        hint.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hint)
        NSLayoutConstraint.activate([
            hint.centerXAnchor.constraint(equalTo: centerXAnchor),
            hint.centerYAnchor.constraint(equalTo: centerYAnchor),
            hint.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
            trailingAnchor.constraint(greaterThanOrEqualTo: hint.trailingAnchor, constant: 16),
        ])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = bounds
    }

    func start() {
        scanner.onCode = { [weak self] code in
            Task { @MainActor in self?.onCode?(code) }
        }
        Task {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            guard granted else {
                self.hint.text = "Camera access is off. Allow it in Settings, or enter the details manually."
                return
            }
            guard self.scanner.prepare() else {
                self.hint.text = "No camera available. Use “Enter code”."
                return
            }
            let preview = AVCaptureVideoPreviewLayer(session: self.scanner.session)
            preview.videoGravity = .resizeAspectFill
            preview.frame = self.bounds
            self.layer.insertSublayer(preview, at: 0)
            self.previewLayer = preview
            self.hint.text = nil
            self.scanner.start()
        }
    }

    func stop() { scanner.stop() }
}

/// Owns the capture session; configured and run on a private queue.
final class QRScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    var onCode: (@Sendable (String) -> Void)?
    private let queue = DispatchQueue(label: "com.inferenceaftermath.remotly.qr")
    private var prepared = false

    /// Adds the camera input and QR metadata output. Returns false when no camera exists.
    func prepare() -> Bool {
        if prepared { return true }
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return false }
        session.beginConfiguration()
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return false
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: queue)
        output.metadataObjectTypes = [.qr]
        session.commitConfiguration()
        prepared = true
        return true
    }

    func start() {
        queue.async { [self] in
            if prepared, !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else { return }
        onCode?(value)
    }
}
