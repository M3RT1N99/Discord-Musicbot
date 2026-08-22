# Code-Review Musicbot — 22.08.2026

Verifizierter Befund über den gesamten Bot (≈3.900 Zeilen, 17 Module + Docker-Infra). 39 Agenten: 7 unabhängige Prüf-Perspektiven, Dedup, Vollständigkeits-Kritiker, pro Fund ein adversarialer Verifizierer.

> **Status:** Alle 27 bestätigten Funde sind behoben, gegenverifiziert (25 vollständig, 2 mit dokumentierter Restlücke: F11 nur Log-Hinweis ohne Stage-Moderator-Recht, F27 via Gateway-Heartbeat abgedeckt) und mit Commit `67035f6` deployed. Datei-/Zeilenangaben beziehen sich auf den Stand **vor** den Fixes (Commit `3f8c5db`).

**Übersicht:** 3 hoch · 13 mittel · 11 niedrig · 4 plausibel · 2 widerlegt

## Bestätigte Funde (27)

### F01 · Hoch · Doppelter Track-Advance durch await-Lücke in ensureNextTrackDownloadedAndPlay (filepath-Pfad)

`src/queue/QueueManager.js:132` — Playback

ensureNextTrackDownloadedAndPlay prüft 'player.state.status === Playing' und 'q.isDownloading' nur VOR dem 'await fs.promises.access(next.filepath)'. Der filepath-Pfad setzt isDownloading nie und re-prüft nach dem await nichts. Zwei parallele Aufrufer (z.B. Idle-Handler in Zeile 87 und der .then-Callback nach Download in commandHandlers.handleSingleUrlPlay Zeile 173-175, oder zwei gleichzeitige /play-Cache-Hits) passieren beide die Guards, suspenden beide am access-await und rufen anschließend beide playNextInGuild auf. Der zweite Aufruf killt in Zeile 234-237 das gerade gespawnte ffmpeg des ersten (q.currentFfmpeg) und shiftet einen weiteren Track.

**Szenario:** Song endet (Idle-Handler ruft ensureNext) im selben Moment, in dem ein Download in handleSingleUrlPlay fertig wird (Status-Check sieht Idle, ruft ensureNext ebenfalls). Beide sehen songs[0] mit filepath, beide awaiten access, beide rufen playNextInGuild: Track A wird geshiftet und sein ffmpeg sofort gekillt, Track B startet stattdessen -> Track A wird ohne Wiedergabe verworfen; currentTrack/previousTrack sind inkonsistent.

### F02 · Mittel · cleanupGuildResources zerstört die VoiceConnection nie — Connection- und Listener-Leck mit gestapelten Disconnect-Timern

`src/queue/QueueManager.js:469` — Ressourcen

cleanupGuildResources (Z. 469-496) killt FFmpeg, stoppt den Player und löscht die Queue, ruft aber nie queue.connection.destroy() auf. Diese Funktion ist der Cleanup-Pfad für den 15s-Disconnect-Timeout (Z. 34-41). Die nicht zerstörte VoiceConnection bleibt im internen Registry von @discordjs/voice (Status Disconnected). Beim nächsten /play gibt joinVoiceChannel für dieselbe Guild genau dieses Connection-Objekt zurück (joinVoiceChannel reused bestehende, nicht-destroyte Connections), und createPlayerForGuild (Z. 31-55) hängt erneut 3 Listener (Disconnected, Ready, Destroyed) an dasselbe Objekt. Die Listener der vorherigen Session werden nie entfernt — pro Disconnect/Play-Zyklus 3 zusätzliche Listener.

**Szenario:** Bot verliert die Voice-Verbindung >15s (Kick, Netzwerk-Hänger, Region-Wechsel) -> cleanupGuildResources löscht die Queue, Connection bleibt dauerhaft im Registry. User startet /play erneut -> gleiche Connection bekommt neue Listener. Nach jedem weiteren Disconnect/Rejoin-Zyklus feuern alle gestapelten Disconnected-Handler gleichzeitig, starten je einen eigenen 15s-Timer und rufen cleanupGuildResources mehrfach auf; bei >~4 Zyklen erscheint die MaxListenersExceededWarning, und ein alter Timer eines früheren Players kann die frisch angelegte Queue eines späteren Joins wegräumen; alte Closures (disconnectTimer) leaken dauerhaft.

### F03 · Mittel · SIGTERM erreicht node nie: sh ist PID 1 ohne trap — jeder 'docker stop' endet als SIGKILL ohne Graceful Shutdown

`entrypoint.sh:59` — Infra

ENTRYPOINT ["/app/entrypoint.sh"] macht das /bin/sh-Skript zu PID 1. Es installiert keinen 'trap' fuer TERM/INT, und der Kernel stellt Signale mit Default-Disposition an PID 1 gar nicht erst zu; POSIX-Shells leiten Signale auch nicht an Kinder weiter. Der SIGTERM von 'docker stop' bewirkt also nichts, nach der 10s-Grace-Period SIGKILLt Docker den ganzen Container. Der komplette Graceful-Shutdown-Pfad in src/index.js:329-367 (Voice-Connections trennen, audioCache.flush(), client.destroy()) ist damit im Docker-Betrieb toter Code — er laeuft nur im Update-Checker-Pfad (kill $BOT_PID trifft node als direktes Kind). compose braucht 'init: true' bringt allein nichts — noetig ist z.B. 'trap "kill $BOT_PID" TERM INT' vor dem wait (plus erneutes wait), oder 'exec node ...' statt Background+wait (dann aber ohne Update-Checker-Subshell).

