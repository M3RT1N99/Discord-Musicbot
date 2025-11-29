# 🎵 Discord Musicbot - Neue Features

## 🔍 Erweiterte Suchfunktion

### `/play` Command mit Suchfunktion
Der `/play` Command wurde erweitert und unterstützt jetzt:

#### 1. **YouTube URL Eingabe**
```
/play https://www.youtube.com/watch?v=lC4GM36D3Xk&list=RDi0EDUaFNSJk&index=4
```
- URLs mit Parametern werden automatisch bereinigt
- Nur die Video-ID wird extrahiert
- Funktioniert mit allen YouTube URL-Formaten:
  - `youtube.com/watch?v=...`
  - `youtu.be/...`
  - `m.youtube.com/watch?v=...`
  - `music.youtube.com/watch?v=...`

#### 2. **Textsuche mit Auswahlliste**
```
/play Bohemian Rhapsody
```
- Zeigt bis zu **10 Suchergebnisse** an
- Jedes Ergebnis enthält:
  - **Titel** des Videos
  - **Uploader/Kanal**
  - **Dauer** des Videos
  - **Nummer** für die Auswahl (1-10)

### `/select` Command
```
/select 3
```
- Wählt ein Lied aus den Suchergebnissen aus
- Gültige Nummern: 1-10
- Suchergebnisse sind **5 Minuten** gültig
- Nach der Auswahl wird das Lied sofort abgespielt

## 🛡️ Sicherheitsverbesserungen

### URL-Bereinigung
- **Parameter-Entfernung**: Alle URL-Parameter werden entfernt
- **Video-ID Extraktion**: Nur gültige YouTube Video-IDs werden akzeptiert
- **Domain-Validierung**: Nur erlaubte YouTube-Domains

### Cache-System
- **Benutzer-spezifisch**: Jeder Benutzer hat eigene Suchergebnisse
- **Zeitbasiert**: Automatische Löschung nach 5 Minuten
- **Speicher-effizient**: Cache wird nach Auswahl geleert

## 📋 Verwendungsbeispiele

### Beispiel 1: Suche nach einem Lied
```
Benutzer: /play Queen Bohemian Rhapsody
Bot: 🔍 Suche nach Videos...

🎵 Suchergebnisse:

1. Queen - Bohemian Rhapsody (Official Video)
   👤 Queen Official | ⏱️ 5:55

2. Queen - Bohemian Rhapsody (Live Aid 1985)
   👤 Queen Official | ⏱️ 5:12

3. Bohemian Rhapsody - Queen (Lyrics)
   👤 Music Lyrics | ⏱️ 5:55

...

💡 Verwende /select <nummer> um ein Lied auszuwählen (z.B. /select 1)

Benutzer: /select 1
Bot: 🎵 Spiele: Queen - Bohemian Rhapsody (Official Video)
```

### Beispiel 2: Direkte URL mit Parametern
```
Benutzer: /play https://www.youtube.com/watch?v=lC4GM36D3Xk&list=RDi0EDUaFNSJk&index=4
Bot: 🎵 Spiele: [Titel des Videos]
```
- Parameter `&list=...` und `&index=...` werden automatisch entfernt
- Nur die Video-ID `lC4GM36D3Xk` wird verwendet

### Beispiel 3: Cache-Ablauf
```
Benutzer: /play Rock Music
Bot: [Zeigt Suchergebnisse]

[5 Minuten später]

Benutzer: /select 2
Bot: ❌ Suchergebnisse sind abgelaufen. Verwende /play <suchbegriff> für eine neue Suche.
```

## 🔧 Technische Details

### Neue Funktionen
- `cleanYouTubeUrl(url)`: Bereinigt URLs von Parametern
- `searchYouTubeVideos(query, maxResults)`: Sucht nach Videos
- Search Cache System mit automatischer Bereinigung

### Sicherheitsmaßnahmen
- **Input-Validierung**: Alle Eingaben werden validiert
- **URL-Whitelist**: Nur YouTube-Domains erlaubt
- **Rate-Limiting**: Schutz vor Spam
- **Cache-Limits**: Automatische Bereinigung

### Performance
- **Effiziente Suche**: Bis zu 10 Ergebnisse in einer Anfrage
- **Cache-System**: Reduziert wiederholte API-Aufrufe
- **Memory-Management**: Automatische Cache-Bereinigung

## 🚀 Vorteile

### Für Benutzer
- **Einfache Suche**: Keine URLs nötig
- **Auswahl**: Bis zu 10 Optionen
- **Flexibilität**: URLs und Text funktionieren
- **Sicherheit**: Nur sichere YouTube-Inhalte

### Für Administratoren
- **Sicherheit**: Umfassende Input-Validierung
- **Performance**: Effizientes Cache-System
- **Monitoring**: Detaillierte Logs
- **Wartung**: Automatische Bereinigung

## 🔄 Workflow

1. **Suche starten**: `/play <suchbegriff>`
2. **Ergebnisse anzeigen**: Bot zeigt bis zu 10 Optionen
3. **Auswahl treffen**: `/select <nummer>`
4. **Musik abspielen**: Bot spielt das gewählte Lied

## ⚠️ Wichtige Hinweise

- Suchergebnisse sind **5 Minuten** gültig
- Nach der Auswahl wird der Cache geleert
- Nur **YouTube-Inhalte** werden unterstützt
- **Rate-Limiting** verhindert Spam (10 Downloads/Minute)
- URLs werden automatisch von Parametern bereinigt