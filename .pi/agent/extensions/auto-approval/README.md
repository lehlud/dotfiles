# Pi Auto-Approval

Jede Agent-Aktion wird von einem unabhängigen Modell geprüft. Genehmigte Aktionen laufen anschließend in einer separaten Sandbox. Direkte Tools, `!`/`!!`, verschachtelte Tool-Aufrufe und ein lokaler Ausführungs-Fallback sind gesperrt.

## Start und Status

`~/.local/bin/pi` lädt ausschließlich diese Erweiterung und aktiviert `approved_action` als einziges Agent-Tool. Nach Änderungen an der Erweiterung Pi neu starten. `/auto-approval` zeigt Reviewer, Sandbox-Backend, Arbeitsverzeichnis, erkannten Workspace und den vollständigen Konfigurationspfad.

Die lokale Konfiguration liegt normalerweise unter `~/.pi/agent/auto-approval.json`. Bei einem anderen `PI_CODING_AGENT_DIR` liegt sie in diesem Agent-Verzeichnis. Sie wird bei jeder Aktion neu gelesen und bleibt außerhalb des öffentlichen Dotfiles-Repositories.

## Automatische Workspace-Erkennung

- Ein eigenes Projekt-Repository verwendet seinen Git-Root als Workspace. Die Aktion läuft weiterhin im ursprünglichen Arbeitsverzeichnis.
- Ohne eigenes Repository wird das aktuelle Verzeichnis verwendet.
- Ein Git-Root am Home-Verzeichnis oder darüber wird ignoriert. Ein uninitialisiertes Projekt unter dem Home-Verzeichnis erhält deshalb keine Freigabe für alle Dotfiles.
- `workspaceRoots` ist für die Erkennung nicht erforderlich; auch ein alter leerer Eintrag sperrt die automatische Erkennung nicht.

Ein direkt im Home-Verzeichnis gestartetes Pi verwendet eine eingeschränkte `workspaceViews`-Ansicht. In der lokalen Einrichtung sind darin einzelne öffentliche, versionierte Dotfile-Dateien aufgeführt. Unversionierte Dateien, Zugangsdaten und der aktive Approval-Code werden nicht eingebunden. Diese Ansicht erlaubt Änderungen an den eingebundenen Dateien, aber keine neuen Dateien in den schreibgeschützten Elternverzeichnissen. Für normale Projektarbeit Pi im jeweiligen Projektordner starten.

Workspaces innerhalb der aktiven Pi-Installation, Approval-Konfiguration oder bekannten Credential-Verzeichnisse bleiben gesperrt. Geschützte Dateien innerhalb eines sonst zulässigen bwrap-Workspaces werden ausgeblendet. Hardlinks sind erlaubt, wenn sämtliche Links desselben Inodes innerhalb der eingebundenen, ungeschützten Pfade liegen. So funktionieren beispielsweise Cargo-Build-Artefakte zwischen `release` und `release/deps`. Links nach außen, in ausgeblendete Verzeichnisse und Unix-Sockets werden zurückgewiesen. Dangling Symlinks aus Build-Caches sperren den Workspace nicht; fehlende Ziele werden nicht eingebunden.

## Tool-Anzeige

`approved_action` verwendet die originalen Pi-Renderer des gewählten Tools. Reads behalten ihre aufklappbare Ausgabe, Syntaxhervorhebung und Hinweise auf gekürzte Inhalte. Edits zeigen den Standard-Diff mit Zeilennummern aus dem tatsächlichen Sandbox-Ergebnis. Writes, Bash und die übrigen Tools behalten ebenfalls ihre normale Darstellung. Die Approval-Entscheidung erscheint als eigener Hinweis.

Die Edit-Vorschau liest vor der Freigabe keine Dateien vom Host. Der Diff wird nach der genehmigten Ausführung angezeigt und bleibt beim Aufklappen sowie beim Wiederherstellen einer Session erhalten. Abgelehnte Aktionen und Ausführungsfehler werden als solche angezeigt.

