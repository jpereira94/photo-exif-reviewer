// Janela nativa em WKWebView que arranca o servidor Node incluído no pacote.
// Usa o WebKit do sistema, por isso não há um segundo motor de browser a bordo.
import Cocoa
import WebKit

// Deixar o sistema escolher uma porta livre e libertá-la logo a seguir. Fica uma
// janela minúscula em que outro processo a poderia tomar, mas evita ter de
// adivinhar portas ou falhar quando a 4173 está ocupada.
func portaLivre() -> UInt16? {
    let descritor = socket(AF_INET, SOCK_STREAM, 0)
    guard descritor >= 0 else { return nil }
    defer { close(descritor) }

    var endereco = sockaddr_in()
    endereco.sin_family = sa_family_t(AF_INET)
    endereco.sin_port = 0
    endereco.sin_addr.s_addr = inet_addr("127.0.0.1")

    let tamanho = socklen_t(MemoryLayout<sockaddr_in>.size)
    let ligado = withUnsafePointer(to: &endereco) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descritor, $0, tamanho) }
    }
    guard ligado == 0 else { return nil }

    var atribuido = sockaddr_in()
    var tamanhoAtribuido = socklen_t(MemoryLayout<sockaddr_in>.size)
    let lido = withUnsafeMutablePointer(to: &atribuido) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(descritor, $0, &tamanhoAtribuido) }
    }
    guard lido == 0 else { return nil }

    return UInt16(bigEndian: atribuido.sin_port)
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private var janela: NSWindow!
    private var webView: WKWebView!
    private var servidor: Process?
    private var porta: UInt16 = 0
    private let recursos = Bundle.main.resourceURL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        construirMenu()
        construirJanela()

        guard let porta = portaLivre() else {
            falhar("Não foi possível reservar uma porta local.")
            return
        }

        self.porta = porta
        arrancarServidor(porta: porta)
        esperarServidor(porta: porta, tentativasRestantes: 100)
    }

    // MARK: - Interface

    private func construirJanela() {
        let configuracao = WKWebViewConfiguration()
        // Ponte para o seletor de pastas nativo: evita depender do osascript, que
        // numa app empacotada abre a caixa atrás da janela e pede permissões.
        configuracao.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chooseFolder")

        webView = WKWebView(frame: .zero, configuration: configuracao)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        janela = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        janela.title = "Photo EXIF Reviewer"
        janela.contentView = webView
        janela.minSize = NSSize(width: 900, height: 640)
        janela.setFrameAutosaveName("PhotoReviewerWindow")
        janela.center()
        janela.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func construirMenu() {
        let barra = NSMenu()

        let itemApp = NSMenuItem()
        let menuApp = NSMenu()
        menuApp.addItem(withTitle: "Acerca do Photo EXIF Reviewer", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        menuApp.addItem(.separator())
        menuApp.addItem(withTitle: "Esconder", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        menuApp.addItem(.separator())
        menuApp.addItem(withTitle: "Sair", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        itemApp.submenu = menuApp
        barra.addItem(itemApp)

        let itemVer = NSMenuItem()
        let menuVer = NSMenu(title: "Ver")
        menuVer.addItem(withTitle: "Recarregar", action: #selector(recarregar), keyEquivalent: "r")
        menuVer.addItem(.separator())
        menuVer.addItem(withTitle: "Ecrã completo", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        itemVer.submenu = menuVer
        barra.addItem(itemVer)

        // Sem um menu Editar as teclas de cópia e colagem não chegam ao WebView.
        let itemEditar = NSMenuItem()
        let menuEditar = NSMenu(title: "Editar")
        menuEditar.addItem(withTitle: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        menuEditar.addItem(withTitle: "Colar", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menuEditar.addItem(withTitle: "Selecionar tudo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        itemEditar.submenu = menuEditar
        barra.addItem(itemEditar)

        NSApp.mainMenu = barra
    }

    @objc private func recarregar() {
        webView.reload()
    }

    private func falhar(_ mensagem: String) {
        let alerta = NSAlert()
        alerta.messageText = "Photo EXIF Reviewer não conseguiu arrancar"
        alerta.informativeText = mensagem
        alerta.alertStyle = .critical
        alerta.runModal()
        NSApp.terminate(nil)
    }

    // MARK: - Servidor

    private func arrancarServidor(porta: UInt16) {
        let node = recursos.appendingPathComponent("node")
        let servidorJS = recursos.appendingPathComponent("app/server.js")

        let processo = Process()
        processo.executableURL = node
        processo.arguments = [servidorJS.path]
        processo.currentDirectoryURL = recursos.appendingPathComponent("app")

        var ambiente = ProcessInfo.processInfo.environment
        ambiente["PORT"] = String(porta)
        // O exiftool-vendored lança o perl do sistema; garantir que o encontra
        // mesmo sem o PATH do shell, que uma app lançada pelo Finder não herda.
        ambiente["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        processo.environment = ambiente

        do {
            try processo.run()
            servidor = processo
        } catch {
            falhar("Não foi possível arrancar o servidor incluído: \(error.localizedDescription)")
        }
    }

    private func esperarServidor(porta: UInt16, tentativasRestantes: Int) {
        guard tentativasRestantes > 0 else {
            falhar("O servidor incluído não respondeu a tempo.")
            return
        }

        if servidor?.isRunning == false {
            falhar("O servidor incluído terminou inesperadamente.")
            return
        }

        var pedido = URLRequest(url: URL(string: "http://127.0.0.1:\(porta)/api/status")!)
        pedido.timeoutInterval = 1

        URLSession.shared.dataTask(with: pedido) { _, resposta, _ in
            DispatchQueue.main.async {
                if (resposta as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(porta)/")!))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        self.esperarServidor(porta: porta, tentativasRestantes: tentativasRestantes - 1)
                    }
                }
            }
        }.resume()
    }

    // MARK: - Ponte do seletor de pastas

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.name == "chooseFolder" else {
            replyHandler(nil, "pedido desconhecido")
            return
        }

        let painel = NSOpenPanel()
        painel.canChooseDirectories = true
        painel.canChooseFiles = false
        painel.allowsMultipleSelection = false
        painel.prompt = "Escolher"
        painel.message = "Escolhe a pasta com as fotografias"

        painel.beginSheetModal(for: janela) { resposta in
            // Cancelar devolve nulo, e o lado JS trata isso como "não fazer nada".
            replyHandler(resposta == .OK ? painel.url?.path : nil, nil)
        }
    }

    // MARK: - Ciclo de vida

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let servidor, servidor.isRunning else { return }

        // SIGTERM para o server.js fechar o exiftool antes de sair; se não sair
        // em meio segundo, mata-se para não deixar processos órfãos.
        kill(servidor.processIdentifier, SIGTERM)

        let limite = Date().addingTimeInterval(0.5)
        while servidor.isRunning && Date() < limite {
            usleep(20_000)
        }

        if servidor.isRunning {
            servidor.terminate()
        }
    }
}

let aplicacao = NSApplication.shared
let delegado = AppDelegate()
aplicacao.delegate = delegado
aplicacao.setActivationPolicy(.regular)
aplicacao.run()
