package dev.flashblaze.unramble

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test

class TasksApiTest {
    private val server = MockWebServer()

    @Before
    fun start() = server.start()

    @After
    fun stop() = server.close()

    /** Regression: failures were matched by title, so retrying re-created a same-titled task that had succeeded. */
    @Test
    fun retryKeepsOnlyFailedPositions() = runTest {
        server.enqueue(
            MockResponse.Builder()
                .body("""{"created":[{"title":"Call mom","id":"a"}],"failed":[{"index":1,"title":"Call mom","error":"ticktick_failed"}]}""")
                .build(),
        )
        val sent = listOf(Task("Call mom"), Task("Call mom", due = "2026-11-20"))
        val result = TasksApi(server.url("/").toString(), "token").createTasks("UTC", sent)
        assertEquals(listOf(Task("Call mom", due = "2026-11-20")), result.failedOf(sent))
    }

    /** Regression: priority 0 (the default) was omitted and the Worker rejected the body with bad_request. */
    @Test
    fun createTasksSendsPriorityAndOmitsNulls() = runTest {
        server.enqueue(MockResponse.Builder().body("""{"created":[{"title":"Buy milk","id":"a"}],"failed":[]}""").build())
        val api = TasksApi(server.url("/").toString(), "token")

        api.createTasks("Asia/Kolkata", listOf(Task("Buy milk"), Task("Call mom", due = "2026-11-18T18:00", priority = 5)))

        val request = server.takeRequest()
        assertEquals("/tasks", request.url.encodedPath)
        assertEquals("Bearer token", request.headers["Authorization"])
        val body = Json.parseToJsonElement(request.body!!.utf8()).jsonObject
        // The Worker accepts an absent dictationId but rejects null (bad_request), like priority before.
        assertFalse("null dictationId must be omitted", "dictationId" in body)
        val tasks = body["tasks"]!!.jsonArray.map { it as JsonObject }
        assertEquals("0", tasks[0]["priority"].toString())
        assertFalse("null due must be omitted, not sent as null", "due" in tasks[0])
        assertFalse("null notes must be omitted, not sent as null", "notes" in tasks[0])
        assertEquals("\"2026-11-18T18:00\"", tasks[1]["due"].toString())
    }

    @Test
    fun errorBodyBecomesApiExceptionCode() = runTest {
        server.enqueue(MockResponse.Builder().code(422).body("""{"error":"no_speech"}""").build())
        val api = TasksApi(server.url("/").toString(), "token")
        val error = runCatching { api.createTasks("UTC", listOf(Task("x"))) }.exceptionOrNull() as ApiException
        assertEquals("no_speech", error.code)
        assertEquals(422, error.status)
    }
}