**Szenario:** Bot spielt Musik, AudioCache hat neue Eintraege im 60s-Save-Debounce (AudioCache.js:68-75). Admin macht 'docker compose down' oder Unraid faehrt herunter -> SIGTERM an PID 1 (sh) wird ignoriert -> 10s Wartezeit -> SIGKILL an alle Prozesse. flush() laeuft nie: bis zu 60s Cache-Index-Updates gehen verloren (frisch heruntergeladene Dateien liegen auf dem Volume, stehen aber nicht im Index), Voice-Connections werden nicht sauber getrennt, jeder Stop dauert unnoetig 10 Sekunden.

### F04 · Hoch · Playlist: erster Track landet am Queue-Ende statt sofort zu spielen — Wiedergabe startet mit Track #2

`src/commands/commandHandlers.js:343` — Playback

handleSingleUrlPlay wird zwar awaited, pusht den ersten Playlist-Track aber erst im NICHT awaiteten .then() von downloadSingleTo (nach Sekunden Download-Zeit) in queue.songs. Direkt danach pusht die for-Schleife in handlePlayCommand (Zeile 347-364, identisch in handlePlaylistChoiceButton ab Zeile 1011/1015) synchron alle restEntries. Wenn der Download des ersten Tracks fertig ist, steht er daher HINTER allen restlichen Eintraegen, und ensureNextTrackDownloadedAndPlay spielt songs[0] = Eintrag #2 (der zudem erneut heruntergeladen wird, da filepath noch fehlt). Nur wenn der erste Track bereits im Cache ist (synchroner Push), stimmt die Reihenfolge.

**Szenario:** /play <playlist-url> mit uncachtem erstem Video: Bot meldet 'Playlist ... hinzugefuegt', bleibt stumm bis Download #1 fertig ist, beginnt dann mit Track #2 statt #1; Track #1 spielt erst ganz am Ende der Playlist. Mit &index=5 startet die Wiedergabe entsprechend bei Track #6 statt beim angekuendigten Track #5.

### F05 · Hoch · Fehlgeschlagener Download des ersten Playlist-Tracks laesst die gesamte Queue dauerhaft stumm haengen

`src/commands/commandHandlers.js:177` — Playback

Der .catch von downloadSingleTo in handleSingleUrlPlay postet nur eine Fehlermeldung und loescht Messages — er ruft nie ensureNextTrackDownloadedAndPlay auf. Bei einem Playlist-Play wurden die restEntries bereits in queue.songs gepusht, aber der Player hat noch nie gespielt, daher feuert nie ein Idle-Event, und der BackgroundDownloader setzt nur track.filepath, ohne je Wiedergabe zu starten. Es gibt keinen Mechanismus, der die volle Queue jemals anstoesst.

**Szenario:** /play <playlist-url>, erstes Video ist geo-/altersbeschraenkt -> 'Download fehlgeschlagen'-Meldung, Bot bleibt im Voice-Channel, alle uebrigen Playlist-Tracks werden im Hintergrund heruntergeladen und liegen fertig in der Queue, aber nichts spielt jemals — bis ein User manuell ein weiteres /play absetzt.

### F06 · Mittel · Stale Download-Continuation operiert nach /stop + /play auf der neuen Queue-Generation

`src/queue/QueueManager.js:166` — Playback

Im Download-Pfad von ensureNextTrackDownloadedAndPlay wird während 'await downloadSingleTo' die Queue möglicherweise gelöscht (/stop, Auto-Leave) und durch /play neu erstellt. Nach dem await ruft der alte Codepfad playNextInGuild(guildId) auf, das die Queue frisch aus der Map holt — also die NEUE Queue — und deren songs[0] shiftet. Ist das ein noch nicht geladener Playlist-Track (filepath=null), wirft spawn('ffmpeg', ['-i', null, ...]) synchron ERR_INVALID_ARG_TYPE; die Exception landet im catch der alten ensureNext-Instanz, die dann q.songs.shift() und Error-Zählung auf dem ALTEN Queue-Objekt ausführt und per setTimeout erneut in die neue Queue eingreift. Es fehlt ein Generationen-/Identitätscheck (q === guildQueues.get(guildId)) nach dem await.

**Szenario:** Während ensureNext einen Track herunterlädt: User macht /stop (Queue gelöscht) und sofort /play einer Playlist (neue Queue, songs[0].filepath=null, eigener Download läuft). Alter Download endet -> playNextInGuild shiftet den Kopf der neuen Queue und crasht am null-filepath -> der Track ist ersatzlos aus der neuen Queue entfernt, zusätzlich startet ein konkurrierender ensureNext-Retry-Timer auf der neuen Queue.

### F07 · Mittel · safeKillFfmpeg: SIGKILL-Fallback ist toter Code (ffmpeg.killed statt exitCode/signalCode geprüft)

`src/queue/QueueManager.js:459` — Ressourcen

In Node ist child.killed bereits true, sobald kill('SIGTERM') das Signal erfolgreich GESENDET hat — nicht erst wenn der Prozess beendet ist. Nach ffmpeg.kill('SIGTERM') in Z. 456 ist ffmpeg.killed sofort true, daher ist die Bedingung `if (!ffmpeg.killed) ffmpeg.kill('SIGKILL')` im 5s-Timeout (Z. 458-459) immer false: der SIGKILL wird nie gesendet. Korrekt wäre `ffmpeg.exitCode === null && ffmpeg.signalCode === null` oder ein 'exit'-Flag.

**Szenario:** User drückt Skip während der Wiedergabe: skipCurrentTrack killt currentFfmpeg mit SIGTERM. Zu diesem Zeitpunkt kann ffmpeg.stdout durch die Backpressure-Logik (writeToStream Z. 261-269) pausiert sein; die PassThrough wird beim player.stop() destroyed, 'drain' feuert nie, die 64KB-Kernel-Pipe ist voll und ffmpeg blockiert im write(). Reagiert ffmpeg in diesem Zustand nicht auf SIGTERM, bleibt der Prozess dauerhaft am Leben — der als Absicherung gedachte SIGKILL nach 5s kommt nie. Über viele Skips akkumulieren sich Zombie-ffmpeg-Prozesse im Container (RAM/PID-Leck).

