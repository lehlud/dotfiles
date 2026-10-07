# Pi Multiplex

`/multiplex <n>` startet ein Team aus `n` gleichberechtigten Arbeitsagenten, aktuell mit 1–16 Mitgliedern. Der sichtbare Agent zählt mit; zusätzlich entstehen `n - 1` echte Pi-SDK-Sessions. Es gibt keinen koordinierenden Master und keine bevorzugten Nachrichtenrechte. Jeder Name enthält neu erzeugte kryptografische Zufallsbytes. Alle Mitglieder starten mit dem aktiven Gesprächszweig, Systemkontext, Arbeitsmodell und Thinking-Level.

Der nächste echte User-Prompt und spätere Korrekturen erreichen alle Mitglieder. Sie bearbeiten denselben Projekt-Workspace, vereinbaren über Messageboxes selbst Aufgaben- und Dateiverantwortung und tauschen Befunde sowie Reviews aus. Das soll unabhängige Arbeit parallelisieren und die Prüfung komplexer Ergebnisse verbessern. Eine automatische Laufzeit- oder Qualitätsverbesserung ist damit nicht belegt; doppelte Arbeit und Konflikte müssen die Agenten durch Abstimmung vermeiden. Modellverbrauch entsteht für jedes aktive Mitglied separat.

- `/multiplex 4`: vier Mitglieder insgesamt, darunter das sichtbare Mitglied.
- `/multiplex` oder `/multiplex status`: Namen, Dimension und Peer-Zustände anzeigen.
- `/multiplex off` oder `/multiplex 0`: laufende Team-Arbeit abbrechen und Peer-Sessions bereinigen.
- Eine neue Dimension kann im Leerlauf eingestellt werden. Namen und Messageboxes werden dabei neu erzeugt.

Die Statusleiste zeigt `multiplex: n` und den Namen des sichtbaren Mitglieds. Bei einem `/goal` steht die Dimension zusätzlich am Anfang des Goal-Status, damit sie auf schmalen Terminals sichtbar bleibt. Peer-Antworten erscheinen mit Absender im Aktivitätsprotokoll. `/side` bleibt ein separater, rein erklärender Seitenchat; dortige Fragen werden nicht zu Team-Aufträgen.

## Messageboxes

Das Tool `mailbox` besitzt ausschließlich diese internen Operationen:

```json
{"operation":"peers"}
{"operation":"send","to":"agent-1234567890","text":"Ich übernehme parser.ts. Wer prüft die Fehlerpfade?"}
{"operation":"send","to":"*","text":"Parseränderung und lokale Prüfungen fertig; Belege stehen im Aktionsprotokoll."}
{"operation":"inbox"}
```

`*` adressiert alle anderen Mitglieder. Zustellung und Sequenznummern folgen der Sendereihenfolge; idle Mitglieder werden geweckt, arbeitende Mitglieder erhalten Steering. Ein Tool-Ergebnis bestätigt die Übergabe, nicht die Bearbeitung durch das Empfängermodell. Das Inbox-Archiv behält die letzten 128 empfangenen Nachrichten. Nachrichten haben höchstens 16 KiB; bis zu 256 noch nicht im Modellkontext beobachtete Nachrichten pro Empfänger sind möglich. Volle Queues melden Backpressure, ohne einen Broadcast teilweise anzunehmen. Nachrichteninhalte werden weder redigiert noch von einem Prüfmodell freigegeben.

Der Absender wird von der Extension an die Session gebunden und kann nicht als Tool-Argument überschrieben werden. Peer-Nachrichten bleiben ausdrücklich Peer-Daten; sie werden nie in echte Nutzerprompts oder Autorisierung umgewandelt. Ein Mitglied darf weder das Team konfigurieren noch für andere Mitglieder Freigaben erteilen.

## Freigabe, Belege und Lebensdauer

Jede externe Aktion jedes Mitglieds läuft durch dieselbe Auto-Approval-Extension und den zwingenden Sandbox-Executor. Freigaben für Netzwerk, zusätzliche Pfade, Git-Konfiguration oder Credentials gelten weiterhin nur für die jeweils geprüfte Aktion. Andere Tools und verschachtelte Tool-Aufrufe bleiben gesperrt. Nur die internen Messageboxes benötigen keine Freigabe.

Die Mitglieder teilen Projektdateien, besitzen aber unabhängige Gesprächsverläufe und private Sandbox-`/tmp`-Verzeichnisse. Vom vertrauenswürdigen Broker übertragene Aktionsurteile und Ergebnisbelege bleiben von freiem Nachrichtentext getrennt. Aktionsprüfer sehen auch Peer-Ablehnungen; Nachrichten können keine Ablehnung umgehen. Belege tragen den ursprünglichen Actor-Namen, Request-ID und Fingerprint, damit gleiche Tool-Call-IDs verschiedener Sessions nicht verwechselt werden.

Ein gemeinsames `/goal` und die Rückmeldung seines unabhängigen Zielprüfers erreichen auch die Peers. Der Abschluss wird erst geprüft, wenn laufende Peer-Arbeit beendet ist. Die Zielprüfung bleibt beim sichtbaren Gespräch und verwendet auch die protokollierten Peer-Aktionsergebnisse; dies verleiht dem sichtbaren Arbeitsagenten keine Weisungsrechte. `/goal stop` beendet auch noch arbeitende Peers, wenn das sichtbare Mitglied bereits im Leerlauf ist.

Beenden, Reload, Session-Wechsel oder Navigation im Session-Baum beenden das Team und löschen die temporären Daten der Peer-Sessions. Ein Abbruch des sichtbaren Modelllaufs beendet ebenfalls das Team. Wenn nur Peers arbeiten, beendet `/multiplex off` diese Arbeit. Multiplex wird nach einem Session-Wechsel nicht automatisch wiederhergestellt. Peer-Verläufe leben im Speicher; übertragene Ergebnisse und Urteile verbleiben im normalen Session-Protokoll.

Der Launcher lädt die Extension separat. Ihre SDK-Abhängigkeiten werden beim Startup mit den festgeschriebenen Abhängigkeiten von Auto-Approval verknüpft. Tests laufen ohne echte Modellanbieter im Integrationstest-Paket `../auto-approval`.
