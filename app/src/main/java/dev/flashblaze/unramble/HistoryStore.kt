package dev.flashblaze.unramble

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** One recent dictation kept on the watch for playback (PLAN.md, Phase 2c, option B). */
@Serializable
data class HistoryEntry(
    val id: String,
    val createdAt: Long,
    /** "extracted" or "no_speech". */
    val outcome: String,
    val transcript: String? = null,
    val proposed: List<Task> = emptyList(),
    val kept: List<Task> = emptyList(),
    val created: Int = 0,
)

/**
 * Last [limit] recordings with their transcript and tasks, in app-private storage:
 * `<root>/<id>/audio.ogg` + `entry.json`. Local only; the Worker's R2/D1 history is the archive.
 * Not thread-safe: call from one dispatcher.
 */
class HistoryStore(private val root: File, private val limit: Int = 20) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    /** Moves [audio] into the store (no copy when on the same filesystem) and prunes to [limit]. */
    fun add(entry: HistoryEntry, audio: File) {
        val dir = dirOf(entry.id)
        dir.mkdirs()
        val target = File(dir, AUDIO)
        if (!audio.renameTo(target)) {
            audio.copyTo(target, overwrite = true)
            audio.delete()
        }
        write(entry)
        list().drop(limit).forEach { delete(it.id) }
    }

    /** Newest first; entries with unreadable metadata or missing audio are skipped. */
    fun list(): List<HistoryEntry> =
        (root.listFiles() ?: emptyArray())
            .mapNotNull { dir -> read(dir)?.takeIf { File(dir, AUDIO).isFile } }
            .sortedByDescending { it.createdAt }

    fun get(id: String): HistoryEntry? = if (ID.matches(id)) read(dirOf(id)) else null

    fun audioFile(id: String): File = File(dirOf(id), AUDIO)

    /** Adds what one `/tasks` call created; called again on retries, so the counts accumulate. */
    fun recordSubmission(id: String, kept: List<Task>, created: Int) {
        val entry = get(id) ?: return
        write(entry.copy(kept = entry.kept + kept, created = entry.created + created))
    }

    fun delete(id: String) {
        if (ID.matches(id)) dirOf(id).deleteRecursively()
    }

    fun clear() {
        root.deleteRecursively()
    }

    private fun dirOf(id: String): File {
        // Ids come from the Worker (UUIDs); refuse anything that could escape root.
        require(ID.matches(id)) { "invalid history id" }
        return File(root, id)
    }

    private fun read(dir: File): HistoryEntry? =
        runCatching { json.decodeFromString<HistoryEntry>(File(dir, ENTRY).readText()) }.getOrNull()

    /** Write-then-rename, so a crash mid-write never leaves a truncated entry.json. */
    private fun write(entry: HistoryEntry) {
        val dir = dirOf(entry.id)
        val tmp = File(dir, "$ENTRY.tmp")
        tmp.writeText(json.encodeToString(entry))
        if (!tmp.renameTo(File(dir, ENTRY))) error("could not save history entry")
    }

    private companion object {
        const val AUDIO = "audio.ogg"
        const val ENTRY = "entry.json"
        val ID = Regex("[0-9A-Za-z-]{1,64}")
    }
}