### F08 · Mittel · downloadSingleTo räumt bei Timeout/Fehler partielle Download-Dateien nie auf — Disk füllt sich

`src/download/ytdlp.js:410` — Ressourcen

Bei Download-Timeout (Z. 400-403, SIGKILL) oder yt-dlp-Fehler (Z. 410-417, reject) bleibt die teilweise geschriebene Datei (`<name>.opus.part` bzw. unfertige `.opus`) in DOWNLOAD_DIR liegen. Es gibt keinerlei Cleanup: der reject-Pfad löscht nichts, die Datei landet nie im AudioCache-Index (Eviction/clear löschen nur indizierte Pfade), und es existiert kein Startup-Sweep von DOWNLOAD_DIR. Bei persistentem DOWNLOAD_DIR (Unraid-Volume-Mapping) akkumulieren diese Dateien unbegrenzt. Gleiches gilt für Dateien, die kurz vor einem Crash gecacht wurden, deren Index-Save aber noch im 60s-Debounce (AudioCache.save) hing.

**Szenario:** Playlist mit mehreren geo-gesperrten oder gelöschten Videos: BackgroundDownloader und ensureNextTrackDownloadedAndPlay versuchen jeden Track, yt-dlp bricht ab oder läuft in den 120s-Timeout, pro Versuch bleibt eine .part-Datei mit teils hunderten MB liegen. Über Wochen Dauerbetrieb füllt sich das Download-Verzeichnis, bis die Platte/das tmpfs voll ist und alle weiteren Downloads mit ENOSPC fehlschlagen.

### F09 · Mittel · LRU-Eviction löscht Dateien, die noch in aktiven Queues referenziert sind

`src/cache/AudioCache.js:166` — Ressourcen

AudioCache.set (Z. 159-170) entfernt bei Überschreiten von maxEntries die 20% ältesten Einträge und unlinkt deren Dateien sofort — ohne zu prüfen, ob ein Guild-Queue-Track (track.filepath) oder der gerade spielende Track dieselbe Datei referenziert. Der ts wird bei Cache-Hits (get/has) nicht aufgefrischt, d.h. gerade erst zur Queue hinzugefügte Cache-Treffer können trotzdem die 'ältesten' Einträge sein. Für Tracks mit url wird die Datei zwar neu heruntergeladen (unnötiger Traffic), aber /playcache-Tracks haben url=null, weil die Cache-Keys YouTube-Video-IDs sind und `key.startsWith('http')` (commandHandlers.js Z. 726) fehlschlägt — diese Tracks werden beim Abspielen stumm verworfen.

**Szenario:** Cache ist voll (200 Einträge). User startet /playcache (alle 200 Songs in die Queue) und spielt danach einen neuen Song per /play: audioCache.set löst die Eviction aus und löscht die 40 ältesten Dateien von der Platte. Wenn diese Tracks in der Queue drankommen, schlägt fs.promises.access fehl; da url=null ist, werden sie kommentarlos aus der Queue geworfen — bis zu 40 Songs verschwinden. Sind mehr als 10 davon direkt aufeinanderfolgend, greift zusätzlich das Rekursions-Limit (siehe separates Finding) und die Wiedergabe bleibt komplett stehen.

### F10 · Mittel · /queue reply can exceed 2000-character message limit and fails

`src/commands/commandHandlers.js:578` — Discord-API

handleQueueCommand builds the queue listing from up to 15 songs plus the current track and sends it via interaction.reply(message) without any length truncation (truncateMessage exists in src/utils/formatting.js but is not used here). Each line contains '**N.** ' + title (YouTube titles up to ~100 chars, local-file titles from /playchrist up to 255 chars) + duration + ' — ' + playlistTitle (up to ~150 chars), so 15 lines easily reach 3000-4000 characters. discord.js does not truncate client-side; the Discord API rejects content over 2000 chars with error 50035 (Invalid Form Body).

**Szenario:** User adds a YouTube playlist with typical long titles (e.g. 15 tracks with 80-100 char titles plus the 100+ char playlist name appended per line) and runs /queue. The reply body exceeds 2000 characters, interaction.reply throws DiscordAPIError 50035, and the user only gets the generic '❌ Ein Fehler ist aufgetreten' fallback from index.js instead of the queue.

### F11 · Mittel · Stage channels: bot joins as suppressed audience and plays inaudibly

`src/voice/VoiceManager.js:29` — Discord-API

joinVoiceChannelWithRetry only checks Connect and Speak permissions and then calls joinVoiceChannel. There is no handling for StageChannel: no type check, no guild.members.me.voice.setSuppressed(false) / setRequestToSpeak after joining. In a Stage channel a bot always joins as a suppressed audience member, so its audio is never transmitted to listeners even though the player transitions to Playing and the 'Now Playing' embed is posted. Nothing in ensureQueueAndJoin (src/commands/commandHandlers.js) or QueueManager compensates for this.

**Szenario:** A user sits in a Stage channel and runs /play <url>. The bot joins the stage as audience (suppress=true), downloads the track, shows the 'Now Playing' embed with working buttons, the player runs through the whole song — but no one hears anything, and the queue silently advances track by track in complete silence.

### F12 · Mittel · Song-Hinzufügen bei pausiertem Player (Paused/AutoPaused nicht geprüft) verwirft den pausierten Track und startet sofort den neuen

