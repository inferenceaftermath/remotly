// Photos attached to the composer: taken with the camera or picked from the library, downscaled on the
// phone, uploaded to the bridge at once, and appended to the next message as file paths the program in
// the pane reads (protocol §2 "Uploads"). Works the same for Claude Code, Codex and pi.
import FlowKit
import ImageIO
import PhotosUI
import SwiftUI
import UIKit

@MainActor
@Observable
final class Attachment: Identifiable {
    enum State: Equatable {
        case uploading
        case uploaded(path: String)
        case failed(String)
    }

    let id = UUID()
    let thumbnail: UIImage
    let jpeg: Data
    var state: State = .uploading

    init(thumbnail: UIImage, jpeg: Data) {
        self.thumbnail = thumbnail
        self.jpeg = jpeg
    }

    /// The path on the host once the bridge has stored the photo.
    var path: String? {
        if case .uploaded(let path) = state { return path }
        return nil
    }
}

// @MainActor: builds `Attachment`s (main-actor objects) and is only ever called from the composer.
@MainActor
enum ImagePrep {
    /// Long-edge cap: about what the models see anyway, and a few hundred KB instead of several MB.
    static let maxEdge: CGFloat = 1568
    static let quality: CGFloat = 0.85
    static let thumbnailEdge: CGFloat = 112

    /// Photo-library data (HEIC, JPEG, PNG …) → JPEG at most `maxEdge` on the long side, orientation baked in, metadata dropped.
    static func attachment(from data: Data) -> Attachment? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return attachment(from: UIImage(cgImage: cgImage))
    }

    /// A camera capture (already oriented by UIKit when drawn) → the same JPEG.
    static func attachment(from image: UIImage) -> Attachment? {
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        guard pixelWidth > 0, pixelHeight > 0 else { return nil }
        let factor = min(1, maxEdge / max(pixelWidth, pixelHeight))
        let target = CGSize(width: floor(pixelWidth * factor), height: floor(pixelHeight * factor))
        guard let jpeg = render(image, into: target).jpegData(compressionQuality: quality) else { return nil }
        return Attachment(thumbnail: square(image, edge: thumbnailEdge), jpeg: jpeg)
    }

    /// Redraw at `size` in pixels on white (JPEG has no alpha), which also bakes the orientation in.
    private static func render(_ image: UIImage, into size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// Centre-cropped square for the chip.
    private static func square(_ image: UIImage, edge: CGFloat) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let side = min(image.size.width, image.size.height)
        let scale = edge / max(side, 1)
        let drawSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let origin = CGPoint(x: (edge - drawSize.width) / 2, y: (edge - drawSize.height) / 2)
        return UIGraphicsImageRenderer(size: CGSize(width: edge, height: edge), format: format).image { _ in
            image.draw(in: CGRect(origin: origin, size: drawSize))
        }
    }
}

/// The system camera; `onImage(nil)` on cancel.
struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onImage: onImage) }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImage: (UIImage?) -> Void

        init(onImage: @escaping (UIImage?) -> Void) {
            self.onImage = onImage
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onImage(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onImage(nil)
        }
    }
}

/// Thumbnails above the composer: a spinner while uploading, a red retry face after a failure, ✕ to drop.
struct AttachmentChips: View {
    let attachments: [Attachment]
    let onRemove: (Attachment) -> Void
    let onRetry: (Attachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: attachment.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay { overlay(for: attachment) }
                            .onTapGesture { if case .failed = attachment.state { onRetry(attachment) } }
                            .accessibilityLabel(label(for: attachment))
                        Button { onRemove(attachment) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.body)
                                .foregroundStyle(.white, .black.opacity(0.65))
                        }
                        .offset(x: 7, y: -7)
                        .accessibilityLabel("Remove photo")
                    }
                    .padding(.top, 7)
                    .padding(.trailing, 7)
                }
            }
            .padding(.horizontal, 10)
        }
    }

    @ViewBuilder
    private func overlay(for attachment: Attachment) -> some View {
        switch attachment.state {
        case .uploading:
            ZStack {
                Color.black.opacity(0.35)
                ProgressView().tint(.white)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .failed:
            ZStack {
                Color.red.opacity(0.45)
                Image(systemName: "arrow.clockwise").foregroundStyle(.white)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .uploaded:
            EmptyView()
        }
    }

    private func label(for attachment: Attachment) -> String {
        switch attachment.state {
        case .uploading: return "Photo, uploading"
        case .uploaded: return "Photo, ready to send"
        case .failed(let message): return "Photo, upload failed: \(message). Tap to retry"
        }
    }
}
