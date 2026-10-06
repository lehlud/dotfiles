# Web-Recherche für Pi

Die Extension ersetzt den bisherigen `web-research`-Skill. Der Launcher lädt sie zusammen mit Auto-Approval. Das Modell nutzt die Operationen über `approved_action`; Suche und Seitenabruf erhalten jeweils erst nach der unabhängigen Prüfung Netzwerkzugriff. Direkte Werkzeuge und alternative Ausführungswege bleiben gesperrt.

Webaktionen laufen in einem leeren, schreibgeschützten `/workspace`. Projekt- und Home-Dateien werden weder eingebunden noch durchsucht. Ein fehlender alter Skill oder ein problematischer Projektverweis kann deshalb keine Websuche blockieren. Zusätzliche Datei-, PATH- oder Tool-Freigaben sind für Webaktionen nicht vorgesehen und werden zurückgewiesen. Das private Session-`/tmp` bleibt verfügbar und wird weiterhin auf unzulässige Hardlinks geprüft. Die statischen Regeln für öffentliche Texte kommen aus der eigenen Extension; der gelöschte Wikipedia-Skill wird nicht benötigt.

`websearch` verwendet [DDGS](https://github.com/deedy5/ddgs) und liefert Titel, URL und einen kurzen Text pro Treffer. Standard sind fünf Treffer, höchstens zehn. Optional: `region` (Standard `wt-wt`) und `timeLimit` (`d`, `w`, `m`, `y`). DDGS kann mehrere öffentliche Suchanbieter nutzen. Die Suchanfrage wird an diese Anbieter übertragen.

```json
{"tool":"websearch","arguments":{"query":"site:docs.python.org asyncio TaskGroup","maxResults":5},"goal":"Offizielle Dokumentation finden","justification":"Die API anhand aktueller Primärquellen prüfen"}
```

`webfetch` liest eine einzelne öffentliche HTTP(S)-URL. [Trafilatura](https://trafilatura.readthedocs.io/en/latest/usage-python.html) extrahiert den lesbaren Text; HTML-Tags, Skripte, Navigation und Footer werden entfernt. Die Modellantwort enthält ausschließlich den Seitentext. Freigabe, Quell-URL und Fortsetzungsdaten bleiben in den Ergebnisdetails und im Aktivitätsprotokoll.

```json
{"tool":"webfetch","arguments":{"url":"https://docs.python.org/3/library/asyncio-task.html","maxChars":20000,"offset":0},"goal":"TaskGroup verstehen","justification":"Die gefundene offizielle Dokumentation lesen"}
```

Standard sind 20.000 Zeichen; `maxChars` erlaubt 100 bis 80.000 Zeichen. `offset` liest einen späteren Abschnitt. Die Ergebnisdetails enthalten `finalUrl`, `totalChars`, `hasMore` und `nextOffset`. Die Anzeige klappt lange Ergebnisse zunächst ein; `ctrl+o` zeigt den vollständigen Abschnitt. Freigaben stehen im Aktivitätsprotokoll, ohne zusätzlichen Text vor der Eingabe.

Seitenabrufe sind GET-Anfragen ohne Cookies, Zugangsdaten oder benutzerdefinierte Header. Jede Weiterleitung wird geprüft. Lokale/private IP-Adressen werden abgewiesen; die Verbindung nutzt die zuvor geprüfte IP-Adresse. Downloads sind auf 2 MB begrenzt. JavaScript-Seiten, PDFs und andere Binärformate werden nicht ausgeführt beziehungsweise nicht extrahiert. HTTP-Fehler oder unlesbare Inhalte werden als Fehler gemeldet.

Beim Operator-Start installiert `bootstrap.ts` die festgeschriebenen JavaScript-Dependencies und `setup.py` mit `/usr/bin/python3` die festgeschriebenen Python-Wheels. Setup und Sandbox verwenden denselben Linux-Interpreter; geteilte macOS-Launcher werden nicht verwendet. Der Python-Cache ist nach Linux-Plattform, Architektur, Python-Version und Requirements getrennt. Die Sandbox bindet nur diese Dependencies und den Worker lesbar ein. HTTPS prüft Serverzertifikate gegen das mitgelieferte öffentliche CA-Bundle. Es gibt keine Installation aus einem Modell-Werkzeug. Sessiondaten liegen weiterhin im privaten `/tmp` und werden beim Ende oder Wechsel der Session gelöscht.

Für das Docker-Backend das Executor-Image mit dem Verzeichnis `~/.pi/agent/extensions` als Build-Kontext und `auto-approval/Dockerfile` als Dockerfile neu bauen und dessen Digest außerhalb von Pi konfigurieren. Python und Web-Dependencies liegen dann im Image. Der native Lubox/bwrap-Pfad verwendet den vorbereiteten Linux-Cache.

Prüfung: `bun test tests`, `bun node_modules/typescript/bin/tsc --noEmit` und `python3 -m unittest discover -s tests -p 'test_*.py'`. Die Python-Tests benötigen den zuvor vorbereiteten Runtime-Cache; die regulären Tests rufen keine externen Websites auf.
