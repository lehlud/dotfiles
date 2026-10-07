# Pi Provider Recovery

Diese eigenständige Extension installiert Transport-Recovery für Arbeitsmodelle. Sie registriert keine Aktions-Tools und besitzt keine Freigaberechte. Die gemeinsam verwendeten Verfügbarkeits- und Stream-Helfer bleiben bei Auto-Approval, damit dessen Reviewer dieselben Cooldowns nutzen können.

## Provider-Ausfälle und Wiederholungen

Arbeitsmodell, Aktions-/Zielprüfung, Prompt-Kompression und Seitenchat verwenden eine gemeinsame Verfügbarkeitssteuerung. Der Zustand gilt pro Provider **und Modell-ID**, unabhängig von der Thinking-Einstellung. Ein Ausfall von `openai/Modell-A` sperrt weder `openai/Modell-B` noch dieselbe Modell-ID bei einem anderen Provider.

Nach einem vorübergehenden Transport-/Serverfehler folgen auf den ersten Aufruf höchstens **fünf Wiederholungen**, jeweils nach **drei Sekunden**. Dazu gehören der gezeigte HTTP-507-Bufferfehler, übliche 5xx-Fehler, vorübergehende 429-Drosselung und Verbindungsabbrüche. Scheitert die Serie vollständig, erfolgen für **fünf Minuten** keine weiteren Aufrufe dieses Paars. Der nächste angeforderte Aufruf nach Ablauf darf genau **einen** Erreichbarkeitsversuch machen. Gleichzeitige Anfragen dürfen diesen Prüfaufruf nicht vervielfachen. Bei erneutem Ausfall beginnt eine weitere fünfminütige Pause; nach einer erreichbaren Antwort erhält der nächste Ausfall wieder die volle Wiederholungsserie. Gesunde Gespräche dürfen parallel laufen.

Es laufen keine Hintergrund-Probes oder automatischen Aktionen während der Pause. Prüfungen dürfen in dieser Zeit nur die ausdrücklich konfigurierten Fallback-Modelle verwenden; das Arbeitsmodell wird nicht stillschweigend gewechselt. Der Zustand bleibt innerhalb desselben Pi-Prozesses über Session-Wechsel und Neuladen erhalten, wird aber nicht auf Platte gespeichert. Beim Neustart beginnt die Erreichbarkeitsprüfung neu.

Fachliche Ablehnungen, vollständige requestgebundene Denials vor einem Streamfehler, ungültige Urteile, Refusals und unzulässige Prüfmodell-Tools bleiben endgültig. Lokale Modell-/Login-/Kapazitätsfehler, Schemafehler und ausgeschöpfte Kontingente starten keine sinnlose Transportserie. Nutzerabbruch und bestehende Zeitlimits gelten auch während Wartezeiten. Ein Abbruch behauptet keinen Provider-Ausfall. Fehler bei der Retry-Protokollierung stoppen die Prüfung ohne Fallback.

Wiederholungen behalten denselben unveränderten Anfrageinhalt und produzieren eine einzelne Assistant-Nachricht. Bereits gemeldete Tokens und Kosten aller Versuche werden summiert. Endgültige Ausfallmeldungen enthalten keine rohen Provider-Daten und lösen keine weitere Retry-Serie des Pi-SDK aus. Wiederholungsnummer und Wartezeit erscheinen vorübergehend im Status und als Metadaten im Session-Protokoll.