`src/queue/QueueManager.js:117` — Playback

ensureNextTrackDownloadedAndPlay bricht nur bei AudioPlayerStatus.Playing ab. Die Zustände Paused und AutoPaused (NoSubscriberBehavior.Pause, z. B. Bot allein im Channel) passieren den Check. Die Aufrufer in handleSingleUrlPlay (commandHandlers.js:109 Cache-Hit, :173 nach Download, :742/:822) prüfen ebenfalls nur '!== Playing'. Dadurch wird playNextInGuild aufgerufen, das ohne weitere Prüfung q.player.play(resource) ausführt und die pausierte Resource ersetzt — der pausierte Song geht verloren (nur noch über previousTrack erreichbar), skipRequested/Loop-Logik wird nie für ihn ausgeführt. Fix: auch Paused/AutoPaused (bzw. status !== Idle) als 'beschäftigt' behandeln.

**Szenario:** Song läuft, Nutzer führt /pause aus, danach /play mit einer bereits gecachten URL. Statt den neuen Song hinten anzuhängen und die Pause beizubehalten, startet sofort der neue Song; der pausierte Song wird verworfen und seine Restspielzeit geht verloren. Gleiches passiert, wenn während einer Pause ein laufender Download fertig wird (commandHandlers.js:173).

### F13 · Mittel · URL-Blockliste prüft String-Patterns statt Hostname: SSRF-Bypass per internem Hostnamen und False-Positives bei legitimen URLs

`src/utils/validation.js:91` — Security

validateUrl() (genutzt von isValidMediaUrl) prueft nur die BLOCKED_URL_PATTERNS-Regexe (constants.js Z.19-32) gegen den rohen, kompletten URL-String statt gegen den (nach DNS-Aufloesung geprueften) Hostname. Das hat zwei Folgen desselben Defekts: (1) Bypass/SSRF: Geblockt werden ausschliesslich literale private IPs/localhost (z.B. 192.168., 10., 127.0.0.1); ein interner Hostname oder eine alternative IP-Kodierung matcht keines der String-Patterns und gilt als 'sichere' Media-URL, die in handlePlayCommand (commandHandlers.js Z.413-428) an getVideoInfo -> spawnYtdlp weitergereicht wird — yt-dlp fuehrt dann aus dem Container/LAN heraus einen HTTP-Request an das interne Ziel aus. (2) False-Positives: Unverankerte Muster wie /10\./, /192\.168\./ und /172\.(...)\./ matchen jedes Vorkommen in Pfad oder Query legitimer URLs. Fix: url.hostname extrahieren (URL-Objekt existiert in validateUrl bereits), IP-Muster verankert nur gegen den Hostname pruefen (z.B. /^10\./) und idealerweise IP-basiert nach DNS-Aufloesung blocken.

**Szenario:** Bypass: Ein Discord-User gibt `/play http://nas-admin.lan:8080/api/status` (oder `/play http://2130706433/`) ein — kein Pattern matcht, yt-dlp sendet einen Request an den internen Dienst im Unraid-/Docker-Netz (Zugriff auf sonst nicht erreichbare Endpunkte). False-Positive: `/play https://archive.org/download/album/track-10.mp3` oder eine URL mit Query '&start=10.5' wird wegen /10\./ faelschlich als unsicher abgelehnt.

### F14 · Mittel · Back-Button spielt bei aktivem Shuffle einen zufälligen Song statt des vorherigen

`src/commands/commandHandlers.js:1077` — Playback

Der np_prev-Handler unshiftet previousTrack (und currentTrack) an den Queue-Anfang und triggert skipCurrentTrack. Im Idle-Handler ruft ensureNextTrackDownloadedAndPlay dann prepareNextTrack auf (QueueManager.js:206-214). Da _nextPrepared beim Start des aktuellen Tracks auf false zurückgesetzt wurde (QueueManager.js:226), greift bei queue.shuffle === true die Zufallsauswahl und verschiebt mit Wahrscheinlichkeit (n-1)/n einen anderen Song vor den gerade nach vorn gestellten previousTrack. Der np_prev-Handler müsste q._nextPrepared = true setzen, um seine explizite Auswahl zu fixieren.

**Szenario:** Shuffle ist aktiviert, mehrere Songs in der Queue, Nutzer drückt den ⏮️-Button. Erwartet: der vorherige Song spielt. Tatsächlich: prepareNextTrack zieht einen zufälligen Song an Position 0, dieser spielt; der vorherige Song bleibt irgendwo in der Queue hängen.

### F15 · Mittel · Update-Checker restartet den Bot zu beliebigem Zeitpunkt mitten in aktiver Wiedergabe

`entrypoint.sh:40` — Infra

check_for_updates() killt den Bot sofort, sobald pip eine neue yt-dlp-Version installiert hat — ohne jede Pruefung, ob gerade Wiedergabe laeuft (keine Idle-Abfrage, kein Warten auf leere Queues). yt-dlp released ca. woechentlich; mit dem 6h-Intervall trifft der Restart regelmaessig laufende Sessions. Die Queue ist nur in-memory (QueueManager) und ist nach dem Restart weg. Der Restart selbst funktioniert ('restart: unless-stopped' startet auch bei Exit 0 neu), aber der Zeitpunkt ist unkontrolliert. Fix: vor dem kill pruefen, ob der Bot idle ist (z.B. Flag-File/Signal vom Bot), oder den Restart aufschieben, bis keine Voice-Connection mehr aktiv ist.

**Szenario:** Bot spielt in einem Voice-Channel eine 50-Song-Queue ab. Update-Check um z.B. 20:00 Uhr findet yt-dlp-Release -> kill $BOT_PID -> Wiedergabe bricht fuer alle Hoerer mitten im Song ab, die komplette Queue ist nach dem Container-Restart verloren.

