# Kallubi Pay Button – Anleitung (Deutsch)

Version 1.2.0 · Lizenz Apache-2.0 · [English README](README.md)

> **Haftungshinweis:** Die Software wird **„wie sie ist“ und ohne jede Gewährleistung** bereitgestellt (Apache-2.0, Abschnitte 7
> und 8). Die Nutzung erfolgt **auf eigene Verantwortung**. Kallubi hat **nie Zugriff auf Gelder**: Käufer zahlen direkt an die
> Adresse des Shops, Kallubi kennt keine Schlüssel und verwahrt nichts. Eine Zahlung ohne Blockbestätigung (0-conf) ist **nie zu
> 100 % sicher**. Der Shop entscheidet selbst, ab wann er liefert, und prüft jede Zahlung auf dem eigenen Server. Keine Finanz-,
> Rechts- oder Steuerberatung.

## Was ist das?

Ein goldener Knopf **„Pay with BSV“** (auf deutschen Seiten „Mit BSV bezahlen“), den jeder Shop mit zwei Zeilen Code auf seine
Seite kopieren kann. Der Käufer scannt den QR-Code mit seiner Wallet und bezahlt **direkt an die Adresse des Shops**.
Kallubi bekommt kein Geld in die Hand, kennt keine Schlüssel und speichert nichts.

## So sieht der Code für einen Shop aus

```html
<script src="https://pay.kallubi-bsv-explorer.de/button.js" defer></script>
<div data-kallubi-pay data-to="1DEINE_BSV_ADRESSE" data-amount="0.0005"
     data-label="Basic T-Shirt" data-theme="auto"></div>
```

- `data-to` = BSV-Adresse des Shops (beginnt mit „1“). Eine falsche Adresse wird erkannt, dann erscheint eine Warnung statt des
  Knopfs. Eine Testnet-/STN-Adresse oder eine P2SH-Adresse („3…“) wird gesondert gemeldet.
- `data-amount` = Preis in BSV (0.0005 BSV = 50.000 sats), mindestens 1 Satoshi, höchstens 21000000 BSV.
- `data-theme` = `light` (helle Shops), `dark` (dunkle Shops) oder `auto` (richtet sich nach Hell/Dunkel beim Besucher).
- `data-style="outline"` = Knopf mit goldenem Rand, `data-size="sm"` = kleiner Knopf.
- `data-confirm-above-fiat` = **Euro-Grenze**: Preise **darüber** warten auf **1 Blockbestätigung**. Standard **200**. `0` = immer
  warten. Dollar-Preise rechnen diese Euro-Grenze mit dem EZB-Kurs um, BSV-Preise mit dem Euro-Kurs. Ohne gültigen Kurs wird gewartet.
  `data-confirm-above` bleibt ein optionaler BSV-Wert, wenn der Shop die Grenze fest in BSV setzen will (nicht zusammen mit `-fiat`).

## Preis in Euro oder Dollar

`data-amount-fiat="25.00" data-currency="EUR"` statt `data-amount`. Beim Öffnen holt der Knopf den aktuellen Kurs (zuerst
CoinGecko; Ersatz: öffentliche Blockchain-API für USD, für EUR zusätzlich der offizielle EZB-Referenzkurs). Der BSV-Betrag wird
immer **aufgerundet**, der Shop bekommt also nie zu wenig. Im Fenster stehen Preis, Kurs, Uhrzeit und Kursquelle.
**Ohne frischen Kurs (höchstens 10 Minuten alt) gibt es keinen QR-Code.**

## Sprachen

Englisch, Deutsch, Spanisch, Französisch, Italienisch und Portugiesisch. Normal nimmt der Knopf die Sprache der Shop-Seite
(`<html lang="de">`); fest einstellen geht mit `data-lang="de"`. Die Browsersprache des Käufers zählt bewusst nicht.
Beträge stehen immer mit **Punkt** (z. B. `0.0005 BSV`), genau wie in der Wallet und im QR-Code.

## Lieferadresse (optional)

```html
<div data-kallubi-pay data-to="1DEINE_BSV_ADRESSE" data-amount="0.0005" data-label="Hoodie" data-merchant="Merch Shop"
     data-shipping="1" data-shipping-email="bestellung@shop.example"></div>
```

