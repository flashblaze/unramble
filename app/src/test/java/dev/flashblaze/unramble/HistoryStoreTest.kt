package dev.flashblaze.unramble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class HistoryStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun recording(name: String, bytes: ByteArray = byteArrayOf(1, 2, 3)): File =
        File(tmp.root, name).apply { writeBytes(bytes) }

    private fun entry(id: String, at: Long) = HistoryEntry(id, at, "extracted", "buy milk", listOf(Task("Buy milk")))

    @Test
    fun addMovesTheRecordingAndRoundTripsTheEntry() {
        val store = HistoryStore(File(tmp.root, "history"))
        val audio = recording("dictation.ogg", byteArrayOf(7, 8))
        store.add(entry("a1", 1), audio)
        assertFalse("recording is moved, not copied", audio.exists())
        assertEquals(listOf(entry("a1", 1)), store.list())
        assertEquals(listOf<Byte>(7, 8), store.audioFile("a1").readBytes().toList())
    }

    @Test
    fun keepsOnlyTheNewestEntries() {
        val store = HistoryStore(File(tmp.root, "history"), limit = 3)
        for (i in 1..5) store.add(entry("id$i", i.toLong()), recording("r$i.ogg"))
        assertEquals(listOf("id5", "id4", "id3"), store.list().map { it.id })
        assertFalse(store.audioFile("id1").exists())
    }

    @Test
    fun submissionsAccumulateAcrossRetries() {
        val store = HistoryStore(File(tmp.root, "history"))
        store.add(entry("a1", 1), recording("r.ogg"))
        store.recordSubmission("a1", listOf(Task("Buy milk")), created = 1)
        store.recordSubmission("a1", listOf(Task("Call mom")), created = 1)
        val saved = store.get("a1")!!
        assertEquals(listOf(Task("Buy milk"), Task("Call mom")), saved.kept)
        assertEquals(2, saved.created)
    }

    @Test
    fun skipsBrokenEntriesAndRejectsPathTricks() {
        val root = File(tmp.root, "history")
        val store = HistoryStore(root)
        store.add(entry("ok", 1), recording("r.ogg"))
        File(root, "broken").mkdirs()
        File(root, "broken/entry.json").writeText("{not json")
        File(root, "noaudio").mkdirs()
        assertEquals(listOf("ok"), store.list().map { it.id })
        assertNull(store.get("../etc"))
        store.delete("../etc")
        assertTrue(root.exists())
    }
}