### F16 · Mittel · Kein Abgleich DOWNLOAD_DIR vs. Cache-Index beim Start — verwaiste Dateien wachsen auf dem persistenten Downloads-Volume unbegrenzt

`src/cache/AudioCache.js:40` — Ressourcen

DOWNLOAD_DIR=/app/downloads ist per Bind-Mount persistent (docker-compose.yml:28). AudioCache.load() liest beim Start nur .cache_index.json und entfernt nie Dateien, die auf der Platte liegen, aber nicht (mehr) im Index stehen. Solche Waisen entstehen systematisch: (a) der Index wird mit 60s Debounce gespeichert (save(), Zeile 68-75) und flush() laeuft wegen des SIGTERM-Defekts in entrypoint.sh bei 'docker stop' nie — jede frisch heruntergeladene Datei der letzten Minute vor einem Stop bleibt als indexlose Datei liegen; (b) abgebrochene yt-dlp-Downloads hinterlassen .part-Dateien; (c) fehlgeschlagene unlinks bei LRU-Eviction werden ignoriert (Zeile 166). MAX_CACHE=200 begrenzt nur Index-Eintraege, nicht die realen Dateien. Fix: beim Start Verzeichnisinhalt gegen den Index abgleichen und unbekannte/partielle Dateien loeschen (oder adoptieren).

**Szenario:** Ueber Monate mit regelmaessigen Update-Restarts und 'docker stop' (der wegen des PID-1-Defekts immer als SIGKILL endet und den debounced Index-Save verwirft) sammeln sich hunderte verwaiste .m4a/.part-Dateien in ${DOWNLOAD_HOST_PATH} an. Das Host-Volume auf dem Unraid-Server waechst trotz MAX_CACHE=200 unbegrenzt, bis der Share/die Platte vollaeuft und neue Downloads mit ENOSPC scheitern.

### F17 · Niedrig · Skip bei idlem Player wirkungslos, stale skipRequested-Flag unterdrückt später fälschlich das Loop-Requeue

`src/queue/QueueManager.js:533` — Playback

skipCurrentTrack setzt queue.skipRequested = true und ruft player.stop(). Ist der Player aber bereits Idle (Skip während der Download-Lücke zwischen zwei Tracks, isDownloading === true, oder während der ffmpeg-Prebuffer-Phase vor q.player.play()), feuert kein Idle-Event und das Flag wird nicht konsumiert — der User bekommt trotzdem 'Übersprungen' angezeigt. Das Flag bleibt bis zum nächsten NATÜRLICHEN Songende stehen: Der Idle-Handler (Zeilen 70-71) interpretiert das natürliche Ende des NÄCHSTEN Tracks als Skip (shouldLoopCurrentTrack = false) und lässt den Track im loopMode 'song'/'queue' fälschlich aus der Rotation fallen.

**Szenario:** loopMode 'queue' aktiv. Song A endet, Bot zeigt 'Lade: Song B' und lädt herunter. User drückt in dieser Lücke ⏭️/Skip -> nichts passiert (B spielt trotzdem komplett). Als B natürlich endet, ist skipRequested noch true -> B wird nicht wieder ans Queue-Ende angehängt und fällt dauerhaft aus der Repeat-Rotation.

### F18 · Niedrig · Doppelter paralleler Download desselben Tracks durch BackgroundDownloader und ensureNextTrackDownloadedAndPlay

`src/download/BackgroundDownloader.js:56` — Ressourcen

Beide Pfade prüfen nur 'track.filepath' bevor sie ihren eigenen Download starten, es gibt kein gemeinsames In-Flight-Flag pro Track. Wenn der aktuelle Song endet, bevor der BackgroundDownloader den nächsten Playlist-Track erreicht hat, startet ensureNextTrackDownloadedAndPlay (QueueManager Zeile 157) einen eigenen Download derselben URL, während der BackgroundDownloader denselben Track kurz danach ebenfalls herunterlädt (sein Check in Zeile 56 sieht filepath noch null). Beide schreiben in unterschiedliche Zufallsdateinamen; audioCache.set wird zweimal mit demselben Key aufgerufen, der zweite überschreibt den Eintrag.

**Szenario:** Kurzer erster Playlist-Song endet, während der BG-Downloader noch beim Anlauf/1s-Delay ist: dieselbe YouTube-URL wird zweimal gleichzeitig per yt-dlp geladen (doppelte Bandbreite/CPU auf dem Unraid-Server), track.filepath wird vom später fertigen Download überschrieben und die zuerst geschriebene .opus-Datei bleibt als nie referenzierte Waise dauerhaft im DOWNLOAD_DIR liegen (wird von keiner Cache-Eviction erfasst).

### F19 · Niedrig · Download-Continuation pusht Geister-Track in eine nach /stop neu erstellte Queue

`src/commands/commandHandlers.js:161` — Playback

Der .then-Callback von downloadSingleTo in handleSingleUrlPlay holt die Queue nach dem Download erneut aus der Map ('Re-fetch queue in case it was deleted'). Der Guard erkennt aber nur den Fall 'Queue weg' — wurde nach /stop bzw. Auto-Leave inzwischen per /play eine NEUE Queue erstellt, ist currentQueue truthy und der Track aus der alten, vom User explizit gestoppten Session wird in die neue Queue gepusht und ggf. abgespielt.

**Szenario:** User startet /play (Download läuft ~30s), macht /stop (Queue gelöscht, Wiedergabe beendet) und startet dann /play mit einem anderen Song. Der alte Download wird fertig, findet die neue Queue und hängt den unerwünschten alten Song an — er wird gespielt, obwohl der User die Session mit /stop geleert hatte.

