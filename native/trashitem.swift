// Move ficheiros para o Lixo e diz onde ficaram. É esse caminho que torna o
// "anular" possível: o macOS renomeia em caso de colisão, e nem o macos-trash
// nem o comando do sistema devolvem o nome final.
import Foundation

let input = FileHandle.standardInput.readDataToEndOfFile()
let paths = (String(data: input, encoding: .utf8) ?? "")
    .split(separator: "\n")
    .map(String.init)
    .filter { !$0.isEmpty }

guard !paths.isEmpty else { exit(0) }

func json(_ value: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
    let texto = String(data: data ?? Data(), encoding: .utf8) ?? "[\"\"]"
    return String(texto.dropFirst().dropLast())
}

var saida = ""

for path in paths {
    var destino: NSURL?

    do {
        try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &destino)
    } catch {
        saida += "{\"path\":\(json(path)),\"error\":\(json(error.localizedDescription))}\n"
        continue
    }

    if let caminho = (destino as URL?)?.path {
        saida += "{\"path\":\(json(path)),\"trashed\":\(json(caminho))}\n"
    } else {
        // Foi para o Lixo, mas sem destino conhecido não se pode anular.
        saida += "{\"path\":\(json(path)),\"trashed\":null}\n"
    }
}

FileHandle.standardOutput.write(saida.data(using: .utf8)!)