- `data-shipping="1"`: vor dem QR-Code kommt ein Formular (Name, Straße, PLZ, Ort, Land, E-Mail und Nachricht freiwillig).
- **Die Adresse geht nur an den Shop, nie an Kallubi.** Kallubi speichert nichts.
- `data-shipping-email`: Nach der Zahlung öffnet ein Knopf das Mailprogramm des Käufers mit Adresse und Transaktion.
- `data-shipping-url="https://…"`: Der Browser des Käufers schickt die Adresse direkt an diese Adresse des Shops. Bei einem
  fremden Formular-Dienst braucht der Shop einen AV-Vertrag (DSGVO).

## Wie erkennt der Knopf die Zahlung?

1. Beim Öffnen hängt er ein paar zufällige sats an den Preis (z. B. 50.000 → **50.037 sats**). Das hilft, Zahlungen
   auseinanderzuhalten, ist aber keine Garantie.
2. Alle 5 Sekunden fragt er nach, ob eine **neue** Zahlung mit mindestens diesem Betrag an die Adresse ging: zuerst bei der
   Kallubi-Node, wenn nötig bei einer öffentlichen Blockchain-API. Der Betrag wird immer aus der echten Transaktion gelesen
   (Prüfsumme = Transaktions-ID), nie aus einer fremden Zahl.
3. **Bestätigungsregel:**
   - Eine **nicht endgültige** Transaktion (Zeitsperre) gilt nie sofort als bezahlt.
   - Bis **20,00 €** gilt eine gesehene Zahlung sofort als bezahlt.
   - Bis **200,00 €** (einstellbar) nur nach der **Schnellprüfung**: Kallubi-Node und BSV Broadcaster kennen die Zahlung,
     5 Sekunden keine Doppelausgabe, genug Gebühr.
   - Darüber, oder wenn die Prüfung fehlschlägt oder nicht möglich ist: „warte auf 1 Bestätigung (~10 Min.)“.
4. Nach 15 Minuten ohne Zahlung (einstellbar mit `data-expires-min`, 1–60) verschwindet der QR-Code. Eine spätere Zahlung wird
   als **„zu spät“** gemeldet (`kallubi:late`), nicht als bezahlt.

**Restrisiko (ehrlich):** 0-conf ist nie 100 % sicher. Eine Doppelausgabe kann auch nach den 5 Sekunden noch erscheinen.
Bei teurer Ware oder hohem Risiko: `data-confirm-above-fiat` senken oder `0` setzen (immer auf 1 Bestätigung warten).

## Wichtig für Shops: Zahlung auf dem eigenen Server prüfen

Die Meldung im Browser (`kallubi:paid`) ist **nur für die Anzeige**. Jeder, der den Browser bedient, kann sie fälschen.
Vor dem Versand prüft der Shop die Zahlung auf dem eigenen Server mit `verify/kallubi-verify.mjs` (Node 18+, keine Abhängigkeiten):
richtige Adresse, richtiger Betrag aus der echten Transaktion, nicht zu alt, nicht zu spät, und dieselbe Transaktion zählt nur
für **eine** Bestellung.

Für 0-conf über 20 € gibst du `quickCheck: 'run'` mit, dann macht dein Server die Schnellprüfung selbst.
**Nimm nie den `quickCheck`-Wert aus dem Browser-Ereignis.** Den kann der Käufer fälschen; die Prüfung nimmt nur Ergebnisse an,
die dein eigener Server mit `runQuickCheck()` erzeugt hat.

## Selbst ausprobieren (ohne echtes Geld)

Im Ordner `demo/` liegt eine Testseite mit zwei Fantasie-Shops. Dort ist der **Testmodus** an (`data-test="1"`): Nach ca.
8 Sekunden wird eine Zahlung nur **simuliert**. Die Adresse in der Demo ist eine bekannte „Null-Adresse“, an die man
**niemals echtes Geld schicken darf**.

## Datenschutz

Keine Cookies, kein Tracking, keine Statistik. Der Browser des Käufers fragt nur die Kallubi-Node, eine öffentliche
Blockchain-API, die Kursdienste (bei Euro/Dollar-Preisen und für die Euro-Grenze) und BSV Broadcaster (Schnellprüfung) –
mit öffentlicher Adresse und Transaktions-ID, ohne Referrer. Die genaue Liste für eine Content Security Policy steht in der
[README](README.md#security--privacy).