### F20 · Niedrig · Rekursionslimit in ensureNextTrackDownloadedAndPlay hinterlässt stumm eine blockierte Queue samt Voice-Connection

`src/queue/QueueManager.js:101` — Playback

Der Drop-Pfad für ungültige Einträge (Zeilen 139-142: filepath nicht zugreifbar und url === null, z. B. /playchrist-Tracks nach Wegfall des Mapping-Mounts oder /playcache-Einträge, deren Dateien gelöscht wurden) rekursiert mit _depth + 1. Bei mehr als 10 solchen Einträgen in Folge returned die Funktion bei _depth > 10 nur mit einem Log-Warn (Z. 101-104): Player bleibt Idle, songs bleibt gefüllt, keine Nutzer-Benachrichtigung, kein Cleanup, und da kein Idle-Event mehr kommt, triggert nichts einen weiteren Versuch. Der consecutiveErrors>=5-Schutz greift hier nicht, weil dieser Pfad den Zähler nicht erhöht. Queue-Objekt, Player und Voice-Connection bleiben unbegrenzt bestehen, bis ein User manuell /stop ausführt oder Auto-Leave greift.

**Szenario:** /playchrist hat 50 lokale Dateien (url=null) eingereiht, der Unraid-Mapping-Mount fällt weg (oder >10 aufeinanderfolgende /playcache-Tracks wurden durch die Cache-Eviction gelöscht). Nach Ende des laufenden Songs droppt ensureNextTrackDownloadedAndPlay 11 unzugreifbare Einträge, loggt 'RECURSION LIMIT' und stoppt still: Bot hängt stumm im Voice-Channel, Queue zeigt weiter Dutzende Songs, Queue-Objekt und Connection bleiben als Leck bestehen, ohne dass je wieder etwas abgespielt wird.

### F21 · Niedrig · No allowedMentions default: @everyone in video titles can mass-ping

`src/index.js:89` — Security

The Client is constructed without an allowedMentions option, and none of the non-ephemeral sends set allowedMentions either (e.g. the public follow-up '✅ Download fertig: **${video.title}**' in handleSingleUrlPlay line 163, the /queue reply line 578, and channel.send notifications in QueueManager). sanitizeString strips <, > and control chars but leaves '@' untouched, so '@everyone'/'@here' in a YouTube video or playlist title survives into public plain-text message content. With discord.js defaults, all mention types are parsed, so if the bot has the MentionEveryone permission (common with Administrator invites), such a message actually pings everyone.

**Szenario:** A user plays a YouTube video titled '@everyone check this out'. After the download finishes, the bot posts the public follow-up '✅ Download fertig: **@everyone check this out** — zur Queue hinzugefügt.' in the text channel; because no allowedMentions restriction is set and the bot has MentionEveryone, every member of the server gets pinged.

### F22 · Niedrig · _nextPrepared wird nach Download-Fehler nicht zurueckgesetzt - Shuffle-Pick uebersprungen

`src/queue/QueueManager.js:192` — Playback

Im Fehlerpfad von ensureNextTrackDownloadedAndPlay (Zeile 192, ebenso im Invalid-Entry-Pfad Zeile 141) wird der zuvor per prepareNextTrack an Position 0 gelockte Track mit q.songs.shift() entfernt, aber q._nextPrepared bleibt true. Beim Retry (setTimeout Zeile 194) returned prepareNextTrack sofort und der Nachfolger an songs[0] wird deterministisch gespielt statt zufaellig neu gewaehlt. Erst playNextInGuild setzt das Flag wieder zurueck. Fix: q._nextPrepared = false direkt nach dem shift im Fehlerpfad.

**Szenario:** Shuffle aktiv, Queue mit 50 Songs. Der per Shuffle gewaehlte naechste Track schlaegt beim yt-dlp-Download fehl (Video geloescht/geo-blocked) -> Track wird entfernt, _nextPrepared bleibt true -> als naechstes spielt nicht ein zufaelliger Song, sondern stur der jetzt an Position 0 stehende - die Shuffle-Auswahl wird fuer diesen Durchlauf still uebersprungen.

### F23 · Niedrig · Container laeuft als root (kein USER) mit SYS_NICE und schreibbarem Host-Mount

`Dockerfile:55` — Security

Das finale Image (FROM node:22) enthaelt keine USER-Direktive, daher laufen der Node-Prozess sowie die von ihm gespawnten yt-dlp/ffmpeg-Prozesse als uid 0. Der Container erhaelt zusaetzlich cap_add: SYS_NICE (docker-compose.yml Z.42-43) und bindet ein schreibbares Host-Verzeichnis (./downloads -> /app/downloads, docker-compose.yml Z.28). yt-dlp und ffmpeg verarbeiten von Discord-Usern kontrollierte Remote-Inhalte; eine Schwachstelle in einem dieser Tools laeuft damit mit Root-Rechten und Schreibzugriff auf das gemountete Host-Verzeichnis. Ein dedizierter nicht-privilegierter USER haette das Blast-Radius reduziert.

**Szenario:** User laesst per /play eine praeparierte Medien-URL verarbeiten, die einen ffmpeg-/yt-dlp-Parser-Bug ausloest. Der resultierende Code laeuft als root und kann in das host-gemountete ./downloads schreiben bzw. mit Root-Rechten weiter eskalieren, statt auf einen unprivilegierten Container-User beschraenkt zu sein.

### F24 · Niedrig · MAX_SONGS_PER_QUEUE wird im Einzel-URL-Pfad (handleSingleUrlPlay) nicht durchgesetzt

`src/commands/commandHandlers.js:98` — Playback

