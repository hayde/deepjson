# TODO

Offene Punkte, gefunden beim Durcharbeiten der Bugliste und beim Testen gegen
einen lokal laufenden Server. Sortiert nach Dringlichkeit, nicht nach Aufwand.

Jeder Punkt nennt die Fundstelle und warum er zählt. Alles hier ist verifiziert,
also am laufenden Server oder im Code nachgewiesen, nicht vermutet.

---

## Stille Fehler

Fehler, die niemanden anschreien und deshalb lange unbemerkt bleiben.

### 1. `application/json` beim Schreiben eines Keys stürzt ab

`parseScriptPayload()` ([server.js:1109](server.js#L1109)) erwartet einen String und
ruft `.indexOf()` darauf auf. Bei `Content-Type: application/json` hat aber bereits
`express.json()` zugegriffen und ein Objekt daraus gemacht, also scheitert es mit
`body.indexOf is not a function`. Mit `text/plain` funktioniert derselbe Aufruf.

Ausgerechnet der Content-Type, den man bei einem JSON-Server zuerst probiert, ist
der einzige, der nicht geht.

**Lösung existiert bereits im Projekt:** `parseMoveBody()`
([server.js:2223](server.js#L2223)) behandelt genau diesen Fall korrekt und prüft
zuerst mit `_.isObject(req.body)`, ob der Body schon geparst vorliegt. Dasselbe
Muster fehlt in `parseScriptPayload()`.

### 2. `custom` geht verloren, wenn das Skript den Key anlegt

`writeKeyData()` ([server.js:1605](server.js#L1605)) baut für einen noch nicht
existierenden Key einen frischen Datensatz aus `_key`, `_hash`, `_created`,
`_modification`, `_modCounter` und `value` und verwirft dabei alles andere,
darunter `custom`. Auf einem bereits bestehenden Key bleibt `custom` erhalten,
weil dort der eingehende Datensatz komplett übernommen wird.

Diese Asymmetrie macht es schwer zu finden: es funktioniert, sobald man es ein
zweites Mal versucht.

Nachgewiesen an der Rohdatei auf der Platte, abgedeckt durch
`bin/test-scripting.js` (dort als bekannter Defekt markiert).

### 3. Skript kennt beim Anlegen seinen eigenen Key nicht

`processScriptBody()` ([server.js:883](server.js#L883)) befüllt `key` aus
`data._key` und `hash` aus `data._hash`. Bei einem neuen Key ist `data`
undefined, also sind beide `undefined`, obwohl der Keyname in der URL steht und
der Hash daraus berechenbar wäre.

Ein Skript, das beim Anlegen seinen Keynamen in den Wert schreiben möchte, kann
das derzeit nicht.

### 4. `deepjson-server-setup.sh` erzeugt eine fehlerhafte Konfiguration

Vier Fehler, alle still, alle im erzeugten Ergebnis, nicht im Skriptlauf:

- **`hmac_øauth_settings`** ([Zeile 54](deepjson-server-setup.sh#L54)) enthält ein
  `ø`. Der Code liest `hmac_auth_settings`, also wird `device_auth_enabled: true`
  nie gesehen und die HMAC-Geräteauthentifizierung ist abgeschaltet, obwohl die
  Konfiguration das Gegenteil behauptet.
- **`socketServer`-Verschachtelung** ([Zeile 29](deepjson-server-setup.sh#L29)):
  der Code liest `preventDuplicateSessionConnections`,
  `allowMultipleSessionConnections` und `maxClientsPerSession` auf oberster Ebene.
  Verschachtelt sind sie wirkungslos, `clients.length >= undefined` ist immer
  falsch, das Client-Limit greift also nie.
- **Vorbereitete `dj.index` mit `#`-Kommentaren**
  ([Zeile 87](deepjson-server-setup.sh#L87)): `loadIndex()` kennt keine
  Kommentarzeilen und erzeugt daraus zwei echte Index-Einträge mit den Keys
  `"# Initial DeepJSON index file"` und `"# Format: key"`. Die Datei sollte leer
  sein.
- **`emptySessionTTL` fehlt** ganz. Ein `setTimeout` mit `undefined` feuert
  praktisch sofort, leere Sessions würden also unmittelbar aufgeräumt.

Dazu: **`valid_until`** beim Gerät ([Zeile 50](deepjson-server-setup.sh#L50)) wird
im Code nirgends ausgewertet. Das Feld suggeriert ein Ablaufdatum, das es nicht
gibt.

---

## Härtung

### 5. Validierung sollte unbekannte Konfigurationsschlüssel melden

`validateConfig()` prüft bekannte Schlüssel auf sinnvolle Werte, bemerkt aber
nicht, wenn ein Schlüssel falsch geschrieben ist oder an der falschen Stelle
steht. Eine Warnung bei unbekannten Schlüsseln auf oberster Ebene hätte sowohl
`socketServer` als auch `hmac_øauth_settings` aus Punkt 4 sofort sichtbar gemacht.

### 6. CORS-Whitelist um Muster erweitern

`isOriginAllowed()` ([server.js:348](server.js#L348)) vergleicht exakte
Zeichenketten. Muster wie `http://localhost:*` für beliebige Ports oder
`https://*.example.com` für Subdomains wären praktisch.

Wichtig dabei, sonst wird die Whitelist zur Attrappe: zu breite Muster müssen
beim Start abgelehnt werden. `https://*` würde das gesamte Web erlauben, und `*`
allein trifft aufgrund der Schrägstriche ausgerechnet nur auf `null` zu. Zulässig
sollten nur zwei Formen sein, Port-Wildcard direkt hinter einem Doppelpunkt und
Subdomain-Wildcard direkt vor einem Punkt mit mindestens zwei folgenden Labels.

### 7. Zentrale Fehlerbehandlung fehlt

Es gibt keine Express-Fehler-Middleware. Folgen: ein abgelehnter CORS-Origin
liefert `500` statt `403`, und ein zu großer Body liefert eine HTML-Fehlerseite
mit Stacktrace statt JSON. Clients, die JSON erwarten, bekommen dort zusätzlich
Parsing-Probleme.

### 8. Upload-Limit für Dateien ist fest verdrahtet

50 MB in `express-fileupload` ([server.js:314](server.js#L314)). `payload_limit`
und `text_payload_limit` sind konfigurierbar, dieses Limit nicht.

---

## Fehlende Funktionalität

### 9. `performIndexRotation()` ist nicht erreichbar

Die Methode ([server.js:1449](server.js#L1449)) existiert samt Archivierung und
Aufbewahrungsgrenze, wird aber von keiner Route und keinem Scheduler aufgerufen.
Rotation lässt sich derzeit nur per Skript auslösen. Entweder eine Admin-Route
ergänzen oder bewusst dokumentieren, dass das von außen per Cron passiert.

### 10. Kein Ping-/Whoami-Endpoint

Es gibt keine leichte, seiteneffektfreie Route, um zu prüfen, ob man angemeldet
ist. Ein Client müsste auf eine echte Ressource ausweichen, wo ein `403` wegen
fehlender Rechte nicht von "nicht angemeldet" unterscheidbar ist. Wäre außerdem
die natürliche Stelle, um nebenbei den `X-Renewed-Token` abzuholen.

### 11. `archiving_url` ist dokumentiert, aber nicht implementiert

`cleanupIndexArchive()` ([server.js:1227](server.js#L1227)) beschreibt den
geplanten Vertrag und loggt nur eine Warnung, wenn die URL gesetzt ist. Entweder
umsetzen oder die Option entfernen.

---

## Client-Seite

### 12. Sliding Session greift nicht für direkte Bild-URLs

Ein `<img src="...">` kann keine Response-Header lesen, bekommt also
`X-Renewed-Token` nie mit. Der Token in einer Bild-URL bleibt auf dem Stand des
Seitenaufbaus eingefroren, und nach einer Stunde zeigen die Bilder auf einer lange
offenen Seite nichts mehr an, obwohl der Nutzer sonst noch angemeldet ist.

### 13. Connector sollte `file://` erkennen

Läuft die einbindende Seite als Datei statt über einen HTTP-Server, sendet der
Browser `Origin: null` und die Anfrage wird abgewiesen. Der Browser meldet nur
einen undurchsichtigen CORS-Fehler. Der `deepjson-js-connector` könnte
`window.location.protocol === 'file:'` prüfen und eine klare Meldung ausgeben.

---

## Dokumentation

### 14. README fehlt, `package.json`-Metadaten sind leer

Kein README im Projekt, und `description`, `author` sowie `keywords` in
`package.json` sind unausgefüllt. Letzter offener Punkt aus der ursprünglichen
Bugliste.
