# Pi Conversations

Diese Extension enthält Gesprächssteuerung: `/goal`, `/side` und Steering. Sie besitzt keinen Executor und kann keine Aktion freigeben. Aktionsprüfungen verwenden den vom Goal-Controller bereitgestellten Session-Dienst; der Chat-Verlauf bleibt die Quelle echter Nutzeraufträge.

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

## Laden und Abhängigkeiten

Der Pi-Launcher lädt diese Extension unabhängig von Auto-Approval. Der Startup-Bootstrap verknüpft `node_modules` mit den festgeschriebenen SDK-Abhängigkeiten von Auto-Approval. Die Regressionstests laufen aktuell im gemeinsamen Integrationstest-Paket `../auto-approval`: `bun run check` und `bun run test`.