Beide Add-Pfade in handleSingleUrlPlay — Cache-Hit (Zeile 98) und Download-Abschluss (Zeile 161) — pushen ohne remoteSongCount-Check in queue.songs. Die Playlist-Pfade (Zeilen 348, 1016) und /playcache (Zeile 720) prüfen das Limit, der Einzel-Song-Pfad nicht. Das als Memory-Limit deklarierte MAX_SONGS_PER_QUEUE (500) ist damit über /play und /select umgehbar; der Rate-Limiter (10/min/User) verlangsamt das nur, verhindert es aber nicht (mehrere Nutzer bzw. Dauerbetrieb).

**Szenario:** Mehrere Nutzer (oder ein Nutzer über ~1 Stunde) fügen per /play einzelne URLs hinzu, bis queue.songs weit über 500 Einträge wächst — das dokumentierte Memory-Schutzlimit greift nicht, während dieselbe Queue über den Playlist-Pfad korrekt bei 500 gedeckelt würde.

### F25 · Niedrig · Cache-Set für bereits vorhandenen Key verwaist die alte Audiodatei dauerhaft auf der Platte

`src/cache/AudioCache.js:151` — Ressourcen

AudioCache.set überschreibt den Map-Eintrag desselben Keys mit dem neuen filepath, ohne die alte Datei zu löschen. Die alte Datei ist danach für LRU-Eviction und clear() unerreichbar und verbleibt dauerhaft in DOWNLOAD_DIR. Das tritt real auf: (a) zwei Guilds laden dieselbe nicht gecachte URL gleichzeitig (beide downloaden in verschiedene UUID-Dateinamen, beide rufen set für denselben Video-ID-Key auf); (b) der Lazy-Download in ensureNextTrackDownloadedAndPlay (QueueManager.js:138-160) prüft den Cache vor dem Download überhaupt nicht und lädt einen bereits gecachten URL erneut herunter, wonach set die vorhandene Datei verwaist.

**Szenario:** Guild A spielt eine Playlist; ein Track ist noch ohne filepath, der BackgroundDownloader hat ihn noch nicht erreicht, dieselbe URL liegt aber schon im Cache. ensureNextTrackDownloadedAndPlay lädt die Datei erneut herunter und set() ersetzt den Cache-Eintrag — die alte .opus-Datei bleibt für immer in DOWNLOAD_DIR liegen. Über Wochen Dauerbetrieb im Docker-Container akkumulieren sich verwaiste Dateien und füllen das Volume, obwohl der Cache nominell auf 200 Einträge begrenzt ist.

### F26 · Niedrig · set -e laesst den Update-Checker-Subshell bei einem transienten Fehler still sterben

`entrypoint.sh:35` — Infra

Die Background-Subshell 'check_for_updates &' erbt 'set -e' (Zeile 2). In der Schleife haben 'BEFORE=$(/opt/venv/bin/yt-dlp --version 2>/dev/null)' (Zeile 34) und '/opt/venv/bin/pip install ... > /dev/null 2>&1' (Zeile 35) — anders als die Startup-Variante in Zeile 9/12 — kein '|| echo'-Fallback bzw. keine Pipe, die den Exit-Code maskiert. Schlaegt einer der Befehle einmal fehl (z.B. PyPI nicht erreichbar, DNS-Aussetzer), beendet set -e die Subshell sofort und lautlos. Der Update-Checker ist dann bis zum naechsten Container-Restart tot, der Bot laeuft aber weiter — es faellt niemandem auf.

**Szenario:** 6h nach Start ist das Netzwerk beim Update-Check kurz gestoert -> pip exit != 0 -> Subshell beendet sich wegen set -e ohne Log-Ausgabe. Danach erscheint nie wieder '[UPDATE CHECK]' im Log; yt-dlp veraltet ueber Wochen, YouTube-Downloads beginnen zu scheitern, obwohl der Update-Mechanismus 'aktiv' sein sollte.

### F27 · Niedrig · Healthcheck 'pgrep -x node' kann prinzipiell keinen realen Fehlerzustand erkennen

`docker-compose.yml:54` — Infra

Der Healthcheck prueft nur, ob irgendein node-Prozess existiert. Wenn node stirbt, endet aber auch entrypoint.sh (wait in Zeile 59) und damit der Container selbst — den Zustand 'Container laeuft, aber node fehlt' gibt es nicht. Der Check kann also nie fehlschlagen, solange der Container laeuft, und meldet 'healthy' auch wenn der Bot von Discord getrennt ist, die Event-Loop haengt oder der Login fehlgeschlagen ist und der Prozess nur noch idle herumsteht. Zusaetzlich reagiert Compose ohne Zusatztools (autoheal) ohnehin nicht auf 'unhealthy'. Sinnvoll waere ein Check, der den tatsaechlichen Zustand prueft (z.B. Bot schreibt periodisch eine Heartbeat-Datei, Healthcheck prueft deren Alter).

**Szenario:** Discord-Gateway-Verbindung geht dauerhaft verloren oder client.login() schlaegt nach einem Restart fehl, waehrend der node-Prozess weiterlaeuft (uncaughtException-Handler in index.js:370 verhindert den Prozess-Exit). Unraid-Dashboard zeigt den Container dauerhaft als 'healthy', obwohl der Bot fuer alle Nutzer tot ist; niemand wird alarmiert und kein automatischer Neustart erfolgt.

## Plausibel, aber nicht abschließend verifiziert (4)

### P1 · Niedrig · /select performs REST fetch+delete before acknowledging the interaction

`src/commands/commandHandlers.js:458`