## Sandbox-Erweiterung beantragen

Benötigt eine Nutzeraufgabe mehr Zugriff, ergänzt das Hauptmodell den konkreten `approved_action`-Aufruf um `sandbox`. Der Reviewer prüft die gesamte Aktion samt Erweiterung anhand der tatsächlichen Nutzeranfrage. Eine offensichtliche Notwendigkeit muss nicht erst durch eine weitere Chat-Bestätigung autorisiert werden. Die Freigabe gilt ausschließlich für diese Ausführung; beim nächsten Aufruf gelten wieder die Standardrechte.

Unterstützte Dimensionen:

- `paths`: vorhandene absolute Datei- oder Verzeichnispfade mit `access: "read"` oder `"write"`. Symlinks werden vor der Prüfung aufgelöst; der Reviewer sieht die tatsächlichen Mounts.
- `network`: `"none"` oder `"host"`. Host-Netzwerkzugriff umfasst auch lokale Dienste. Der konkrete Befehl und mögliche Datenübertragungen werden mitgeprüft.
- `environment`: explizite Literal-Werte. Es werden keine Host-Umgebungsvariablen oder Secrets automatisch übernommen.
- `executableSearchPaths`: zusätzliche absolute Tool-Verzeichnisse, die schreibgeschützt eingebunden und dem Suchpfad hinzugefügt werden.
- `limits`: `executionTimeoutMs`, `maxOutputBytes` und `tmpBytes`; beim Docker-Backend zusätzlich `memoryMiB`, `cpus` und `pids`. Native bwrap-cgroup-Limits sind nicht implementiert und werden mit einer konkreten Fehlermeldung zurückgewiesen.

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

Die Erweiterung erscheint sichtbar neben der normalen Tool-Anzeige und wird mit ihrem aufgelösten Plan protokolliert. Bestehende Schreibrechte werden durch zusätzliche Read-Mounts nicht automatisch erweitert. Hardlinks zwischen einem schreibbaren und einem nur lesbaren Mount werden zurückgewiesen. Die aktive Approval-Installation, ihre Konfiguration, bekannte Credential-Verzeichnisse und das gesamte Home bleiben geschützt. Der Executor und die unabhängige Prüfung können durch keinen Antrag abgeschaltet werden.

Um bestehenden Programmcode beurteilen zu können, erhält der Reviewer Text-Ergebnisse vorher genehmigter Reads aus demselben Session-Zweig. Dafür müssen Tool-Ergebnis und Approval-Protokoll zusammenpassen. Dateiinhalte gelten als untrusted Evidenz, nicht als Nutzeranweisung. Große Ergebnisse werden nicht still gekürzt: Nicht eingebundene Code-Evidenz wird ausdrücklich benannt, damit gezielte kleinere Reads möglich sind.

## bwrap einrichten

Linux benötigt Bubblewrap, Git und Bun zum Bauen des eigenständigen Executors. Die Runtime benötigt anschließend Bubblewrap und die Systemprogramme unter `/usr`.

Außerhalb von Pi ausführen:

```bash
cd ~/.pi/agent/extensions/auto-approval
bun install --frozen-lockfile --ignore-scripts
mkdir -p ~/.local/cache/pi-auto-approval
bun build --compile runner.ts --outfile ~/.local/cache/pi-auto-approval/executor
```

`auto-approval.json` verwendet absolute Pfade. Eine Konfiguration für normale Projektverzeichnisse sieht zum Beispiel so aus:

```json
{
  "provider": "openai",
  "model": "gpt-6-luna",
  "thinking": "medium",
  "recentUserPrompts": 6,
  "requestTimeoutMs": 120000,
  "sandbox": {
    "backend": "bwrap",
    "executable": "/usr/bin/bwrap",
    "runnerExecutable": "/absolute/path/to/.local/cache/pi-auto-approval/executor"
  }
}
```

