# Pi Auto-Approval

Jede Agent-Aktion wird von einem unabhängigen Modell geprüft. Genehmigte Aktionen laufen anschließend in einer separaten Sandbox. Direkte Tools, `!`/`!!`, verschachtelte Tool-Aufrufe und ein lokaler Ausführungs-Fallback sind gesperrt.

## Start und Status

Nach Änderungen an der Erweiterung Pi neu starten. `/auto-approval` zeigt Reviewer, Sandbox-Backend, Arbeitsverzeichnis, erkannten Workspace und den vollständigen Konfigurationspfad.

Technische Fehler vor der unabhängigen Prüfung nennen die fehlgeschlagene Vorprüfungsstufe. Die Modellanzeige bleibt dabei `—`, da noch kein Reviewer aufgerufen wurde. Websuche und Seitenabruf verwenden ein leeres, schreibgeschütztes Sandbox-Arbeitsverzeichnis ohne Projekt-Mounts oder Projektprüfung. Sie benötigen keine alten Skill-Dateien; privates Session-`/tmp`, Ressourcenprüfung und unabhängige Netzwerkfreigabe bleiben aktiv.

`~/.pi/agent/auto-approval.json` wird im öffentlichen Dotfiles-Repository synchronisiert. Sie enthält Modell, Prüfeinstellungen und Sandbox-Backend, aber keine Gerätepfade oder Workspace-Freigaben. Optionale lokale Pfade und Freigaben stehen in `auto-approval.device.json`; diese Datei bleibt von Git ausgeschlossen. Bei einem anderen `PI_CODING_AGENT_DIR` liegen beide Dateien dort. Sie werden bei jeder Aktion neu gelesen.

`reviewers` enthält die Prüfmodelle in Prioritätsreihenfolge. Zuerst wird `openai` mit Modell-ID `gpt-6-luna` verwendet, danach der ausdrücklich konfigurierte Fallback `openrouter` mit `openai/gpt-6-luna`. Nur die Einträge dieser Liste werden versucht, unabhängig vom Hauptmodell. Fehlende Anmeldung, fehlende Modelle, nicht unterstützte Thinking-Level, Transportfehler und Zeitüberschreitungen erlauben den nächsten Versuch. Eine gültige Ablehnung beendet die Prüfkette. Safety-Refusals sowie abgeschnittene oder abgebrochene Modellantworten sperren die Aktion ebenfalls ohne weiteren Modellversuch. Ein vollständiges, zur Anfrage gehörendes `deny` bleibt auch dann bindend, wenn der Provider danach einen Transportfehler meldet. Provider-Fehler werden mit festen Diagnosekategorien angezeigt; rohe Fehlermeldungen mit möglichen Zugangsdaten oder Prompt-Inhalten werden nicht ausgegeben. Ungültige oder einer anderen Anfrage zugeordnete Urteile sperren die Aktion ohne Fallback. Zugangsdaten bleiben privat; `/login` richtet den jeweiligen Anbieter pro Rechner ein.

## Bis zum bestätigten Ziel weiterarbeiten

`/goal <Ziel>` startet das aktuelle Arbeitsmodell mit einem konkreten Ziel. Sobald das Modell seine Antwort beendet, prüft das konfigurierte Prüfmodell die Zielerfüllung anhand der Antwort und der protokollierten Ergebnisse genehmigter Aktionen. Eine bloße Behauptung des Arbeitsmodells genügt bei Codeänderungen und Laufzeitprüfungen nicht.

Das Ziel erscheint unten in der Statusleiste, auch während der Abschlussprüfung und bei pausierten Zielen. Es steht vor dem Approval-Status, damit dieser es auf schmalen Terminals nicht verdrängt. Lange oder mehrzeilige Ziele werden für die Anzeige gekürzt und auf eine Zeile gebracht; `/goal status` zeigt den vollständigen Text. Beim Session-Wechsel oder Beenden wird die Anzeige entfernt und anschließend gegebenenfalls aus der gewählten Session wiederhergestellt.

Fehlt noch Arbeit, erhält das Arbeitsmodell die Begründung und setzt automatisch fort. Erst ein positives Prüferegebnis markiert das Ziel als erfüllt. Eine negative Zielprüfung wechselt nicht zum nächsten Prüfmodell; Fallbacks gelten weiterhin ausschließlich für technische Nichtverfügbarkeit. Jede Aktion bleibt separat genehmigungspflichtig und läuft in der Sandbox.

- `/goal` oder `/goal status` zeigt Ziel, Zustand, Begründung und Anzahl der Prüfungen.
- `/goal resume` setzt ein pausiertes Ziel fort.
- `/goal stop` ist der ausdrückliche Betreiberabbruch und behauptet keine Zielerfüllung. Auch Escape, Ctrl+C und Beenden bleiben möglich.

Beim Fortsetzen erhält das Arbeitsmodell das gespeicherte Ziel und die zuletzt gültige Rückmeldung der unabhängigen Zielprüfung. Pausengründe und Bedienhinweise wie `/goal resume` bleiben Statusinformationen für den Betreiber. Während ein Ziel läuft, enthält jede Modellanfrage genau eine aktuelle Goal-Steuernachricht; ältere Steuernachrichten werden nur aus diesem Anfragekontext entfernt. Der gespeicherte Verlauf, echte Nutzertexte und Nachrichten anderer Erweiterungen bleiben erhalten. Das gilt auch für bereits vorhandene Sessions.

Prüfausfälle, ungültige Urteile und unterbrochene Modellläufe pausieren das Ziel. Nach einem Neustart, Neuladen oder Session-Wechsel wird ein gespeichertes, unerfülltes Ziel ebenfalls pausiert wiederhergestellt. Es startet erst mit `/goal resume` erneut; das private `/tmp` wurde beim Session-Shutdown gelöscht. Eine Navigation im Session-Baum übernimmt den Zielzustand des gewählten Zweigs ohne automatischen Neustart.