handleSelectCommand first awaits channel.messages.fetch(cached.messageId) and message.delete() (two sequential REST calls, lines 454-462) before it calls deferReply (line 468). The initial acknowledgment of a slash command must happen within 3 seconds. Message-delete routes are commonly rate-limited when the bot is busy deleting its own progress/now-playing messages (which this bot does constantly), so the pre-acknowledgment REST calls can push past the 3-second window. The subsequent deferReply then fails with 10062, which the code swallows (return), so the user gets 'Die Anwendung reagiert nicht' and the selection is silently dropped even though the search-results message was already deleted.

**Szenario:** User runs /select 3 while the bot is rate-limited on the message-delete route (e.g. right after a playlist load where several progress/now-playing messages were just deleted). fetch+delete take >3s, deferReply throws Unknown interaction (10062), the handler returns silently: Discord shows 'application did not respond', the search results message is gone, and the song is never queued.

### P2 · Niedrig · Logs-Volume /app/logs wird gemountet, aber nie beschrieben — Winston-Logs landen in /tmp und sind nach jedem Restart weg

`docker-compose.yml:34`

Compose mountet ${LOGS_HOST_PATH:-./logs} nach /app/logs, setzt aber gleichzeitig LOG_DIR=/tmp (Zeile 23). logger.js schreibt error.log/combined.log nach LOG_DIR — also in das fluechtige Container-/tmp, nie in den Mount. Das Host-Verzeichnis ./logs bleibt dauerhaft leer, und die Datei-Logs verschwinden bei jedem Container-Restart — insbesondere bei jedem automatischen yt-dlp-Update-Restart (alle paar Tage). Die Rotation in logger.js (5MB, 5 Dateien) ist zwar korrekt begrenzt, aber wirkungslos fuer Persistenz. Entweder LOG_DIR=/app/logs als Default setzen oder den toten Mount entfernen; zusaetzlich fehlt eine 'logging:'-Sektion mit max-size fuer den stdout-json-file-Log, der bei Docker-Default-Konfiguration unbegrenzt waechst.

**Szenario:** Bot stuerzt nachts ab oder verhaelt sich fehlerhaft; der Update-Checker restartet den Container um 03:00. Admin will am Morgen error.log unter ./logs auf dem Unraid-Host pruefen -> Verzeichnis ist leer, /tmp des alten Containers existiert nicht mehr, alle Fehler-Logs zur Diagnose sind unwiederbringlich verloren (nur noch stdout via 'docker logs', sofern nicht ebenfalls rotiert/geleert).

### P3 · Niedrig · spawnYtdlp filtert URLs mit '..' stillschweigend aus den Argumenten — yt-dlp startet ohne URL

`src/download/ytdlp.js:62`

Der safeArgs-Filter entfernt jedes Argument mit '..' komplett, statt den Aufruf abzulehnen. validateUrl erlaubt '..' in URL-Pfaden (z.B. SoundCloud-Slugs wie /artist/track..name), sodass eine gueltige Media-URL den Filter erreicht, herausgefiltert wird und yt-dlp ohne URL-Argument startet: Exit != 0 mit 'You must provide at least one URL'. Der User bekommt eine irrefuehrende Fehlermeldung statt Wiedergabe. downloadSingleTo filtert dagegen nicht — die beiden Pfade verhalten sich inkonsistent (getVideoInfo schlaegt fehl, bevor der eigentlich funktionierende Download je erreicht wird).

**Szenario:** /play https://soundcloud.com/artist/my..track (gueltige, von validateUrl akzeptierte URL) -> getVideoInfo spawnt yt-dlp ohne URL -> '❌ Konnte Video-Info nicht abrufen: yt-dlp exited 2: ...you must provide at least one URL' obwohl die URL abspielbar waere.

### P4 · Niedrig · /test waehrend laufender Wiedergabe verwirft den aktuellen Song und hinterlaesst einen blockierten ffmpeg-Prozess

`src/commands/commandHandlers.js:660`

handleTestCommand ruft queue.player.play(resource) direkt auf dem Guild-Player auf, ohne die Queue zu beruecksichtigen. Laeuft gerade ein Song, wird dessen Resource ersetzt: der zugehoerige ffmpeg-Prozess (q.currentFfmpeg) laeuft weiter und blockiert per Backpressure (PassThrough voll, stdout pausiert), da sein Stream nicht mehr konsumiert wird. Wenn die Testdatei endet, feuert Idle: skipRequested ist false, bei loopMode 'off' wird queue.currentTrack ersatzlos verworfen und die Queue rueckt zum naechsten Song vor.

**Szenario:** Song spielt, User tippt /test -> aktueller Song bricht sofort ab; nach dem Testton springt der Bot zum naechsten Queue-Eintrag, der unterbrochene Song ist verloren; der alte ffmpeg-Prozess haengt blockiert im Speicher, bis der naechste Trackwechsel ihn per safeKillFfmpeg beendet.

## Geprüft und widerlegt (2)

- `src/queue/QueueManager.js:322` — ffmpeg-Fehlerpfad ruft playNextInGuild mit ungedownloadetem Track auf -> spawn(null) wirft, Queue permanent tot
  Die zentrale Prämisse ist falsch: Node wirft bei einem null-Element im args-Array von child_process.spawn() KEINEN synchronen ERR_INVALID_ARG_TYPE. Empirisch verifiziert (Kindprozess erhält den String "null") und im Node-22.x-Quellcode bestätigt: normalizeSpawnArguments validiert nur, dass args selb…
- `src/commands/commandHandlers.js:39` — Parallele ensureQueueAndJoin-Aufrufe derselben Guild überschreiben die Queue und akkumulieren Connection-Listener
  The claimed race window does not exist in practice. The window is src/commands/commandHandlers.js:39 (guildQueues.get) to QueueManager.js:445 (guildQueues.set inside createGuildQueue), spanning only the await at line 44. But joinVoiceChannel in the installed @discordjs/voice 0.19 is fully synchronou…