Für eine eingeschränkte Ansicht kann `sandbox.workspaceViews` Einträge der Form `{"root":"/absolute/workspace","paths":["/absolute/workspace/public-file"]}` enthalten. Nur diese Pfade werden eingebunden. Keine Credential-Dateien oder ganze private Home-Verzeichnisse hinzufügen.

Der Executor wird schreibgeschützt eingebunden. Die Sandbox erhält eine leere Umgebung, ein temporäres Home, eigene Prozess-, Netzwerk-, IPC- und weitere Namespaces sowie keine Linux-Capabilities. Ohne genehmigte Erweiterung sind die Netzwerkschnittstellen des Hosts nicht erreichbar. Die Prozessnamespace bleibt isoliert. Nur die ausgewählten Workspace-Mounts können auf dem Host verändert werden. Temporäre Dateien bleiben in der Sandbox.

Ein Abbruch beendet den Sandbox-Prozess; Kindprozesse dürfen nach der Aktion nicht weiterlaufen. Ausgabemenge und Laufzeit sind begrenzt. Die Docker-spezifischen Speicher-, CPU- und PID-Grenzen gelten für das Docker-Backend; das bwrap-Backend richtet keine entsprechenden cgroup-Grenzen ein.

Nach Änderungen an `runner.ts` oder dessen Dependencies den Executor erneut außerhalb von Pi bauen. Änderungen am Reviewer erfordern nur eine Änderung der lokalen JSON-Konfiguration.

## Docker-Kompatibilität

Das frühere Docker-Backend bleibt verfügbar. Dazu enthält `sandbox` weiterhin `dockerExecutable`, einen unveränderlichen `image`-Digest und optional `"backend":"docker"`. Automatische Workspace-Erkennung gilt auch dort. Das Docker-Backend erlaubt keinen Workspace, der geschützte Pi- oder Credential-Verzeichnisse enthält.

Das Backend wird explizit gewählt. Wenn er nicht startet, wird keine Aktion auf dem Host ausgeführt und kein anderer Backend automatisch ausprobiert.

## Prüfung und Protokoll

Das Hauptmodell verwendet ausschließlich `approved_action` mit `tool`, den unveränderten Pi-`arguments`, `goal` und `justification`. Unterstützt werden `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find` und `ls`.

Der Reviewer erhält tatsächliche Nutzerprompts des aktiven Session-Zweigs, die genaue Aktion, Ziel, Begründung, Arbeitsverzeichnis, geschützte Pfade und frühere Ablehnungen. Er erhält keine eigenen Tools. Ein gültiges Urteil gilt nur für die konkrete Anfrage. Prüfung und Ausführung sind serialisiert; Freigaben werden nicht wiederverwendet.

Urteil, Begründung, Request-ID, Fingerprint, Prüfdauer, Backend und erkannter Workspace werden als Session-Eintrag protokolliert. Fehler bei Authentifizierung, Prüfung oder Protokollierung sperren die Aktion vor der Ausführung. Ein Fehler während einer bereits gestarteten Aktion kann trotzdem Nebenwirkungen im Workspace hinterlassen.

Der Betreiber kann die Konfiguration außerhalb der Agent-Tools ändern. Das Agent-Modell kann die Prüfung nicht abschalten. Eine zusätzliche Workspace-Ansicht benötigt eine eigene Genehmigung für die konkrete Aktion. Die Sandbox schützt den laufenden Executor; sie verhindert nicht, dass der Betreiber später bewusst veränderten Projektcode auf dem Host startet.

## Entwicklung und Tests

```bash
cd ~/.pi/agent/extensions/auto-approval
bun run check
bun run test
```

Gate-Tests verwenden einen Test-Mock für den Executor. Die Isolationstests laufen in einem separaten Bun-Prozess, damit dieser Mock die echten bwrap-Tests nicht ersetzt. Auf Linux mit Bubblewrap prüfen sie zusätzlich Dateizugriffe, den Schutz von Host-Dateien und Umgebungsvariablen, getrennte Namespaces, Abbruch und das Ende von Hintergrundprozessen. Ohne Bubblewrap werden nur diese nativen Integrationstests übersprungen.