Ziel, Prüfversuche, Entscheidungsmodell, Request-ID, Evidence-Fingerprint und Verbrauch werden im Session-Protokoll gespeichert. Die ursprüngliche `/goal`-Anweisung bleibt den Aktionsprüfern als Nutzerauftrag erhalten, auch wenn weitere Modellrunden keinen neuen Nutzerprompt haben. Spätere Nutzerkorrekturen gelten weiterhin. Es gibt keine feste Rundenzahl oder Laufzeitgrenze für ein Ziel; bis zur Bestätigung oder Unterbrechung können laufend Modellkosten entstehen.

## Korrekturen während der Arbeit

Eine als Steering eingereihte Nutzernachricht ergänzt die laufende Aufgabe. Das Modell erhält danach bei jeder Anfrage den Hinweis, die Korrektur einzuarbeiten und anschließend die noch offene Hauptarbeit samt Validierung fortzusetzen. Bei normalen Aufgaben wird der ursprüngliche Auftrag als zitierter Text mit höchstens 4.000 Zeichen erinnert; längere Aufträge werden ausdrücklich als Ausschnitt gekennzeichnet. Bei `/goal` bleibt dessen gespeichertes Ziel maßgeblich.

Die tatsächliche Nutzernachricht und ihr gespeicherter Verlauf bleiben unverändert. Der Hinweis erscheint einmal im Modellkontext, wird nicht als zusätzliche Nutzernachricht gespeichert und erteilt keine Tool-Freigabe. Er gilt nur für den laufenden Auftrag und wird bei einer neuen Aufgabe oder einem Session-Wechsel zurückgesetzt. Ein ausdrücklicher Abbruch oder Aufgabenwechsel bleibt möglich. Follow-up-Nachrichten werden nicht automatisch als Steering behandelt.

Normale Aufgaben erhalten diese Fortsetzungsanweisung ohne zusätzliche Modellrunden oder Abschlussprüfungen. Bei `/goal` prüft das unabhängige Modell weiterhin die gesamte Aufgabe einschließlich späterer Korrekturen: Die Fertigstellung einer Zwischenkorrektur genügt nicht, solange Hauptarbeit fehlt.

## Seitenkonversationen mit `/side`

`/side` öffnet ein temporäres Gespräch zum Inhalt der Hauptkonversation. Mit `/side <Frage>` startet die erste Frage sofort. Das funktioniert auch, während das Hauptmodell noch arbeitet: Es wird weder angehalten noch auf eine andere Session gewechselt. Das aktive Ziel, genehmigte Befehle und das private Session-`/tmp` bleiben bestehen. Das Fenster zeigt, ob die Hauptkonversation arbeitet oder bereit ist.

Vor jeder Nebenfrage wird ein neuer Textausschnitt aus dem aktuellen, kompaktierten Hauptkontext übernommen. Dazu gehören Nutzer- und Modelltexte, Werkzeugaufrufe und deren Ausgaben sowie Zusammenfassungen. So sieht eine Rückfrage die inzwischen abgeschlossene Arbeit. Die Nebenunterhaltung hat einen eigenen Verlauf im Speicher; ihre Fragen und Antworten werden nicht in den Hauptverlauf geschrieben und erteilen dem Hauptmodell keine zusätzlichen Aufträge.

Es wird das beim Öffnen aktive Modell mit dessen Thinking-Einstellung verwendet. Der Seitenchat hat keine Datei-, Shell- oder Web-Tools und kann keine Änderungen ausführen. Er kann vorhandene Ergebnisse erklären und Fragen dazu beantworten. Für neue Arbeit kehrt der Betreiber zur Hauptkonversation zurück und stellt dort den Auftrag.

- Enter sendet eine Nebenfrage; weitere Fragen bleiben im selben Seitenchat.
- Escape bricht während einer Antwort nur die Nebenanfrage ab. Wenn keine Nebenanfrage läuft, schließt Escape das Fenster. Ctrl+C oder `/back` schließen es direkt.
- PgUp/PgDn blättern im Nebenverlauf.
- `/new` innerhalb des Fensters leert nur den Nebenverlauf; der Hauptkontext wird vor der nächsten Frage erneut übernommen.

Der Seitenchat endet beim Schließen, Session-Wechsel oder Neuladen. Er wird nicht als Session-Datei gespeichert. Ein verschachteltes `/side` wird abgewiesen. Die Funktion steht in der interaktiven Terminal-Oberfläche zur Verfügung.

Der übernommene Kontext ist begrenzt: höchstens 40 vollständige Textbeiträge und 24.000 UTF-8-Bytes, bei kleinen Modellfenstern entsprechend weniger. Originalauftrag und aktuelle Beiträge werden bevorzugt; ausgelassene Textbeiträge werden im Fenster gezählt. Bilder und verborgenes Reasoning des Hauptmodells werden nicht übernommen. Eine Nebenfrage erlaubt bis zu 8.000 Zeichen; eine Modellantwort hat höchstens 4.096 Tokens und drei Minuten Laufzeit. Bei ausgeschöpftem Gesprächsbudget fordert Pi einen neuen Nebenverlauf an. Der vollständige Hauptverlauf bleibt erhalten. Angezeigte Nebentokens und Kosten beruhen auf den vom Provider gelieferten Angaben und bleiben vom Hauptverlauf getrennt.

