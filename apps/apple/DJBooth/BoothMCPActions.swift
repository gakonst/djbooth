import Foundation
import DJBoothKit

@MainActor extension BoothModel {
    func mcpCall(_ name: String, arguments: [String: Any], budget: Int) throws -> String {
        if name == "query" { return try phoneLibraryQuery().execute(arguments, byteBudget: budget) }
        if name == "device_state" { return try mcpDeviceState(arguments) }
        guard let id = arguments["requestID"] as? String, UUID(uuidString: id) != nil else { throw ClientError.http(400, "A UUID requestID is required") }
        if name == "operation_status" {
            guard var receipt = try store.phoneAction(id) else { throw ClientError.http(404, "Unknown action requestID") }
            if receipt.status == "running", phoneActions[id] == nil {
                receipt.status = "interrupted"; receipt.output = "App restarted or account changed. Inspect current state before issuing another action."
                try store.savePhoneAction(receipt)
                #if os(iOS)
                AppDiagnostics.shared.event("agent_action_interrupted", ["requestID": id])
                #endif
            }
            return try mcpEncode(receipt)
        }
        let fingerprint = name + ":" + String(decoding: try JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys]), as: UTF8.self)
        if let previous = try store.phoneAction(id) {
            #if os(iOS)
            AppDiagnostics.shared.event("agent_action_replayed", ["action": name, "requestID": id, "status": previous.status])
            #endif
            guard previous.fingerprint == fingerprint else { throw ClientError.http(409, "requestID already belongs to different arguments") }
            return try mcpCall("operation_status", arguments: ["requestID": id], budget: budget)
        }
        guard phoneActions.isEmpty else { throw ClientError.http(409, "Another app action is running. Poll its receipt first.") }
        let account = accountConnectionID, actionStore = store
        let receipt = PhoneActionReceipt(requestID: id, fingerprint: fingerprint)
        try actionStore.savePhoneAction(receipt) // Claim durably before invoking UI handlers.
        let started = ProcessInfo.processInfo.systemUptime
        #if os(iOS)
        AppDiagnostics.shared.event("agent_action_started", ["action": name, "requestID": id])
        #endif
        phoneActions[id] = Task { @MainActor [weak self] in
            guard let self else { return }
            var result = receipt
            var failureFields: [String: String] = [:]
            defer { if self.accountConnectionID == account { self.phoneActions.removeValue(forKey: id) } }
            do {
                try Task.checkCancellation()
                guard self.accountConnectionID == account else { throw CancellationError() }
                result.output = try await self.performMCPAction(name, arguments)
                try Task.checkCancellation()
                guard self.accountConnectionID == account else { throw CancellationError() }
                result.status = "completed"
            } catch {
                result.status = error is CancellationError ? "interrupted" : "failed"
                result.output = error.localizedDescription
                #if os(iOS)
                failureFields = AppDiagnostics.failureFields(error)
                #endif
            }
            // Always save in the original account store, even if the user signed out.
            do { try actionStore.savePhoneAction(result) }
            catch {
                #if os(iOS)
                AppDiagnostics.shared.event("agent_action_receipt_failed", ["action": name, "requestID": id])
                #endif
            }
            var fields = failureFields
            fields["action"] = name; fields["requestID"] = id; fields["status"] = result.status
            fields["duration_ms"] = String(Int((ProcessInfo.processInfo.systemUptime - started) * 1000))
            fields["response_bytes"] = String(result.output.utf8.count)
            #if os(iOS)
            AppDiagnostics.shared.event("agent_action_finished", fields)
            #endif
        }
        return try mcpEncode(receipt)
    }

    private func performMCPAction(_ name: String, _ args: [String: Any]) async throws -> String {
        func text(_ key: String) -> String { args[key] as? String ?? "" }
        func flag(_ key: String) -> Bool { args[key] as? Bool ?? false }
        func track() throws -> Track {
            guard let value = tracksByID[text("trackID")] else { throw ClientError.http(404, "Track not found") }
            return value
        }
        func playlist() throws -> Collection {
            guard let value = collections.first(where: { $0.id == text("playlistID") }), !value.id.hasPrefix("connected:") else { throw ClientError.http(404, "Editable playlist not found") }
            return value
        }
        func musicPlaylist() throws -> MusicPlaylist {
            guard let value = connectedPlaylist(text("playlistID")) else { throw ClientError.http(404, "Connected playlist not found") }
            return value
        }
        message = nil
        switch name {
        case "play":
            let t = try track()
            if let position = args["queuePosition"] as? Int {
                guard flag("preserveQueue"), player.queue.indices.contains(position), player.queue[position].id == t.id else { throw ClientError.http(400, "Queue position does not match track") }
            }
            await play(t, preservingQueue: flag("preserveQueue"), queuePosition: args["queuePosition"] as? Int)
        case "transport":
            switch text("command") {
            case "pause": player.pause()
            case "resume": guard player.track != nil else { throw ClientError.http(409, "No track loaded") }; player.resume()
            case "next": guard player.queueIndex + 1 < player.queue.count else { throw ClientError.http(409, "End of queue") }; player.advance(1)
            case "previous": guard player.queueIndex > 0 else { throw ClientError.http(409, "Start of queue") }; player.advance(-1)
            default: throw ClientError.http(400, "Unknown transport command")
            }
            return "Transport command submitted. Read query resource=state to observe playback."
        case "seek":
            guard player.track != nil else { throw ClientError.http(409, "No track loaded") }
            player.seek(min(args["seconds"] as? Double ?? 0, player.duration))
            return "Seek submitted. Read playback state to observe the resulting position."
        case "favorite": let t = try track(); if favorites.contains(t.id) != flag("enabled") { favorite(t) }
        case "note": setNote(text("text"), for: try track())
        case "color": setColor(TrackColor(rawValue: text("color")), for: try track())
        case "playlist_create":
            guard !text("name").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ClientError.http(400, "Playlist name is empty") }
            cancelQuickAdd(); openPlaylistFolder(args["folderPath"] as? [String] ?? []); createCollection(text("name"))
        case "playlist_update": updateCollection(try playlist(), name: text("name"), mood: text("mood"), folderPath: args["folderPath"] as? [String] ?? [])
        case "playlist_delete": deleteCollection(try playlist())
        case "playlist_add": add(try track(), to: try playlist())
        case "playlist_remove":
            let t = try track(), p = try playlist()
            if p.trackIDs.contains(t.id) { requestRemoval(t, from: p); if let request = pendingPlaylistRemoval { confirmRemoval(request) } }
        case "playlist_move": move(try track(), in: try playlist(), by: text("direction") == "up" ? -1 : 1)
        case "playlist_pin": let p = try playlist(); if (p.isPinned ?? false) != flag("enabled") { togglePin(p) }
        case "playlist_undo": undoPlaylistRemoval()
        case "archive": archive(try track())
        case "download_track":
            let t = try track(); await keepOffline(t)
            guard offlineIDs.contains(t.id) else { throw ClientError.http(503, message ?? "Track download did not complete") }
        case "download_playlist":
            let p = try playlist(); await keepCollectionOffline(p)
            guard p.trackIDs.allSatisfy({ offlineIDs.contains($0) }) else { throw ClientError.http(503, message ?? "Some playlist tracks did not finish downloading") }
        case "import_source":
            guard let job = await submitImportJob(text("source"), requestID: text("requestID")) else { throw ClientError.http(503, importError ?? "Import was not accepted") }
            #if os(iOS)
            AppDiagnostics.shared.event("agent_import_accepted", ["action": name, "requestID": text("requestID"), "importID": job.id, "status": job.status])
            #endif
            return String(decoding: try JSONEncoder().encode(job), as: UTF8.self)
        case "import_status":
            return try await importStatus(id: text("importID"), offset: args["offset"] as? Int ?? 0)
        case "import_retry":
            let job = try await retryImportJob(id: text("importID"), requestID: text("requestID"), refresh: flag("refresh"))
            #if os(iOS)
            AppDiagnostics.shared.event("agent_import_accepted", ["action": name, "requestID": text("requestID"), "importID": job.id, "status": job.status])
            #endif
            return String(decoding: try JSONEncoder().encode(job), as: UTF8.self)
        case "sync": await synchronize(); await refreshImports(); return syncStatus
        case "conflict_resolve":
            guard let conflict = conflicts.first(where: { $0.id == text("conflictID") }) else { throw ClientError.http(404, "Conflict not found") }
            resolve(conflict, keepLocal: flag("keepLocal"))
        case "navigate":
            switch text("screen") {
            case "tracks": showLibrary(); query = text("query")
            case "playlists": openPlaylistBrowser()
            case "playlist": openCollection(try playlist())
            case "settings": showSettings = true
            case "imports": showImport = true
            #if os(iOS)
            case "sonos": showSonosSettings = true
            case "djlink": showDJLink = true
            #endif
            default: throw ClientError.http(400, "Unavailable screen")
            }
            showAgent = false
        case "music_refresh": await refreshMusic(force: true, provider: args["provider"] as? String); if let musicError { throw ClientError.http(503, musicError) }
        case "music_open": await loadMusicPlaylist(try musicPlaylist()); if let musicError { throw ClientError.http(503, musicError) }
        case "music_download":
            guard let job = await downloadMusicJob(try musicPlaylist(), requestID: text("requestID")) else { throw ClientError.http(503, message ?? musicError ?? "Import was not accepted") }
            #if os(iOS)
            AppDiagnostics.shared.event("agent_import_accepted", ["action": name, "requestID": text("requestID"), "importID": job.id, "status": job.status])
            #endif
            return String(decoding: try JSONEncoder().encode(job), as: UTF8.self)
        #if os(iOS)
        case "sonos_enabled":
            guard !sonos.routing else { throw ClientError.http(409, "Sonos routing is busy") }
            await setSonosEnabled(flag("enabled")); if let error = sonos.error { throw ClientError.http(503, error) }
        case "sonos_discover": await sonos.discover(); if let error = sonos.error { throw ClientError.http(503, error) }
        case "sonos_volume":
            guard sonos.enabled, sonos.room != nil else { throw ClientError.http(409, "Connect Sonos first") }
            await sonos.setVolume(args["percent"] as? Double ?? 0)
            if let error = sonos.error { throw ClientError.http(503, error) }
        case "sonos_limit":
            let percent = args["percent"] as? Int ?? 0
            if let roomID = args["roomID"] as? String {
                guard sonos.rooms.contains(where: { $0.id == roomID }) else { throw ClientError.http(404, "Room not found") }
                sonos.limits.rooms[roomID] = percent
            } else { sonos.limits.master = percent }
            await sonos.saveVolumeLimits(); if let error = sonos.error { throw ClientError.http(503, error) }
        case "djlink_connect":
            await djLink.refresh(); try Task.checkCancellation(); await djLink.connect(model: self)
            guard djLink.status.running else { throw ClientError.http(503, djLink.error ?? "No ready wired interface") }
        case "djlink_disconnect": await djLink.disconnect()
        case "deck_select":
            let number = args["player"] as? Int ?? 0
            guard number == 0 || djLink.decks.contains(where: { $0.id == number }) else { throw ClientError.http(404, "Deck not detected") }
            djLink.selectedPlayer = number == 0 ? nil : number; djLink.showingPhonePlayer = false
        case "mixer_channel":
            let number = args["player"] as? Int ?? 0, channel = args["channel"] as? Int ?? 0
            guard djLink.decks.contains(where: { $0.id == number }) else { throw ClientError.http(404, "Deck not detected") }
            djLink.assignMixerChannel(channel == 0 ? nil : channel, to: number)
        case "recording_start":
            guard !djLink.recording.busy, !djLink.recording.isRecording else { throw ClientError.http(409, "Recorder is already active") }
            await djLink.recording.start(model: self, includeAudio: flag("includeAudio"))
            guard djLink.recording.isRecording else { throw ClientError.http(503, djLink.recording.error ?? "Recording did not start") }
        case "recording_stop":
            guard !djLink.recording.busy else { throw ClientError.http(409, "Recorder is busy") }
            await djLink.recording.stop(); if let error = djLink.recording.error { throw ClientError.http(503, error) }
        case "recording_prepare", "recording_upload":
            djLink.recording.refreshRecordings()
            guard let directory = djLink.recording.recordings.first(where: { $0.lastPathComponent == text("recordingID") }),
                  directory.path != djLink.recording.progress?.directory || !djLink.recording.isRecording else { throw ClientError.http(404, "Completed recording not found") }
            if name == "recording_prepare" {
                _ = try await Task.detached { try RecordedSetExport.prepare(directory) }.value
            } else {
                guard let source = musicCatalog.sources.first(where: { $0.provider == "soundcloud" && $0.connectionID == text("connectionID") }) else { throw ClientError.http(404, "SoundCloud connection not found") }
                let result = try await publishRecordedSet(directory, source: source)
                return result.url.absoluteString
            }
        #endif
        default: throw ClientError.http(400, "Tool unavailable on this device")
        }
        if let message { throw ClientError.http(500, message) }
        return "Action finished. Query current app state for details."
    }

    private func mcpEncode(_ value: PhoneActionReceipt) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: ["requestID": value.requestID, "status": value.status, "output": value.output], options: [.sortedKeys]), as: UTF8.self)
    }
    private func mcpDeviceState(_ args: [String: Any]) throws -> String {
        let offset = args["offset"] as? Int ?? 0, limit = args["limit"] as? Int ?? 25
        var total = musicCatalog.playlists.count
        var result: [String: Any] = ["musicSources": musicCatalog.sources.map { ["provider": $0.provider, "connectionID": $0.connectionID, "label": $0.label] },
                                     "musicPlaylists": musicCatalog.playlists.dropFirst(offset).prefix(limit).map { ["id": $0.id, "name": $0.name] }]
        #if os(iOS)
        result["sonos"] = ["enabled": sonos.enabled, "volume": sonos.volume, "masterLimit": sonos.limits.master,
                           "rooms": sonos.rooms.map { ["id": $0.id, "name": $0.name, "limit": sonos.limits.rooms[$0.id] ?? 100] as [String: Any] }, "error": sonos.error ?? ""]
        result["djlink"] = ["running": djLink.status.running, "selectedPlayer": djLink.selectedPlayer ?? 0,
                            "decks": djLink.decks.map { deck in ["player": deck.id, "playing": deck.state.playing,
                               "trackID": deck.state.track_id.map(String.init) ?? "", "key": deck.state.effective_key ?? "",
                               "bpmHundreds": deck.state.effective_bpm_hundreds ?? 0, "playheadMs": deck.state.playhead_ms ?? 0,
                               "mixerChannel": djLink.mixerChannel(for: deck.id) ?? 0] as [String: Any] },
                            "mixers": djLink.mixers.values.map { observation in ["ip": observation.event.source_ip, "receivedAt": observation.receivedAt,
                               "fresh": observation.isFresh(at: Date().timeIntervalSince1970), "crossfader": Int(observation.event.mixer.crossfader),
                               "channels": observation.event.mixer.channels.map { ["channel": Int($0.channel), "fader": Int($0.fader), "high": Int($0.eq_high), "mid": Int($0.eq_mid), "low": Int($0.eq_low), "trim": Int($0.trim)] }] as [String: Any] }]
        djLink.recording.refreshRecordings()
        result["recording"] = ["recording": djLink.recording.isRecording, "audio": djLink.recording.capturingAudio,
                               "busy": djLink.recording.busy, "error": djLink.recording.error ?? "", "saved": Array(djLink.recording.recordings.dropFirst(offset).prefix(limit).map(\.lastPathComponent))]
        total = max(total, djLink.recording.recordings.count)
        #endif
        result["nextOffset"] = offset + limit < total ? offset + limit : NSNull()
        return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)
    }
}
