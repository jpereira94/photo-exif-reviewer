// Auxiliar para o framework Vision do macOS: lê caminhos de imagens do stdin
// (um por linha) e escreve no stdout uma linha JSON por imagem com o vetor de
// características e as medidas de qualidade. O modelo é o do sistema — não há
// nada a descarregar.
import Foundation
import Vision

struct Medidas {
    var data: String?
    var revision = 0
    var aesthetics: Float?
    var isUtility: Bool?
    var faces: [Float] = []
    var horizon: Float?
    var saliency: CGRect?
}

func analisar(_ path: String) -> Medidas {
    var medidas = Medidas()
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])

    let feature = VNGenerateImageFeaturePrintRequest()
    // Quadrado do centro: sem isto, a mesma cena fotografada na horizontal e na
    // vertical dá vetores muito afastados. Só se aplica ao vetor de semelhança —
    // os restantes pedidos precisam da imagem inteira.
    feature.imageCropAndScaleOption = .centerCrop
    let faces = VNDetectFaceCaptureQualityRequest()
    let horizon = VNDetectHorizonRequest()
    let saliency = VNGenerateAttentionBasedSaliencyImageRequest()

    var pedidos: [VNRequest] = [feature, faces, horizon, saliency]

    // A estética só existe a partir do macOS 15; sem ela a app usa as restantes.
    var aesthetics: VNRequest?

    if #available(macOS 15.0, *) {
        let request = VNCalculateImageAestheticsScoresRequest()
        aesthetics = request
        pedidos.append(request)
    }

    // Um pedido que falhe não deve levar os outros atrás.
    for pedido in pedidos {
        try? handler.perform([pedido])
    }

    if let observation = feature.results?.first as? VNFeaturePrintObservation, observation.elementType == .float {
        medidas.data = observation.data.base64EncodedString()
        medidas.revision = observation.requestRevision
    }

    medidas.faces = (faces.results ?? []).compactMap { $0.faceCaptureQuality }
    if let observation = horizon.results?.first as VNHorizonObservation? {
        medidas.horizon = Float(observation.angle)
    }
    medidas.saliency = (saliency.results?.first as? VNSaliencyImageObservation)?
        .salientObjects?
        .max(by: { $0.confidence < $1.confidence })?
        .boundingBox

    if #available(macOS 15.0, *),
       let request = aesthetics as? VNCalculateImageAestheticsScoresRequest,
       let observation = request.results?.first {
        medidas.aesthetics = observation.overallScore
        medidas.isUtility = observation.isUtility
    }

    return medidas
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let paths = (String(data: input, encoding: .utf8) ?? "")
    .split(separator: "\n")
    .map(String.init)
    .filter { !$0.isEmpty }

guard !paths.isEmpty else { exit(0) }

var todas = [Medidas?](repeating: nil, count: paths.count)
let lock = NSLock()

// As Neural Engine/GPU dão conta de vários pedidos ao mesmo tempo.
DispatchQueue.concurrentPerform(iterations: paths.count) { index in
    let medidas = analisar(paths[index])
    lock.lock()
    todas[index] = medidas
    lock.unlock()
}

func json(_ value: Any) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
    let text = String(data: data ?? Data(), encoding: .utf8) ?? "[null]"
    return String(text.dropFirst().dropLast())
}

func numero(_ value: Float?) -> String {
    guard let value, value.isFinite else { return "null" }
    return String(value)
}

var out = ""

for (index, path) in paths.enumerated() {
    guard let m = todas[index], let data = m.data else {
        out += "{\"path\":\(json(path)),\"error\":\"sem vetor de caracteristicas\"}\n"
        continue
    }

    var campos = [
        "\"path\":\(json(path))",
        "\"revision\":\(m.revision)",
        "\"data\":\"\(data)\"",
        "\"aesthetics\":\(numero(m.aesthetics))",
        "\"isUtility\":\(m.isUtility.map { $0 ? "true" : "false" } ?? "null")",
        "\"faces\":[\(m.faces.map { String($0) }.joined(separator: ","))]",
        "\"horizon\":\(numero(m.horizon))"
    ]

    if let s = m.saliency {
        campos.append("\"saliency\":{\"x\":\(s.origin.x),\"y\":\(s.origin.y),\"w\":\(s.width),\"h\":\(s.height)}")
    } else {
        campos.append("\"saliency\":null")
    }

    out += "{\(campos.joined(separator: ","))}\n"
}

FileHandle.standardOutput.write(out.data(using: .utf8)!)