Das Verhalten orientiert sich an der [offiziellen Codex-Beschreibung von `/side`](https://learn.chatgpt.com/docs/developer-commands#start-a-side-chat-with-side).

## Automatische Workspace-Erkennung

- Ein eigenes Projekt-Repository verwendet seinen Git-Root als Workspace. Die Aktion läuft weiterhin im ursprünglichen Arbeitsverzeichnis.
- Ohne eigenes Repository wird das aktuelle Verzeichnis verwendet.
- Ein Git-Root am Home-Verzeichnis oder darüber wird ignoriert. Ein uninitialisiertes Projekt unter dem Home-Verzeichnis erhält deshalb keine Freigabe für alle Dotfiles.

Ein direkt im Home-Verzeichnis gestartetes Pi benötigt eine eingeschränkte `sandbox.workspaceViews`-Ansicht in `auto-approval.device.json`. In der lokalen Einrichtung sind darin einzelne öffentliche, versionierte Dotfile-Dateien aufgeführt. Unversionierte Dateien, Zugangsdaten und der aktive Approval-Code werden nicht eingebunden. Diese Ansicht erlaubt Änderungen an den eingebundenen Dateien, aber keine neuen Dateien in den schreibgeschützten Elternverzeichnissen. Für normale Projektarbeit ist keine lokale Freigabeliste erforderlich.

Workspaces innerhalb der aktiven Pi-Installation, Approval-Konfiguration oder bekannten Credential-Verzeichnisse bleiben gesperrt. Geschützte Dateien innerhalb eines sonst zulässigen bwrap-Workspaces werden ausgeblendet. Hardlinks sind erlaubt, wenn sämtliche Links desselben Inodes innerhalb der eingebundenen, ungeschützten Pfade liegen. So funktionieren beispielsweise Cargo-Build-Artefakte zwischen `release` und `release/deps`. Symlinks auf den bereits schreibgeschützt eingebundenen Systembereich `/usr` sind bei bwrap erlaubt, etwa auf Python in einem Virtualenv. Andere Links nach außen, Links in geschützte Verzeichnisse und Unix-Sockets werden zurückgewiesen. Dangling Symlinks aus Build-Caches sperren den Workspace nicht; fehlende Ziele werden nicht eingebunden.

## Tool-Anzeige

`approved_action` verwendet die originalen Pi-Renderer des gewählten Tools. Reads behalten ihre aufklappbare Ausgabe, Syntaxhervorhebung und Hinweise auf gekürzte Inhalte. Edits zeigen den Standard-Diff mit Zeilennummern aus dem tatsächlichen Sandbox-Ergebnis. Writes, Bash und die übrigen Tools behalten ebenfalls ihre normale Darstellung. Die Approval-Entscheidung erscheint als eigener Hinweis im Aktivitätsprotokoll; oberhalb der Eingabe bleibt kein Approval-Widget stehen.

Die Edit-Vorschau liest vor der Freigabe keine Dateien vom Host. Der Diff wird nach der genehmigten Ausführung angezeigt und bleibt beim Aufklappen sowie beim Wiederherstellen einer Session erhalten. Abgelehnte Aktionen und Ausführungsfehler werden als solche angezeigt.

## Sandbox-Erweiterung beantragen

Benötigt eine Nutzeraufgabe mehr Zugriff, ergänzt das Hauptmodell den konkreten `approved_action`-Aufruf um `sandbox`. Der Reviewer prüft die gesamte Aktion samt Erweiterung anhand der tatsächlichen Nutzeranfrage. Eine offensichtliche Notwendigkeit muss nicht erst durch eine weitere Chat-Bestätigung autorisiert werden. Die Freigabe gilt ausschließlich für diese Ausführung; beim nächsten Aufruf gelten wieder die Standardrechte.

Unterstützte Dimensionen:

- `tools`: einzeln ausgewählte lokale Tool-Bundles, etwa `"node"` oder `"sqlmap"`; Runtime-Mounts werden geprüft, Caches und Updates bleiben im privaten Session-`/tmp`.
- `paths`: vorhandene absolute Datei- oder Verzeichnispfade mit `access: "read"` oder `"write"`. Symlinks werden vor der Prüfung aufgelöst; der Reviewer sieht die tatsächlichen Mounts.
- `network`: `"none"` oder `"host"`. Host-Netzwerkzugriff umfasst auch lokale Dienste. Der konkrete Befehl und mögliche Datenübertragungen werden mitgeprüft.
- `environment`: explizite Literal-Werte. Es werden keine Host-Umgebungsvariablen oder Secrets automatisch übernommen.
- `executableSearchPaths`: zusätzliche absolute Tool-Verzeichnisse, die schreibgeschützt eingebunden und dem Suchpfad hinzugefügt werden.
- `limits`: `executionTimeoutMs` und `maxOutputBytes`; beim Docker-Backend zusätzlich `memoryMiB`, `cpus` und `pids`. Das persistente Session-`/tmp` liegt auf dem Dateisystem und unterstützt keine `tmpBytes`-Grenze. Ein solcher Antrag wird zurückgewiesen. `tmpBytes` bleibt für einzelne Executor-Aufrufe mit einem flüchtigen tmpfs verfügbar. Native bwrap-cgroup-Limits sind nicht implementiert und werden mit einer konkreten Fehlermeldung zurückgewiesen.

Notwendige Downloads wie `nvm install`, Projektabhängigkeiten mit `npm install` und Registry-Abfragen mit `npm audit` sollen bei passendem Nutzerauftrag genehmigt werden. Der Reviewer bewertet konkrete Ziele, Datenübertragungen und Nebenwirkungen. Die theoretische Erreichbarkeit weiterer Hosts oder lokaler Dienste durch `network: host` genügt allein nicht für eine Ablehnung; das Backend bietet keine Domain-Freigabeliste. Unnötiger Netzwerkzugriff, Credential-Uploads und sachfremde Zugriffe auf lokale Dienste bleiben Ablehnungsgründe. Jeder Aufruf wird weiterhin einzeln geprüft.

Beispiel für einen notwendigen externen Read:

```json
{
  "tool": "read",
  "arguments": {"path": "/absolute/shared/example.ts"},
  "goal": "Die vom Nutzer angegebene gemeinsame Vorlage prüfen",
  "justification": "Die Vorlage liegt außerhalb des Projekts; benötigt wird ausschließlich Lesezugriff auf diese Datei.",
  "sandbox": {
    "paths": [{"path": "/absolute/shared/example.ts", "access": "read"}]
  }
}
```

Die Erweiterung erscheint sichtbar neben der normalen Tool-Anzeige und wird mit ihrem aufgelösten Plan protokolliert. Lange Shell-Befehle sind standardmäßig eingeklappt; `ctrl+o` zeigt den vollständigen Befehl. Geprüft und ausgeführt wird immer das unveränderte Original. Bestehende Schreibrechte werden durch zusätzliche Read-Mounts nicht automatisch erweitert. Hardlinks zwischen einem schreibbaren und einem nur lesbaren Mount werden zurückgewiesen. Die aktive Approval-Installation, ihre Konfiguration, bekannte Credential-Verzeichnisse und das gesamte Home bleiben geschützt. Der Executor und die unabhängige Prüfung können durch keinen Antrag abgeschaltet werden.

## Authentifizierte CLI-Aufrufe

`credential_exec` delegiert ein Betreiber-Anmeldeprofil an einen einzelnen geprüften CLI-Aufruf. Das Prüfmodell beurteilt den Nutzerauftrag, alle Argumente, das gewählte Profil, den Namen und Hash des Programms und die Auswirkungen beim Dienst. Private Quellpfade und Namen der ursprünglichen Host-Variablen bleiben im Gate; die Prüfung sieht die Quellenart und die benötigten CLI-Anmeldevariablen. Eine Ablehnung ruft keine Zugangsdaten ab. Auch eine fehlgeschlagene Protokollierung oder ein Abbruch vor der Ausführung verhindert den Abruf.

Beispiel für einen vom Nutzer ausdrücklich beauftragten PR-Abschluss:

```json
{
  "tool": "credential_exec",
  "arguments": {
    "profile": "github",
    "argv": ["pr", "close", "123", "--repo", "owner/repo"]
  },
  "network": true,
  "goal": "Den angegebenen PR schließen",
  "justification": "Der Nutzer hat den Abschluss dieses PRs beauftragt; dafür ist seine GitHub-Anmeldung erforderlich."
}
```

Das eingebaute Profil `github` verwendet ein systemweit installiertes, natives Linux-`gh`. Es unterstützt `pr`/`issue` mit `view`, `close`, `reopen` und `comment`, einer numerischen Nummer und einem expliziten `--repo OWNER/REPO` oder `-R OWNER/REPO`. Möglich sind außerdem passende `--comment`, `--body`, `--comments`, `--json` und bei Issue-Abschluss `--reason`. Andere Hosts, Auth-/API-/Plugin-Befehle, URLs statt Nummern, Browser, Editoren, Templates, jq-Filter und lokale Branch-Löschungen bleiben gesperrt.

Erst nach protokollierter Freigabe wird `GH_TOKEN` oder `GITHUB_TOKEN` aus der Pi-Prozessumgebung übernommen. Fehlt beides, führt ein eigener Offline-Sandbox-Aufruf ausschließlich `gh auth token --hostname github.com` aus. Er erhält eine private Kopie von `hosts.yml` und gegebenenfalls `config.yml` aus `GH_CONFIG_DIR` beziehungsweise dem üblichen gh-Konfigurationsverzeichnis. gh darf diese Kopie migrieren; das Original wird weder eingebunden noch verändert. Erweiterungen und andere Dateien werden nicht kopiert. Der Token verlässt diesen Abruf ausschließlich über den privaten Executor-Kanal zum Gate. Ein ausschließlich im macOS-Schlüsselbund gespeicherter Login ist damit im Linux-Container nicht verfügbar: Dafür muss `gh` innerhalb von Lubox angemeldet werden oder Pi mit einem passenden Token gestartet werden. Es gibt keinen Host- oder Keychain-Fallback.

Der eigentliche CLI-Aufruf startet ohne Shell, geerbte Umgebung, Projektdateien oder gemeinsame Session-`/tmp`-Daten. Das geprüfte Programm wird vor der Ausführung erneut gehasht und als schreibgeschützte Kopie eingebunden; eine zwischenzeitliche Aktualisierung erfordert eine neue Prüfung. Nur dieser Aufruf und seine eigenen Unterprozesse erhalten die ausgewählten Anmeldevariablen. Der Token wird per privatem stdin-Protokoll übertragen und erscheint weder in Prozessargumenten noch im Prüfkontext oder Audit. Die gewöhnliche CLI-Ausgabe maskiert ausgewählte Tokenwerte sowie deren URL-, JSON- und Base64-Darstellungen. Ausgabegrenzen, Timeout, Abbruch und Prozessgruppen-Aufräumen gelten weiterhin. Das eigene temporäre Dateisystem verschwindet nach dem Aufruf; die private Programmkopie und etwaige Login-Kopien werden ebenfalls entfernt. Folgende normale Aktionen erhalten keine Anmeldung.

Weitere Dienste werden außerhalb von Pi in `auto-approval.device.json` eingerichtet. Ein Profil enthält keine Tokenwerte, sondern Quellen und vollständige erlaubte Argumentfolgen. Dieses Beispiel steht für eine separat installierte vertrauenswürdige Service-CLI:

```json
{
  "credentialProfiles": [{
    "name": "service",
    "executable": "/usr/local/bin/service-cli",
    "allowedArgv": [[
      {"literal": "close"},
      {"literal": "--project"},
      {"literal": "example"},
      {"literal": "--id"},
      {"pattern": "[0-9]+"}
    ]],
    "secrets": {
      "SERVICE_TOKEN": {"type": "environment", "name": "SERVICE_TOKEN"}
    }
  }]
}
```

Alternativ verweist `{"type":"file","path":"/absolute/private/token"}` auf eine höchstens 16 KiB große, nur für ihren Eigentümer lesbare reguläre Datei ohne Symlink oder Hardlinks. Der Inhalt wird als Anmeldevariable übergeben; die Datei wird nicht eingebunden. Optionale `environment`-Werte dienen ausschließlich öffentlichen Einstellungen wie einer Region oder Dienstadresse. Geheimnisse gehören immer in `secrets`. Es werden keine beliebigen Credential-Getter-Befehle unterstützt. Dateiquellen und Profilprogramme werden bei normalen Sandbox-Aktionen zusätzlich geschützt.

Jede `allowedArgv`-Folge muss sämtliche Argumente in genau dieser Reihenfolge abdecken. `literal` ist exakt, `pattern` muss den gesamten einzelnen Wert treffen. Die Betreiberregeln müssen Dienst, Ziele und erlaubte Operationen begrenzen; beliebige Shell-/Interpreter-, Plugin-, Debug- oder Credential-Ausgabe-Befehle sind ungeeignet. Die Ausgabe-Maskierung ersetzt keine vertrauenswürdige CLI und keine begrenzten Argumentregeln: Ein absichtlich bösartiges Programm könnte Secrets anders kodieren oder versenden. Das gewählte Programm erhält die tatsächliche Berechtigung des Tokens beim Dienst; das Prüfmodell muss deshalb jede konkrete Wirkung autorisieren.

Die Profile bleiben gerätespezifisch, werden pro Aktion geladen und können nur vom Betreiber geändert werden. `github` kann durch ein ausdrücklich eingerichtetes gleichnamiges Profil ersetzt werden, etwa für anders begrenzte GitHub-Operationen. Der Modellaufruf darf keine zusätzlichen Mounts, Tool-Bundles, Suchpfade oder Umgebungsvariablen beantragen. Netzwerkzugriff muss für jeden Aufruf separat angefordert werden. Aktuell ist dieser Weg auf native Linux-ELF-Programme mit bwrap begrenzt; Shell-/macOS-Wrapper und das Docker-Backend werden vor der Modellprüfung abgewiesen. Für Werkzeuge, die Projektdateien oder Credential-Dateien direkt benötigen, muss zunächst eine passende begrenzte Integration gebaut werden.

## Lokale Tools und Netzwerkzugriff für einen Befehl

Mit `sandbox.tools: ["node"]` erhält eine Aktion `nvm`, `node`, `npm`, `npx` und, sofern installiert, `corepack`. Vorhandene Node-Versionen werden schreibgeschützt eingebunden. Vor der Freigabe prüft die Erweiterung den ELF-Header und die CPU-Architektur jeder Version; die Sandbox prüft sie bei der Auswahl erneut, auch im privaten Cache. In einem vom macOS-Host eingebundenen Home werden Mach-O-Binaries, fremde CPU-Architekturen und Shell-Wrapper für solche Binaries ausgeschlossen. Das gilt auch für alte, noch nicht nach Plattform getrennte nvm-Verzeichnisse. Der macOS-nvm-Launcher wird nicht durchgereicht.

`nvm use 22` wählt eine kompatible Linux-Version; die Auswahl bleibt für folgende Node-Aktionen derselben Session erhalten. Ohne Versionsargument liest `nvm use` die nächste `.nvmrc`. `nvm help` und `nvm --help` zeigen die unterstützten Befehle. Fehlt eine Linux-Version, meldet die Sandbox den notwendigen `nvm install 22`-Aufruf mit separat zu prüfendem `network: true`; sie lädt nichts automatisch herunter. Eine veraltete Auswahl, die nur noch auf inkompatible Dateien zeigt, wird mit einer konkreten Fehlermeldung zurückgewiesen. Für jede Aktion, die diese Tools braucht, wird der Bundle-Antrag erneut gestellt.

Der Ablauf besteht beispielsweise aus drei separat geprüften Shell-Aktionen:

| Befehl | Zusätzliche Felder von `approved_action` |
| --- | --- |
| `nvm use 22` | `"sandbox": {"tools": ["node"]}` |
| `npm install` | `"sandbox": {"tools": ["node"]}, "network": true` |
| `npm run build` | `"sandbox": {"tools": ["node"]}` |

Das Shell-Flag `network: true` beantragt Netzwerkzugriff nur für den neu gestarteten Befehlsprozess und seine Unterprozesse. Der unabhängige Reviewer prüft ihn vor dem Start zusammen mit dem exakten Befehl. Die Erweiterung übersetzt das Flag in `sandbox.network: "host"`; widersprüchliche Angaben werden zurückgewiesen. Ohne Antrag startet jede Aktion in einem eigenen Netzwerk-Namespace ohne Host-Netzwerk. Ein freigegebener Netzwerkbefehl verändert weder die Namespaces bereits laufender Prozesse noch den Standard für folgende Aktionen. DNS-Konfiguration und öffentliche CA-Zertifikate werden bei dieser Freigabe ebenfalls nur lesbar eingebunden.

`nvm install <numerische Version>` lädt die offizielle Linux-Distribution von nodejs.org, prüft deren SHA256 gegen `SHASUMS256.txt` und installiert sie in das private `/tmp`. Dafür ist ebenfalls ein Netzwerk-Antrag nötig. npm-Caches und neu installierte Node-Versionen verschwinden beim Ende der Session; Projektabhängigkeiten und Build-Ergebnisse bleiben im Projekt.

Andere reguläre, ausführbare Launcher aus `~/.local/bin` können einzeln mit ihrem Namen angefordert werden, etwa `sandbox.tools: ["sqlmap"]`. Der Launcher und sein öffentlicher Cache `~/.local/cache/<Name>` werden schreibgeschützt eingebunden. Die Sandbox erstellt eine private Kopie mit eigenem Home und kopiert den vorhandenen `auto-update-app.bash`-Helper. Aktualisierungen betreffen diese Kopie, niemals die Host-Installation. Downloads brauchen eine separat genehmigte Netzwerkfreigabe; ein vorhandener Cache ist auch offline nutzbar. Selbstständige Executables benötigen keinen Update-Helper. Tools mit weiteren privaten Dateien, Diensten oder externen Runtimes brauchen passende zusätzliche Integration. Der aktuelle WPScan-Launcher benötigt einen externen Container-Engine-Zugriff und wird nicht unterstützt.

Um bestehenden Programmcode beurteilen zu können, erhält der Reviewer Text-Ergebnisse vorher genehmigter Aktionen aus demselben Session-Zweig. Dazu gehören Reads, Dateisuche und Shell-Ausgaben, etwa von `cat`, `sed`, `git diff` oder Projekttests. Dafür müssen Tool-Ergebnis und Approval-Protokoll samt Request-ID und Fingerprint zusammenpassen. Dateiinhalte und Ausgaben sind Belege für die Prüfung, keine Nutzeranweisungen. Berücksichtigt werden höchstens acht aktuelle Ergebnisse. Ergebnisse, die das Kontextbudget überschreiten, werden vollständig ausgelassen und ausdrücklich benannt.

Die letzten `recentUserPrompts` Nutzerbeiträge werden mit `userPromptInfo` gekennzeichnet: Prompt-ID, Originalgröße, `compressed`, Komprimierungsversion und Cache-Treffer. Kleine Prompts stehen vollständig in `userPrompts`, große gegebenenfalls als Zusammenfassung. Das aktive Operator-Ziel und die aktuelle Aktion bleiben vollständig. Bis zu sechs frühere Ablehnungen behalten Begründung, Request-ID, Fingerprint, Tool und technische Fehlerstufe; alte Aktionsinhalte, Konfigurationen und Sandbox-Pläne werden als ausgelassen markiert und bleiben im lokalen Audit erhalten. So blockiert ein früherer großer Befehl keinen späteren kleinen Read. Zusätzliche geprüfte Tool-Belege haben ein eigenes Budget von 95.000 UTF-8-Bytes und werden auch bei großen Nutzerbeiträgen berücksichtigt.

Die einzelne auszuführende Aktion behält das bestehende Executor-Limit von 100.000 UTF-8-Bytes. Überschreitet sie es, wird dies schon vor einer kostenpflichtigen Prüfung ausdrücklich als Aktionsgröße gemeldet. Dieses Limit betrifft den serialisierten Befehl beziehungsweise Dateiinhalt mit Tool-Argumenten, Ziel und Begründung; Nutzerverlauf und Prüfbelege zählen dort nicht mit.

Der separate Sprachhinweis verwendet höchstens Anfang und Ende von 2.048 Zeichen eigener Prosa aus dem ursprünglichen letzten Nutzerprompt, auch nach einer Komprimierung. Codeblöcke, Inline-Code, Markdown-Zitate und vollständige JSON-Blöcke werden nur aus dieser Sprachprobe entfernt. Die Probe setzt ausschließlich die Sprache der Begründung und ersetzt keine Nutzerbedingungen.

Für die Vorbereitung gilt eine Obergrenze von 1 MiB pro Prüfungsanfrage statt bisher 100.000 Bytes. Ein Fehler nennt Gesamtgröße und die Größen der wichtigsten Felder; ein kleinerer Befehl verkleinert angesammelten Nutzerkontext nicht. Vor jedem Provider-Aufruf wird außerdem das registrierte Modellfenster berücksichtigt, einschließlich Policy, erneutem Sprachbezug, 4.096 Ausgabetokens und Reserve für Nachrichtenrahmen. Die Schätzung verwendet für ASCII-JSON drei Bytes je Token; Nicht-ASCII-Zeichen zählen mit ihrer UTF-8-Bytezahl. Das ist keine exakte Tokenisierung, und der Provider prüft sein tatsächliches Limit. Ein Modell mit fehlender oder geschätzt unzureichender Kapazität ist für diese Anfrage nicht verfügbar. Nur dann darf der konfigurierte Fallback vor einer Modellentscheidung übernehmen. Nutzeranweisungen und Aktionen werden dafür nicht gekürzt; eine gültige Ablehnung bleibt endgültig. Dieselben Regeln gelten für `/goal`-Prüfungen.

## Wiederverwendbare Prompt-Komprimierung

Ab mehr als 16.000 UTF-8-Bytes komprimiert das konfigurierte kleine Prüfmodell einen ausgewählten Nutzerprompt vor dem eigentlichen Review. Es soll Aufgaben, Verbote, Ausnahmen, Pfade, Versionen und Bedingungen bewahren und umfangreiche Logs oder JSON-Ergebnisse kurz beschreiben. Die Zusammenfassung hat höchstens 600 Zeichen. Große Prompts werden in bis zu 64 Abschnitten mit jeweils höchstens 64.000 Zeichen verarbeitet und anschließend zusammengefasst. Kann das Modell die notwendigen Bedingungen nicht passend erhalten, lehnt es die Komprimierung ab; der vollständige Rohprompt wird weiterverwendet, sofern er ins Review-Budget passt. Eine solche Ablehnung löst keinen anderen Komprimierungsprüfer aus.

Zusammenfassungen werden privat unter `~/.pi/agent/cache/approval-prompts/` gespeichert, bei abweichendem Agent-Verzeichnis dort. Verzeichnisse sind nur für den Besitzer zugänglich, Dateien haben Modus 0600. Der Schlüssel berücksichtigt Originalinhalt, Version, Komprimierungsregeln und konfigurierte Prüfmodelle. Gleiche unveränderte Prompts werden bei folgenden Aktionen oder nach einem Neustart ohne erneute Komprimierung wiederverwendet. Die Session enthält zusätzlich `auto-approval-prompt-compression`-Einträge. Rohprompts werden nicht umgeschrieben; alte Chats ohne solche Einträge werden beim nächsten benötigten Review nachkomprimiert. Der Cache enthält Zusammenfassungen, keine zusätzlichen Kopien der Originale, und ist von Git und der Aktionssandbox ausgeschlossen. Er bleibt unabhängig vom temporären Session-`/tmp` erhalten.

Das Prüfmodell erhält bei komprimierten Prompts ausschließlich das Werkzeug `prompt_original`. Es liest das Original aus dem ausgewählten Session-Zweig anhand seiner Prompt-ID: `head`, `tail`, `read` mit Zeichenoffset oder `grep` mit wörtlicher, groß-/kleinschreibungsabhängiger Suche. Ein Aufruf liefert höchstens 8.000 Zeichen; ein Review darf höchstens acht Original-Abfragen ausführen. Dateipfade, Shell-Befehle, reguläre Ausdrücke, Netzwerkzugriff und Originale anderer Zweige sind nicht zugänglich. Abfragen werden protokolliert. Vor einer Freigabe muss jedes komprimierte Original mindestens einmal Text geliefert haben; bei einer relevanten Bedingung muss der Reviewer weiter nachlesen. Das Original ist maßgeblich, die Zusammenfassung dient als Orientierung. Eine Modellablehnung bleibt endgültig; ungültige Abfragen oder Freigaben ohne erforderliche Originalprüfung blockieren ohne Fallback.

Komprimierung und nachfolgende Review-Turns zählen gemeinsam zu den gemeldeten Tokens und Kosten. Cache-Treffer verursachen keinen Komprimierungsaufruf. Die Funktion gilt für Aktionsfreigaben und `/goal`-Prüfungen; das Arbeitsmodell und `/side` behalten ihren bisherigen Kontext.

## bwrap einrichten

Der Launcher `~/.local/bin/pi` benötigt Bun und Python 3 mit `venv`/`ensurepip` für die Einrichtung beim Start. Er bereitet die [Web-Recherche-Extension](../web-research/README.md) und die [Extension für öffentliche Texte](../public-writing/README.md) vor und installiert die festgeschriebenen Dependencies mit deaktivierten Installationsskripten. Unter Linux baut er den Standard-Executor, wenn er fehlt oder sich `runner.ts`, dessen Web-/Textprüfungs-Module und Dependencies, Bun-Version oder Plattform ändern. Unveränderte Installationen werden wiederverwendet. Ein fehlgeschlagener Build sperrt den Start; der bisherige Executor bleibt erhalten. Der Austausch der Binary erfolgt atomar, damit bereits laufende Pi-Sandboxes weiterarbeiten können.

Linux benötigt zusätzlich Bubblewrap und Git. Die Sandbox verwendet den eigenständigen Executor und die Systemprogramme unter `/usr`. Eigene `sandbox.runnerExecutable`-Pfade werden geprüft, aber weder gebaut noch überschrieben. Das Docker-Backend baut keinen nativen Executor.

Die Erweiterung prüft native Executables beim Session-Start, bei `/auto-approval` und vor jedem Review. Ein fehlender oder nicht ausführbarer Executor sperrt die Aktion vor der kostenpflichtigen Modellprüfung.

Zur manuellen Einrichtung außerhalb von Pi ausführen:

```bash
cd ~/.pi/agent/extensions/auto-approval
bun ../web-research/bootstrap.ts
bun ../public-writing/bootstrap.ts
bun bootstrap.ts
```

Eine portable `auto-approval.json` sieht so aus:

```json
{
  "reviewers": [
    { "provider": "openai", "model": "gpt-6-luna", "thinking": "medium" },
    { "provider": "openrouter", "model": "openai/gpt-6-luna", "thinking": "medium" }
  ],
  "recentUserPrompts": 6,
  "requestTimeoutMs": 120000,
  "sandbox": {
    "backend": "bwrap"
  }
}
```

Bubblewrap wird über absolute Verzeichnisse im `PATH` gesucht; der Executor liegt standardmäßig unter `~/.local/cache/pi-auto-approval/executor`. Abweichende absolute Pfade können als `sandbox.executable` und `sandbox.runnerExecutable` in `auto-approval.device.json` stehen. Dort kann auch `sandbox.workspaceViews` Einträge der Form `{"root":"/absolute/workspace","paths":["/absolute/workspace/public-file"]}` enthalten. Nur diese Pfade werden eingebunden. Keine Credential-Dateien oder ganzen privaten Home-Verzeichnisse hinzufügen.

Der Executor wird schreibgeschützt eingebunden. Die Sandbox erhält eine leere Umgebung, ein temporäres Home, eigene Prozess-, Netzwerk-, IPC- und weitere Namespaces sowie keine Linux-Capabilities. Ohne genehmigte Erweiterung sind die Netzwerkschnittstellen des Hosts nicht erreichbar. Die Prozessnamespace bleibt isoliert. Änderungen am Projekt erfolgen ausschließlich über die ausgewählten Workspace-Mounts.

Jede Pi-Session erhält ein eigenes, schreibbares `/tmp`. Dateien und Skripte darin bleiben bei späteren genehmigten Aktionen derselben Session verfügbar. Das Host-`/tmp` und die temporären Dateien anderer Sessions werden nicht eingebunden. Die Verzeichnisse `/tmp/home` und `/tmp/pi` gehören zur jeweiligen Executor-Runtime und werden bei jeder Aktion neu erstellt. Zusätzliche Mounts gelten weiterhin nur für ihre einzelne Aktion; leere Mount-Platzhalter werden danach entfernt.

Beim Beenden von Pi, beim Neuladen der Erweiterung und beim Wechsel zu einer neuen, fortgesetzten oder geforkten Session löscht der `session_shutdown`-Handler das gesamte private `/tmp` nach Abschluss der laufenden Aktion. Die nächste Session bekommt ein neues, leeres Verzeichnis. Ein abgebrochener Sitzungswechsel löst diese Bereinigung nicht aus. Bei einem erzwungenen Prozessabbruch, etwa `SIGKILL`, kann kein Shutdown-Handler laufen.

Ein Abbruch beendet den Sandbox-Prozess; Kindprozesse dürfen nach der Aktion nicht weiterlaufen. Ausgabemenge und Laufzeit sind begrenzt. Die Docker-spezifischen Speicher-, CPU- und PID-Grenzen gelten für das Docker-Backend; das bwrap-Backend richtet keine entsprechenden cgroup-Grenzen ein.

Nach Änderungen an `runner.ts` oder dessen Dependencies Pi über den Launcher neu starten oder `bun bootstrap.ts` außerhalb von Pi ausführen. Eigene Executor-Pfade bleiben manuell verwaltet. Die Auswahl des Prüfmodells lässt sich über `auto-approval.json` ändern. Änderungen am Erweiterungscode erfordern einen Neustart von Pi.

## Docker-Kompatibilität

Das frühere Docker-Backend bleibt verfügbar. Dazu enthält die synchronisierte Konfiguration `sandbox.backend: "docker"` und einen unveränderlichen `sandbox.image`-Digest. Docker wird über `PATH` gefunden; ein abweichender absoluter `sandbox.dockerExecutable`-Pfad gehört in `auto-approval.device.json`. Automatische Workspace-Erkennung gilt auch dort. Das Docker-Backend erlaubt keinen Workspace, der geschützte Pi- oder Credential-Verzeichnisse enthält.

Das Backend wird explizit gewählt. Wenn er nicht startet, wird keine Aktion auf dem Host ausgeführt und kein anderer Backend automatisch ausprobiert.

## Prüfung und Protokoll

Das Hauptmodell verwendet ausschließlich `approved_action` mit `tool`, den unveränderten Pi-`arguments`, `goal` und `justification`. Unterstützt werden `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `websearch`, `webfetch` und `writing_check`. Web-Operationen beantragen vor der Prüfung Netzwerkzugriff für genau diesen Aufruf; die feste Worker-Ausführung steht im Prüfplan. `webfetch` liefert dem Modell nur den bereinigten Seitentext, während die Freigabe in den Ergebnisdetails und im Aktivitätsprotokoll bleibt.

Der Reviewer erhält tatsächliche Nutzerprompts des aktiven Session-Zweigs, die genaue Aktion, Ziel, Begründung, Arbeitsverzeichnis, geschützte Pfade und frühere Ablehnungen. Er erhält keine eigenen Tools. Bei einem Fallback bleiben Anfrage, Request-ID und Fingerprint unverändert. Jeder Versuch und das tatsächlich entscheidende Prüfmodell werden protokolliert; Tokenverbrauch und Kosten werden über die Versuche addiert. `requestTimeoutMs` gilt je Prüfmodell. Ein gültiges Urteil gilt nur für die konkrete Anfrage. Prüfung und Ausführung sind serialisiert; Freigaben werden nicht wiederverwendet.

Für die Sprache der Begründung erhält der Reviewer den letzten tatsächlichen Nutzerprompt separat als `latestUserPrompt`. Dazu zählt auch das über `/goal` eingegebene Ziel; spätere Nutzerprompts ersetzen es als Sprachvorgabe. Aktions- und Zielprüfer sind angewiesen, die Sprache der eigenen Nutzeranweisung zu verwenden und fremdsprachige Logausgaben, Zitate, ältere Begründungen und Modelltexte dabei auszuklammern.

Die Prüfung bewertet Berechtigung und Sicherheitsrisiken. Bei neu verfassten oder wesentlich umformulierten öffentlichen Texten prüft sie außerdem die lokal gespeicherten, sprachunabhängigen redaktionellen Regeln. Die Operation `writing_check` beurteilt den exakten Entwurf; gewöhnliche Antworten an den Betreiber und reine Code-/Layoutänderungen bleiben ausgenommen. Details stehen in der [Extension-Dokumentation](../public-writing/README.md). Eine gewünschte Quelltextänderung erlaubt normalerweise auch passende Tests, Dokumentation und lokale Prüfläufe. Für begrenzte Edits oder vollständig sichtbare Python-/Shell-Änderungen müssen nicht erst sämtliche betroffenen Dateien vollständig gelesen werden. Mögliche Programmierfehler, falsche Testannahmen oder eine bevorzugte Arbeitsreihenfolge sind allein kein Ablehnungsgrund. Zusätzliche Informationen sind erforderlich, wenn ein konkretes Risiko ohne sie nicht beurteilt werden kann. Secret-Zugriffe, sachfremde Änderungen, unbegründetes großflächiges Löschen und Eingriffe in die Approval-Sperre bleiben untersagt.

Bei OpenAI Responses und Chat Completions erzwingt ein JSON-Schema die drei Urteilsfelder und die Request-ID der aktuellen Anfrage. Andere Provider verwenden weiterhin das streng geprüfte JSON-Textformat. Ungültiges JSON, falsche Felder, eine fremde Request-ID und eine leere Begründung erzeugen unterscheidbare Fehlermeldungen und sperren die Ausführung.

Urteil, Begründung, Request-ID, Fingerprint, Prüfdauer, Backend und erkannter Workspace werden als Session-Eintrag protokolliert. Fehler bei Authentifizierung, Prüfung oder Protokollierung sperren die Aktion vor der Ausführung. Ein Fehler während einer bereits gestarteten Aktion kann trotzdem Nebenwirkungen im Workspace hinterlassen.

Der Betreiber kann die Konfiguration außerhalb der Agent-Tools ändern. Das Agent-Modell kann die Prüfung nicht abschalten. Eine zusätzliche Workspace-Ansicht benötigt eine eigene Genehmigung für die konkrete Aktion. Die Sandbox schützt den laufenden Executor; sie verhindert nicht, dass der Betreiber später bewusst veränderten Projektcode auf dem Host startet.

## Entwicklung und Tests

```bash
cd ~/.pi/agent/extensions/auto-approval
bun run check
bun run test
```

Gate-Tests verwenden einen Test-Mock für den Executor. Die Isolationstests laufen in einem separaten Bun-Prozess, damit dieser Mock die echten bwrap-Tests nicht ersetzt. Auf Linux mit Bubblewrap prüfen sie zusätzlich Dateizugriffe, den Schutz von Host-Dateien und Umgebungsvariablen, getrennte Namespaces, Abbruch und das Ende von Hintergrundprozessen. Ohne Bubblewrap werden nur diese nativen Integrationstests übersprungen.

Die `/side`-Tests prüfen getrennte Verläufe, aktualisierten Hauptkontext, Abbruch, Kontextgrenzen und die Terminalansicht. Ein zusätzlicher Test mit Pis echtem Session-SDK und einem lokalen Testprovider hält die Hauptanfrage offen, beantwortet eine Nebenfrage parallel und übernimmt danach das abgeschlossene Hauptergebnis in eine Rückfrage. Diese Tests benötigen keine Anmeldung und verursachen keine Modellkosten.

`bun run eval:network` prüft zusätzlich sechs Netzwerkfälle mit den tatsächlich konfigurierten Prüfmodellen und vorhandener Anmeldung. Dazu gehören notwendige Node-/npm-Downloads und Audits sowie unnötige Netzwerkfreigaben, Credential-Uploads und sachfremde lokale Dienste. Der Lauf verursacht Modellanfragen; keine der vorgeschlagenen Aktionen wird ausgeführt. Er gehört deshalb nicht zum normalen Unit-Testlauf.
