package dev.flashblaze.unramble

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.util.concurrent.TimeUnit

/** Mirrors the Worker's task contract (PLAN.md, "Task JSON"). `due` is local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". */
@Serializable
data class Task(val title: String, val due: String? = null, val priority: Int = 0, val notes: String? = null)

/** [dictationId] identifies the saved recording (Worker history); send it back with [TasksApi.createTasks]. */
@Serializable
data class Extraction(val transcript: String, val tasks: List<Task>, val dictationId: String? = null)

@Serializable
data class CreatedTask(val title: String, val id: String)

/** [index] is the task's position in the `/tasks` request; titles can repeat, positions can't. */
@Serializable
data class FailedTask(val index: Int, val title: String, val error: String)

@Serializable
data class CreateResult(val created: List<CreatedTask>, val failed: List<FailedTask>) {
    /** The tasks from [sent] to retry: exactly the failed positions, so a retry never re-creates a task. */
    fun failedOf(sent: List<Task>): List<Task> {
        val failedIndices = failed.map { it.index }.toSet()
        return sent.filterIndexed { i, _ -> i in failedIndices }
    }
}

@Serializable
private data class CreateRequest(val tz: String, val tasks: List<Task>, val dictationId: String? = null)

@Serializable
private data class ErrorBody(val error: String)

/** A Worker error response; [code] is the `error` field (e.g. `no_speech`, `ticktick_auth_expired`). */
class ApiException(val code: String, val status: Int) : Exception("$status $code")

class TasksApi(baseUrl: String, private val token: String) {
    private val base = baseUrl.toHttpUrl()

    // Worst case measured end to end: ~60 s for a 5-minute recording (PLAN.md, Phase 1).
    private val client = OkHttpClient.Builder()
        .callTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    // The Worker requires `priority` (so encode defaults like 0) and allows absent `due`/`notes`, not null.
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    suspend fun extract(audio: File, tz: String): Extraction {
        val url = base.newBuilder().addPathSegment("extract").addQueryParameter("tz", tz).build()
        return call(Request.Builder().url(url).post(audio.asRequestBody("audio/ogg".toMediaType())))
    }

    suspend fun createTasks(tz: String, tasks: List<Task>, dictationId: String? = null): CreateResult {
        val body = json.encodeToString(CreateRequest(tz, tasks, dictationId)).toRequestBody("application/json".toMediaType())
        return call(Request.Builder().url(base.newBuilder().addPathSegment("tasks").build()).post(body))
    }

    private suspend inline fun <reified T> call(request: Request.Builder): T = withContext(Dispatchers.IO) {
        client.newCall(request.header("Authorization", "Bearer $token").build()).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val code = runCatching { json.decodeFromString<ErrorBody>(text).error }.getOrDefault("http_${response.code}")
                throw ApiException(code, response.code)
            }
            json.decodeFromString<T>(text)
        }
    }
}
