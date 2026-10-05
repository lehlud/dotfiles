# Öffentliche Texte prüfen

Diese Pi-Extension ersetzt den Skill `avoid-wikipedia-ai-writing-signs`. Vierzehn lokal gespeicherte Regelgruppen decken unter anderem künstliche Gegensätze, unbelegte Bedeutungszuschreibungen, vage Quellen, Werbefloskeln, formelhafte Schlüsse und Chat-Reste in Veröffentlichungen ab. Ausgangspunkt ist [diese Wikipedia-Fassung](https://en.wikipedia.org/w/index.php?oldid=1378298730&title=Wikipedia:Signs_of_AI_writing), einmalig am 5. Oktober 2026 gelesen. Zur Laufzeit wird Wikipedia nicht abgerufen.

Das bestehende unabhängige Prüfmodell beurteilt die Muster im Kontext und in der Originalsprache. Es gibt keine Wortlisten oder regulären Ausdrücke pro Sprache. Die Prüfung gilt für neu verfasste oder wesentlich umformulierte Texte für Website-/App-Besucher, öffentliche Artikel, Dokumentation und Veröffentlichungsentwürfe, auch innerhalb von Quellcode, Templates und Übersetzungsdateien. Normale Antworten an den Betreiber von Pi, reine Codesyntax, Daten ohne Veröffentlichungstext und unverändert übernommene Texte bleiben ausgenommen. Fachlich nötige Gegensätze, Namen, vorgeschriebene Zitate und ausdrückliche Stilvorgaben des Betreibers bleiben erhalten. Die Regeln dienen der Redaktion; sie beweisen keine KI-Autorschaft.

Die Extension gibt dem Hauptmodell feste Anweisungen, diese Regeln bereits beim Verfassen öffentlicher Texte anzuwenden. Beim Speichern prüft der bestehende Action-Reviewer die neuen Formulierungen mit; ein zusätzlicher Stilaufruf für denselben Schreibvorgang ist nicht nötig. Für öffentliche Entwürfe im Chat und Prüfungen ohne Speichern steht innerhalb von `approved_action` die Operation `writing_check` bereit:

```json
{
  "tool": "writing_check",
  "arguments": {
    "text": "Wir reparieren Fahrräder. Geöffnet Dienstag bis Samstag, 9–18 Uhr.",
    "audience": "public",
    "format": "plain",
    "context": "Besuchertext für die Website einer Fahrradwerkstatt."
  },
  "goal": "Öffentlichen Entwurf prüfen",
  "justification": "Die neuen Formulierungen vor dem Speichern redaktionell prüfen."
}
```

`text` erlaubt 1–20.000 Zeichen, `context` höchstens 2.000; `format` kann `plain`, `markdown` oder `html` sein. Bei längeren Veröffentlichungen werden zusammenhängende Abschnitte einzeln geprüft. `audience: "operator"` kennzeichnet ausschließlich interne Kommunikation. Die tatsächliche Nutzerabsicht entscheidet über den Geltungsbereich; ein falsches Label schafft keine Ausnahme.

Eine Ablehnung enthält eine konkrete Fundstelle und eine gezielte Korrekturanweisung. Das Hauptmodell überarbeitet den Text und stellt eine neue Anfrage. Es wird nach einer gültigen Ablehnung kein anderes Prüfmodell versucht. Eine Genehmigung führt offline zu einem Beleg mit SHA256 des exakten Texts und Regelversion; dieser Beleg gilt nur zusammen mit dem zugehörigen Approval-Protokoll. Es gibt keinen zweiten Modellaufruf im Executor. Eine Stilfreigabe genehmigt weder einen Schreibvorgang noch eine Veröffentlichung.

Auch normale Write-/Edit-/Shell-Anfragen, die öffentliche Formulierungen ändern, werden vom Reviewer anhand derselben Regeln geprüft. Die Regeln gelten unabhängig von `/goal`; dessen Abschlussprüfung bleibt unverändert. Für reine Veröffentlichungsentwürfe in Chat-Antworten ist die Vorabprüfung eine Anweisung an das Hauptmodell; es gibt keinen nachgeschalteten Filter für jede Chat-Nachricht. Wie jede semantische Modellprüfung kann sie Formulierungen falsch einordnen oder übersehen.

Der Launcher `~/.local/bin/pi` lädt die Extension mit dem Approval-Gate und Web-Recherche. Ein Neustart lädt Änderungen. Die native Executor-Erstellung berücksichtigt Änderungen an Regeln, Tool und Dependencies. Nach Änderungen am Docker-Backend muss dessen Image mit einem neuen Digest neu gebaut werden.

```bash
bun run check
bun test tests/extension.test.ts
bun tests/reviewer.eval.ts
```

Der letzte Aufruf nutzt die konfigurierten Prüfmodelle und verursacht Modellanfragen. Er prüft sechs Sprachen, notwendige Gegensätze, Zitate, interne Kommunikation, falsch bezeichnete Entwürfe, öffentliche Datei-/Shell-Schreibvorgänge, Besuchertexte in Quellcode, reine Layoutänderungen und negative Testdaten. Er führt keine vorgeschlagenen Schreib- oder Shell-Aktionen aus. Ein optionales Argument filtert die Fallnamen, etwa `bun tests/reviewer.eval.ts 'public UI prose'`.

Validierung am 5. Oktober 2026: 164 automatische Prüfungen bestanden, darunter echte bwrap-Isolation, sowie 19 unterschiedliche semantische Fälle mit dem konfigurierten Reviewer. Drei zusätzliche vollständige Gate-/Executor-Aufrufe bestätigten Ablehnung, Stilbeleg und Betreiber-Ausnahme. Der echte Pi-Resource-Loader lädt alle drei Extensions ohne den ersetzten Skill. TypeScript-Prüfungen aller drei Extensions, Shell-Syntax und Diff-Prüfung bestanden. Docker wurde nicht live getestet.

Die semantischen Urteile wurden geprüft, die Sprache sämtlicher Begründungen wurde nicht als Passkriterium erzwungen. Bei isolierten Fixture-Anfragen antwortete der Reviewer teilweise auf Englisch trotz deutscher Betreiberanfrage; im vollständigen Gate-Test waren alle drei Begründungen deutsch. Die Sprachvorgabe ist zusätzlich im Regeltext und im OpenAI-Ausgabeschema verankert, aber noch nicht zuverlässig erzwungen. Das betrifft die Begründung, nicht eine Übersetzung des geprüften Entwurfs.
